import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { checkClaims, type Step } from '../src/claims.ts';
import { type Disk, type InstructionFile } from '../src/context.ts';
import { checkHiddenErrors } from '../src/hidden.ts';
import { checkInstructions } from '../src/instructions.ts';
import { type Block, type Failure, type History, isRecord, type ReviewDeps } from '../src/jev.ts';
import { checkReuse } from '../src/reuse.ts';
import { review } from '../src/review.ts';
import { loadSettings, type Settings } from '../src/settings.ts';
import { checkStaleDocs } from '../src/stale.ts';

// A fixed root so every case sees the same disk layout. Not a real folder.
const ROOT = '/eval';
const CHECKS = new Set(['review', 'instructions', 'reuse', 'hidden', 'stale', 'claims']);
const SURE = 0.8;
const UNSURE = 0.5;
const CHARS_PER_TOKEN = 3.5;
const LIVE_BACKOFF_MS = 1000;
const NO_KEY = 'No TypeSafe key. Live eval did not start.';

export interface EvalHistory {
  blocks: { key: string; message: string; count: number; atMessage: number }[];
  messages: string[];
  messageCount: number;
  lastFailure?: Failure;
}

export interface EvalInput {
  tool?: string;
  args?: unknown;
  files?: Record<string, string>;
  userMessages?: string[];
  history?: EvalHistory;
  lastFailure?: Failure;
  instructionFiles?: InstructionFile[];
  // Dry mode answers empty, so the rule request runs only when these sentences are already rules.
  knownRules?: string[];
  message?: string;
  steps?: Step[];
}

export interface EvalCase {
  id: string;
  check: string;
  input: EvalInput;
  expect: Record<string, boolean | string>;
  source: string;
  note?: string;
}

export interface ResultRow {
  id: string;
  check: string;
  question: string;
  expected: boolean | string;
  answer: Record<string, unknown>;
  model?: string;
  usage?: Record<string, unknown>;
  latencyMs: number;
  requestChars: number;
}

export interface CutoffCounts {
  n: number;
  positives: number;
  negatives: number;
  sure: number;
  unsure: number;
  auroc?: number;
}

export interface KindSummary extends CutoffCounts {
  kind: string;
  options?: ({ option: string } & CutoffCounts)[];
}

export interface RunReport {
  failures: string[];
  requests: number;
  questions: number;
  characters: number;
  rows: ResultRow[];
  notes: string[];
  capped: boolean;
}

export interface RunOptions {
  live?: boolean;
  model?: string;
  maxRequests?: number;
  load?: () => Settings;
  fetch?: ReviewDeps['fetch'];
  // The live refusal test passes this to prove the key is never logged. Nothing calls it.
  log?: (message: string) => void;
}

interface RequestLimit {
  sent: number;
  max: number;
  chain: Promise<void>;
}

interface Capture {
  ids: string[];
  chars: number;
  answers: Record<string, unknown>;
  model?: string;
  usage?: Record<string, unknown>;
  latencyMs: number;
}

interface CaptureState {
  settings: Settings;
  options: RunOptions;
  limit: RequestLimit;
  report: RunReport;
  captured: Capture[];
}

export function questionKind(id: string): string {
  const stripped = id.replace(/^(?:[a-z]+\d+_)+/, '');
  return stripped === id ? id : `_${stripped}`;
}

export function loadCases(text: string): EvalCase[] {
  const cases: EvalCase[] = [];
  for (const [i, line] of text.split('\n').entries()) {
    if (line.trim() === '') continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      throw new Error(`Line ${i + 1} is not JSON.`);
    }
    cases.push(caseFrom(parsed, i + 1));
  }
  return cases;
}

