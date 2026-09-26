import { isAbsolute, relative, resolve, sep } from 'node:path';
import { type Disk, headTail } from './context.ts';
import { type ProjectIndex } from './project.ts';
import { type Settings } from './settings.ts';
import { type Change, stripComments } from './subjects.ts';

// Jev allows 32k tokens for state plus the longest question, and 64k for state plus all questions.
// A token is at least 3 characters of code, so these stay well inside both.
export const MAX_QUESTIONS = 100;
export const MAX_EDIT_SIDE_CHARS = 6000;
const GATE_CONTEXT_LINES = 5;
export const MAX_LISTED = 5;
const UNSURE = 0.5;
const SURE = 0.8;

export interface ReviewDeps {
  load: () => Settings;
  fetch: (url: string, init: RequestInit) => Promise<Response>;
  log?: (message: string) => void;
  // Where to read the code under test. Without it, only the new text is sent.
  disk?: Disk;
  // The shared project listing for retrieval. Without it, one is built from disk per call.
  project?: ProjectIndex;
  // The user's latest messages in this session, oldest first. Empty when unknown.
  userMessages?: string[];
  // Earlier blocks, so the user can allow one and a retry loop is noticed.
  history?: History;
  // Receives a note for tests and checks Jev is unsure about. The plugin adds it to the tool output.
  warn?: (note: string) => void;
}

// What the plugin remembers for the session the user talks to. A subagent shares its parent's.
export interface History {
  // By file and test. Deleted when that test passes or the user allows it.
  blocks: Map<string, Block>;
  // The user's latest real messages, oldest first, and how many there have been in all.
  messages: string[];
  messageCount: number;
  // The last command that failed, so Jev can see what a change to a check may hide.
  lastFailure?: Failure;
}

export interface Failure {
  command: string;
  // Head and tail of what it printed.
  output: string;
}

export interface Block {
  // The part of the block message for this test, shown to Jev when the user may have allowed it.
  message: string;
  // Blocks in a row for this test.
  count: number;
  // messageCount when it was blocked. Only later messages can allow it.
  atMessage: number;
}

export interface Finding {
  kind: 'write' | 'edit' | 'gate' | 'command' | 'reuse' | 'special' | 'claim' | 'hidden' | 'stale';
  key: string;
  path: string;
  test: string;
  block: boolean;
  fails: string[];
  evidence: string[];
  next: string;
}

export type Question = { type: 'noul'; instructions: string; criteria: { true: string; false: string } } |
  { type: 'choice'; instructions: string; criteria: Record<string, string> };

export function userAsked(change: string, asks: string): Question {
  return {
    type: 'noul',
    instructions: `Do the user's messages in \`user_messages\` ask for ${change}?`,
    criteria: {
      true: asks,
      false: 'The user does not ask for it. Asking to fix a failure or to make the tests pass does not count.',
    },
  };
}

// Several requests can fail the same way. Log each message once.
export function logOnce(deps: ReviewDeps): ReviewDeps {
  const logged = new Set<string>();
  return {
    ...deps,
    log: message => {
      if (logged.has(message)) return;
      logged.add(message);
      deps.log?.(message);
    },
  };
}

export function reader(disk: Disk | undefined): (path: string) => string | undefined {
  return path => {
    if (!disk) return;
    return disk.read(isAbsolute(path) ? resolve(path) : resolve(disk.root, path));
  };
}

export async function callTypeSafe(
  deps: ReviewDeps,
  settings: Settings,
  batch: { state: { purpose: string }; questions: Record<string, Question> },
  allowed: string,
): Promise<Record<string, unknown> | undefined> {
  const key = settings.key.trim();
  const base = (settings.baseUrl.trim() || 'https://api.typesafe.ai').replace(/\/+$/, '');
  const allow = (message: string): undefined => {
    deps.log?.(message);
    return;
  };

  let response: Response;
  try {
    response = await deps.fetch(`${base}/v1/systemone`, {
      method: 'POST',
      redirect: 'error',
      signal: AbortSignal.timeout(20_000),
      headers: {
        Authorization: `Bearer ${key}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'jev-latest',
        state: batch.state,
        questions: batch.questions,
      }),
    });
  } catch {
    return allow(`TypeSafe request failed. ${allowed}`);
  }
  if (!response.ok) return allow(`TypeSafe returned ${response.status}. ${allowed}`);

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return allow(`TypeSafe returned an unreadable response. ${allowed}`);
  }
  if (!isRecord(body) || !isRecord(body.answers)) {
    return allow(`TypeSafe returned no answers. ${allowed}`);
  }
  return body.answers;
}

// 0.5 or higher on the user-intent question allows it, before any block.
export function askedFor(answers: Record<string, unknown>, id: string, deps: ReviewDeps, message: string): boolean {
  const asked = noulScore(answers[`${id}_user_asked`]);
  if (asked === undefined || asked < 0.5) return false;
  deps.log?.(message);
  return true;
}

export function findingLines(finding: Finding, next = finding.next): string[] {
  return [`- ${finding.path}, ${finding.test}`, ...finding.fails.map(fail => `  ${fail}`), ...finding.evidence, `  next: ${next}`];
}

export function listed(findings: Finding[], next: (finding: Finding) => string): string[] {
  const lines = findings.slice(0, MAX_LISTED).flatMap(finding => findingLines(finding, next(finding)));
  if (findings.length > MAX_LISTED) lines.push(`- and ${findings.length - MAX_LISTED} more`);
  return lines;
}

export function oneLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

export function cut(line: string): string {
  return line.length > 200 ? `${line.slice(0, 197)}...` : line;
}

function scoreIsSure(score: unknown, confidence: unknown): boolean {
  if (typeof score !== 'number' || score < SURE) return false;
  return typeof confidence !== 'number' || confidence >= SURE;
}

// Sure blocks. From 0.5 up to sure, or sure with low confidence, only adds a note.
export type Level = 'block' | 'warn' | undefined;

function levelOf(score: unknown, confidence: unknown): Level {
  if (scoreIsSure(score, confidence)) return 'block';
  return typeof score === 'number' && score >= UNSURE ? 'warn' : undefined;
}

// For a choice, the score is the probability of the chosen option.
export function choiceLevel(value: Record<string, unknown>): Level {
  const probabilities = value.probabilities;
  if (!isRecord(probabilities) || typeof value.choice !== 'string') return;
  return levelOf(probabilities[value.choice], value.confidence);
}

export function noulLevel(value: unknown): Level {
  return levelOf(noulScore(value), isRecord(value) ? value.confidence : undefined);
}

export function noulScore(value: unknown): number | undefined {
  return isRecord(value) && typeof value.noul === 'number' ? value.noul : undefined;
}

export function noulIsSure(value: unknown): boolean {
  return scoreIsSure(noulScore(value), isRecord(value) ? value.confidence : undefined);
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// Comments are stripped only where the syntax is known. Prose like "don't" is not a quote.
const CODE_FILE = /\.(?:[cm]?[jt]sx?|py|go|rs|java|kt|swift|cs|c|cc|cpp|h|hpp|scala|dart)$/;

export function withoutComments(text: string, path: string): string {
  return CODE_FILE.test(path) ? stripComments(text, path) : text;
}

// jevy-vet's own config and installed packages are never checked.
export function ignoredPath(path: string): boolean {
  return /(?:^|[\\/])node_modules[\\/]/.test(path) || /(?:^|[\\/])jevy-vet\.jsonc?$/.test(path);
}

// A long file sends only the lines that differ and a few around them, so the change is not cut out of the middle.
export function sides(change: { old?: string; new: string }): { old?: string; new: string } {
  if (change.old === undefined) return { new: headTail(change.new, MAX_EDIT_SIDE_CHARS).text };
  if (change.old.length <= MAX_EDIT_SIDE_CHARS && change.new.length <= MAX_EDIT_SIDE_CHARS) return { old: change.old, new: change.new };
  const before = change.old.split('\n');
  const after = change.new.split('\n');
  let samePrefix = 0;
  while (samePrefix < before.length && samePrefix < after.length && before[samePrefix] === after[samePrefix]) samePrefix += 1;
  let sameSuffix = 0;
  while (sameSuffix < before.length - samePrefix && sameSuffix < after.length - samePrefix && before[before.length - 1 - sameSuffix] === after[after.length - 1 - sameSuffix]) sameSuffix += 1;
  const from = Math.max(0, samePrefix - GATE_CONTEXT_LINES);
  const keep = Math.max(0, sameSuffix - GATE_CONTEXT_LINES);
  return {
    old: headTail(before.slice(from, before.length - keep).join('\n'), MAX_EDIT_SIDE_CHARS).text,
    new: headTail(after.slice(from, after.length - keep).join('\n'), MAX_EDIT_SIDE_CHARS).text,
  };
}

export function shownPath(root: string, path: string): string {
  return relative(root, resolve(root, path)).split(sep).join('/');
}

// A patch with several hunks in one file cannot be placed, so it has no line numbers.
export function afterChange(change: Change, onDisk: string | undefined): string | undefined {
  if (change.old === undefined || change.old === '') return change.new;
  if (onDisk?.includes(change.old)) return onDisk.replace(change.old, () => change.new);
  return;
}