export function summarize(rows: ResultRow[]): KindSummary[] {
  const groups = new Map<string, ResultRow[]>();
  for (const row of rows) {
    const kind = questionKind(row.question);
    const group = groups.get(kind) ?? [];
    group.push(row);
    groups.set(kind, group);
  }
  const kinds: KindSummary[] = [];
  for (const [kind, group] of groups) {
    const choice = group.some(row => typeof row.expected === 'string' || typeof row.answer.choice === 'string');
    if (!choice) {
      kinds.push({ kind, ...noulCounts(group) });
      continue;
    }
    const positives = new Map<string, number>();
    for (const row of group) {
      if (typeof row.expected !== 'string') continue;
      positives.set(row.expected, (positives.get(row.expected) ?? 0) + 1);
    }
    const listed: ({ option: string } & CutoffCounts)[] = [];
    for (const [option, count] of positives) listed.push({ option, ...choiceCounts(group, option, count) });
    kinds.push({ kind, n: group.length, positives: 0, negatives: 0, sure: 0, unsure: 0, options: listed });
  }
  return kinds;
}

export function renderSummary(report: RunReport, live: boolean): string {
  const kinds = summarize(report.rows);
  const lines = [
    '# Eval summary',
    '',
    live ? 'Live run. Scores are what TypeSafe returned.' : 'Dry run. No scores. The totals below are the live-run size.',
    '',
    `Requests: ${report.requests}`,
    `Questions: ${report.questions}`,
    `Characters: ${report.characters}`,
    `Estimated tokens: ${estimatedTokens(report.characters)}`,
    '',
    '## Labels',
    '',
  ];
  if (!live) {
    lines.push('Cutoff counts and ranking need a live run.');
    lines.push('');
  }
  for (const kind of kinds) {
    lines.push(`### ${kind.kind}`, '', countsLine(kind));
    for (const option of kind.options ?? []) lines.push(`- ${option.option}: ${countsLine(option)}`);
    lines.push('');
  }
  lines.push('## Notes', '');
  if (report.notes.length === 0) lines.push('No case notes.');
  else for (const note of report.notes) lines.push(`- ${note}`);
  if (report.capped) lines.push('', 'The request cap stopped the run before every case was sent.');
  lines.push('');
  return lines.join('\n');
}

export async function runCases(cases: EvalCase[], options: RunOptions = {}): Promise<RunReport> {
  const live = options.live === true;
  const settings = live ? liveSettings(options.load ?? loadSettings) : drySettings();
  const report: RunReport = { failures: [], requests: 0, questions: 0, characters: 0, rows: [], notes: [], capped: false };
  const limit: RequestLimit = { sent: 0, max: options.maxRequests ?? 150, chain: Promise.resolve() };
  for (const item of cases) {
    if (item.note) report.notes.push(`${item.id}: ${item.note}`);
    if (live && limit.sent >= limit.max) {
      report.capped = true;
      break;
    }
    const state: CaptureState = { settings, options, limit, report, captured: [] };
    await runOne(item, state);
    for (const hit of state.captured) {
      report.requests += 1;
      report.questions += hit.ids.length;
      report.characters += hit.chars;
    }
    recordExpect(item, state.captured, live, report);
  }
  return report;
}

function recordExpect(item: EvalCase, captured: Capture[], live: boolean, report: RunReport): void {
  const asked = captured.flatMap(entry => entry.ids);
  for (const [question, expected] of Object.entries(item.expect)) {
    const hit = captured.find(entry => entry.ids.includes(question));
    if (!hit) {
      if (!live) report.failures.push(`${item.id}: expected ${question} was not asked. Asked: ${asked.join(', ') || '(none)'}`);
      continue;
    }
    const answer = hit.answers[question];
    if (!live || !isRecord(answer)) continue;
    report.rows.push({
      id: item.id,
      check: item.check,
      question,
      expected,
      answer,
      ...(hit.model ? { model: hit.model } : {}),
      ...(hit.usage ? { usage: hit.usage } : {}),
      latencyMs: hit.latencyMs,
      requestChars: hit.chars,
    });
  }
}

export function formatReport(report: RunReport): string {
  const lines = [
    `requests: ${report.requests}`,
    `questions: ${report.questions}`,
    `characters: ${report.characters}`,
    `estimated tokens: ${estimatedTokens(report.characters)}`,
  ];
  if (report.failures.length === 0) lines.push('expected questions: all asked');
  else lines.push(...report.failures);
  return lines.join('\n');
}

function drySettings(): Settings {
  return { key: 'dry', baseUrl: 'https://api.typesafe.ai', path: '/eval/jevy-vet.jsonc' };
}

// A missing or unreadable key stops the run. The message never includes the key.
function liveSettings(load: () => Settings): Settings {
  let settings: Settings;
  try {
    settings = load();
  } catch {
    throw new Error(NO_KEY);
  }
  if (settings.error || settings.key.trim() === '') throw new Error(NO_KEY);
  return settings;
}

async function runOne(item: EvalCase, state: CaptureState): Promise<void> {
  const deps: ReviewDeps & { lastFailure?: Failure } = {
    load: () => state.settings,
    disk: memoryDisk(item.input.files ?? {}),
    userMessages: item.input.userMessages,
    history: historyFrom(item.input.history),
    lastFailure: item.input.lastFailure,
    fetch: (_url, init) => capture(init, state),
  };
  await callCheck(item, deps);
}

async function callCheck(item: EvalCase, deps: ReviewDeps & { lastFailure?: Failure }): Promise<void> {
  const tool = item.input.tool ?? '';
  const args = item.input.args;
  if (item.check === 'review') {
    await review(tool, args, deps);
    return;
  }
  if (item.check === 'reuse') {
    await checkReuse(tool, args, deps);
    return;
  }
  if (item.check === 'hidden') {
    await checkHiddenErrors(tool, args, deps);
    return;
  }
  if (item.check === 'stale') {
    await checkStaleDocs(tool, args, deps);
    return;
  }
  if (item.check === 'instructions') {
    const cache = new Map<string, boolean>();
    for (const rule of item.input.knownRules ?? []) {
      cache.set(`file\n${rule}`, true);
      cache.set(`user\n${rule}`, true);
    }
    await checkInstructions(tool, args, {
      ...deps,
      instructionFiles: () => item.input.instructionFiles ?? [],
      cache,
    });
    return;
  }
  await checkClaims(item.input.message ?? '', { ...deps, steps: item.input.steps ?? [] });
}

function capture(init: RequestInit | undefined, state: CaptureState): Promise<Response> {
  const text = String(init?.body ?? '');
  const body = JSON.parse(text) as { questions?: Record<string, unknown> };
  const ids = Object.keys(body.questions ?? {});
  if (state.options.live !== true) {
    state.captured.push({ ids, chars: text.length, answers: {}, latencyMs: 0 });
    return Promise.resolve(jsonResponse({ answers: {} }));
  }
  // One at a time, so a 429 can back off before the next request.
  return enqueue(state.limit, () => sendLive(state, body, ids));
}

async function sendLive(state: CaptureState, body: { questions?: Record<string, unknown> }, ids: string[]): Promise<Response> {
  if (state.limit.sent >= state.limit.max) {
    state.report.capped = true;
    return jsonResponse({ answers: {} });
  }
  state.limit.sent += 1;
  const payload = state.options.model ? { ...body, model: state.options.model } : body;
  const sent = JSON.stringify(payload);
  const started = Date.now();
  const response = await liveSend(state.settings, sent, state.options.fetch ?? fetch);
  const latencyMs = Date.now() - started;
  let parsed: unknown;
  try {
    parsed = await response.json();
  } catch {
    parsed = {};
  }
  const answers = isRecord(parsed) && isRecord(parsed.answers) ? parsed.answers : {};
  const model = isRecord(parsed) && typeof parsed.model === 'string' ? parsed.model : undefined;
  const usage = isRecord(parsed) && isRecord(parsed.usage) ? parsed.usage : undefined;
  state.captured.push({ ids, chars: sent.length, answers, latencyMs, ...(model ? { model } : {}), ...(usage ? { usage } : {}) });
  return jsonResponse({ answers });
}

function enqueue(limit: RequestLimit, send: () => Promise<Response>): Promise<Response> {
  const run = limit.chain.then(send, send);
  limit.chain = run.then(() => undefined, () => undefined);
  return run;
}

async function liveSend(settings: Settings, body: string, fetchImpl: ReviewDeps['fetch']): Promise<Response> {
  const base = (settings.baseUrl.trim() || 'https://api.typesafe.ai').replace(/\/+$/, '');
  const send = () => fetchImpl(`${base}/v1/systemone`, {
    method: 'POST',
    redirect: 'error',
    headers: {
      Authorization: `Bearer ${settings.key}`,
      'Content-Type': 'application/json',
    },
    body,
  });
  let response = await send();
  if (response.status === 429) {
    await new Promise(resolve => setTimeout(resolve, LIVE_BACKOFF_MS));
    response = await send();
  }
  return response;
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
}

function memoryDisk(files: Record<string, string>): Disk {
  const keyOf = (path: string) => {
    const full = isAbsolute(path) ? resolve(path) : resolve(ROOT, path);
    const out = relative(ROOT, full);
    if (out.startsWith('..') || isAbsolute(out)) return;
    return out.split(sep).join('/');
  };
  return {
    root: ROOT,
    read(path) {
      const key = keyOf(path);
      if (key === undefined) return;
      return files[key];
    },
    list(dir) {
      const key = keyOf(dir);
      if (key === undefined) return [];
      const prefix = key === '' ? '' : `${key}/`;
      const names = new Set<string>();
      for (const path of Object.keys(files)) {
        if (prefix !== '' && !path.startsWith(prefix)) continue;
        const rest = prefix === '' ? path : path.slice(prefix.length);
        const name = rest.split('/')[0] ?? '';
        if (name !== '') names.add(name);
      }
      return [...names].sort();
    },
  };
}

function historyFrom(input: EvalHistory | undefined): History | undefined {
  if (!input) return;
  const blocks = new Map<string, Block>();
  for (const block of input.blocks) {
    blocks.set(block.key, { message: block.message, count: block.count, atMessage: block.atMessage });
  }
  return {
    blocks,
    messages: input.messages,
    messageCount: input.messageCount,
    ...(input.lastFailure ? { lastFailure: input.lastFailure } : {}),
  };
}

function caseFrom(value: unknown, line: number): EvalCase {
  if (!isRecord(value)) throw new Error(`Line ${line} is not an object.`);
  const id = stringField(value, 'id', line);
  const check = stringField(value, 'check', line);
  if (!CHECKS.has(check)) throw new Error(`Line ${line} has an unknown check.`);
  if (!isRecord(value.input)) throw new Error(`Line ${line} is missing input.`);
  if (!isRecord(value.expect)) throw new Error(`Line ${line} is missing expect.`);
  const expect: Record<string, boolean | string> = {};
  for (const [key, item] of Object.entries(value.expect)) {
    if (typeof item !== 'boolean' && typeof item !== 'string') throw new Error(`Line ${line} has a bad expect value for ${key}.`);
    if (item === '') throw new Error(`Line ${line} has an empty expect value for ${key}.`);
    expect[key] = item;
  }
  const source = stringField(value, 'source', line);
  const note = value.note === undefined ? undefined : stringField(value, 'note', line);
  const input = inputFrom(value.input, line);
  return { id, check, input, expect, source, ...(note ? { note } : {}) };
}

function inputFrom(value: Record<string, unknown>, line: number): EvalInput {
  const input: EvalInput = {};
  if (value.tool !== undefined) input.tool = stringField(value, 'tool', line);
  if (value.args !== undefined) input.args = value.args;
  if (value.files !== undefined) {
    if (!isRecord(value.files)) throw new Error(`Line ${line} has a bad files map.`);
    const files: Record<string, string> = {};
    for (const [path, text] of Object.entries(value.files)) {
      if (typeof text !== 'string') throw new Error(`Line ${line} has a non-text file.`);
      files[path] = text;
    }
    input.files = files;
  }
  if (value.userMessages !== undefined) input.userMessages = stringList(value.userMessages, line, 'userMessages');
  if (value.knownRules !== undefined) input.knownRules = stringList(value.knownRules, line, 'knownRules');
  if (value.message !== undefined) input.message = stringField(value, 'message', line);
  if (value.history !== undefined) input.history = historyField(value.history, line);
  if (value.lastFailure !== undefined) input.lastFailure = failureField(value.lastFailure, line);
  if (value.instructionFiles !== undefined) input.instructionFiles = instructionField(value.instructionFiles, line);
  if (value.steps !== undefined) {
    if (!Array.isArray(value.steps)) throw new Error(`Line ${line} has a bad steps list.`);
    input.steps = value.steps as Step[];
  }
  return input;
}

function historyField(value: unknown, line: number): EvalHistory {
  if (!isRecord(value) || !Array.isArray(value.blocks) || !Array.isArray(value.messages) || typeof value.messageCount !== 'number') {
    throw new Error(`Line ${line} has a bad history.`);
  }
  const blocks: EvalHistory['blocks'] = [];
  for (const block of value.blocks) {
    if (!isRecord(block) || typeof block.key !== 'string' || typeof block.message !== 'string' || typeof block.count !== 'number' || typeof block.atMessage !== 'number') {
      throw new Error(`Line ${line} has a bad history block.`);
    }
    blocks.push({ key: block.key, message: block.message, count: block.count, atMessage: block.atMessage });
  }
  return {
    blocks,
    messages: stringList(value.messages, line, 'history.messages'),
    messageCount: value.messageCount,
    ...(value.lastFailure === undefined ? {} : { lastFailure: failureField(value.lastFailure, line) }),
  };
}

function failureField(value: unknown, line: number): Failure {
  if (!isRecord(value) || typeof value.command !== 'string' || typeof value.output !== 'string') throw new Error(`Line ${line} has a bad lastFailure.`);
  return { command: value.command, output: value.output };
}

function instructionField(value: unknown, line: number): InstructionFile[] {
  if (!Array.isArray(value)) throw new Error(`Line ${line} has a bad instructionFiles list.`);
  const files: InstructionFile[] = [];
  for (const file of value) {
    if (!isRecord(file) || typeof file.path !== 'string' || typeof file.text !== 'string') throw new Error(`Line ${line} has a bad instruction file.`);
    files.push({ path: file.path, text: file.text });
  }
  return files;
}

function stringList(value: unknown, line: number, name: string): string[] {
  if (!Array.isArray(value)) throw new Error(`Line ${line} has a bad ${name} list.`);
  const out: string[] = [];
  for (const item of value) {
    if (typeof item !== 'string') throw new Error(`Line ${line} has a bad ${name} list.`);
    out.push(item);
  }
  return out;
}

function stringField(value: Record<string, unknown>, key: string, line: number): string {
  const item = value[key];
  if (typeof item !== 'string' || item.trim() === '') throw new Error(`Line ${line} is missing ${key}.`);
  return item;
}

function noulCounts(rows: ResultRow[]): CutoffCounts {
  const scored: { label: boolean; score: number; confidence?: number }[] = [];
  let positives = 0;
  let negatives = 0;
  for (const row of rows) {
    if (row.expected === true) positives += 1;
    else if (row.expected === false) negatives += 1;
    const score = typeof row.answer.noul === 'number' ? row.answer.noul : undefined;
    if (typeof row.expected !== 'boolean' || score === undefined) continue;
    scored.push({ label: row.expected, score });
  }
  return { n: rows.length, positives, negatives, ...bands(scored), auroc: pairRank(scored) };
}

function choiceCounts(rows: ResultRow[], option: string, positives: number): CutoffCounts {
  const scored: { label: boolean; score: number; confidence?: number }[] = [];
  for (const row of rows) {
    const probabilities = row.answer.probabilities;
    const score = isRecord(probabilities) && typeof probabilities[option] === 'number' ? probabilities[option] : undefined;
    const confidence = typeof row.answer.confidence === 'number' ? row.answer.confidence : undefined;
    if (typeof row.expected !== 'string' || score === undefined) continue;
    scored.push({ label: row.expected === option, score, ...(confidence === undefined ? {} : { confidence }) });
  }
  return { n: rows.length, positives, negatives: rows.length - positives, ...bands(scored), auroc: pairRank(scored) };
}

function bands(scored: { score: number; confidence?: number }[]): { sure: number; unsure: number } {
  let sure = 0;
  let unsure = 0;
  for (const item of scored) {
    const confident = item.confidence === undefined || item.confidence >= SURE;
    if (item.score >= SURE && confident) sure += 1;
    else if (item.score >= UNSURE) unsure += 1;
  }
  return { sure, unsure };
}

// Fraction of positive/negative pairs ranked in the right order. Ties count half.
function pairRank(scored: { label: boolean; score: number }[]): number | undefined {
  const positives = scored.filter(item => item.label).map(item => item.score);
  const negatives = scored.filter(item => !item.label).map(item => item.score);
  if (positives.length === 0 || negatives.length === 0) return;
  let correct = 0;
  for (const positive of positives) {
    for (const negative of negatives) {
      if (positive > negative) correct += 1;
      else if (positive === negative) correct += 0.5;
    }
  }
  return correct / (positives.length * negatives.length);
}

function estimatedTokens(chars: number): number {
  return Math.round(chars / CHARS_PER_TOKEN);
}

function countsLine(counts: CutoffCounts): string {
  const rank = counts.auroc === undefined ? 'n/a' : counts.auroc.toFixed(2);
  return `n=${counts.n} positives=${counts.positives} negatives=${counts.negatives} sure=${counts.sure} unsure=${counts.unsure} auroc=${rank}`;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const dir = join(import.meta.dir, 'cases');
  const names = (await readdir(dir)).filter(name => name.endsWith('.jsonl')).sort();
  const texts = await Promise.all(names.map(name => readFile(join(dir, name), 'utf8')));
  const cases = texts.flatMap(text => loadCases(text));
  const report = await runCases(cases, { live: args.live, maxRequests: args.maxRequests, ...(args.model ? { model: args.model } : {}) });
  console.log(formatReport(report));
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const results = join(import.meta.dir, 'results');
  await mkdir(results, { recursive: true });
  await writeFile(join(results, `summary-${stamp}.md`), renderSummary(report, args.live));
  if (args.live) {
    const body = report.rows.map(row => JSON.stringify(row)).join('\n');
    await writeFile(join(results, `live-${stamp}.jsonl`), body === '' ? '' : `${body}\n`);
  }
  if (report.failures.length > 0) process.exitCode = 1;
}

function parseArgs(argv: string[]): { live: boolean; maxRequests: number; model?: string } {
  let live = false;
  let maxRequests = 150;
  let model: string | undefined;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--live') live = true;
    else if (arg === '--max-requests') {
      maxRequests = Number(argv[i + 1]);
      i += 1;
    } else if (arg === '--model') {
      model = argv[i + 1];
      i += 1;
    }
  }
  if (!Number.isInteger(maxRequests) || maxRequests < 1) throw new Error('--max-requests must be a positive integer.');
  return { live, maxRequests, ...(model ? { model } : {}) };
}

if (import.meta.main) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : 'Eval failed.');
    process.exitCode = 1;
  });
}
