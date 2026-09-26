import { isAbsolute, relative, resolve } from 'node:path';
import { headTail } from './context.ts';
import { askedFor, callTypeSafe, cut, type Finding, ignoredPath, latestUserMessages, listed, logOnce, noulIsSure, noulScore, type Question, reader, type ReviewDeps, userAsked, withoutComments } from './jev.ts';
import { indexFromDisk, type SourceFile } from './project.ts';
import { changesFrom, type Definition, definitionsIn, isDefinitionFile } from './subjects.ts';

// Notes, never blocks. Candidates are the closest word matches, so a better one can be missed.
const MAX_NEW_DEFINITIONS = 5;
const MAX_CANDIDATES = 3;
const MAX_NEW_CODE_CHARS = 1500;
const MAX_CANDIDATE_CHARS = 1000;
const MIN_SHARED_WORDS = 3;
const MIN_OVERLAP = 0.2;
// This much shared body with a removed function means a move.
const MOVED_OVERLAP = 0.5;
const REUSE_RULE = 'Duplicate code: It repeats what existing code already does.';
const REUSE_CRITERIA = {
  true: 'The existing function already does what the new one does, for the same kind of input, so the new code could call it, or call it with a small extra parameter, instead of repeating its logic.',
  false: 'They do different jobs or work on different data, or only share names, types, or a common pattern such as a loop or a map. A new function that calls the existing one is not a copy.',
};
const STOP_WORDS = new Set([
  'function', 'const', 'let', 'var', 'return', 'async', 'await', 'export', 'default', 'import', 'from', 'new', 'this', 'self', 'class',
  'def', 'func', 'pub', 'mut', 'impl', 'struct', 'type', 'interface', 'fun', 'val', 'suspend', 'override', 'static', 'public', 'private', 'protected',
  'string', 'number', 'boolean', 'void', 'null', 'undefined', 'true', 'false', 'none', 'nil', 'int', 'str', 'bool', 'err', 'else', 'elif', 'for',
  'while', 'break', 'continue', 'try', 'catch', 'finally', 'throw', 'raise', 'yield', 'pass', 'the', 'and', 'not', 'any', 'unknown', 'promise',
]);

interface Words {
  name: Set<string>;
  code: Set<string>;
}

interface Found extends Definition {
  path: string;
  words: Words;
}

export interface ReuseRequest {
  state: {
    purpose: string;
    user_messages?: string[];
    new_code: { path: string; name: string; code: string }[];
    existing: { path: string; line: number; name: string; code: string }[];
  };
  questions: Record<string, Question>;
}

export interface ReusePrep {
  state: ReuseRequest['state'];
  questions: Record<string, Question>;
  finish: (answers: Record<string, unknown> | undefined) => string | undefined;
}

// Reads disk before the first await. Call without awaiting first. No network.
export async function prepareReuse(tool: string, args: unknown, deps: ReviewDeps): Promise<ReusePrep | undefined> {
  const disk = deps.disk;
  if (!disk) return;
  const read = reader(disk);
  const full = (path: string) => (isAbsolute(path) ? resolve(path) : resolve(disk.root, path));
  const changed = new Set<string>();
  const before: SourceFile[] = [];
  const added: Found[] = [];
  const removed: Found[] = [];
  for (const change of changesFrom(tool, args, read)) {
    if (!isDefinitionFile(change.path) || ignoredPath(change.path)) continue;
    const path = full(change.path);
    changed.add(path);
    const onDisk = read(change.path);
    if (onDisk !== undefined) before.push({ path, text: onDisk });
    // A name already in the old text or on disk is a change, not a new function.
    const previous = definitionsIn(change.old ?? '', change.path);
    const known = new Set(previous.map(item => item.name));
    for (const item of definitionsIn(onDisk ?? '', change.path)) known.add(item.name);
    const created = definitionsIn(change.new, change.path);
    const kept = new Set(created.map(item => item.name));
    for (const item of created) if (!known.has(item.name)) added.push({ ...item, path, words: wordsOf(item, path) });
    for (const item of previous) if (!kept.has(item.name)) removed.push({ ...item, path, words: wordsOf(item, path) });
  }
  const removedNames = new Set(removed.map(item => item.name));
  const fresh: Found[] = [];
  for (const item of added) {
    const moved = removedNames.has(item.name) || removed.some(old => jaccard(bodyWords(item), bodyWords(old)) >= MOVED_OVERLAP);
    if (!moved) fresh.push(item);
  }
  if (fresh.length === 0) return;
  const settings = deps.load();
  if (settings.error || settings.key.trim() === '') return;

  // Let the tool start; changed files were read above and are skipped below.
  await new Promise(resolve => setTimeout(resolve, 0));
  const project = deps.project ?? indexFromDisk(disk);
  const indexed = await project.sourceFiles(changed).catch(() => undefined);
  if (!indexed) return;
  const pool: Found[] = [];
  for (const file of [...before, ...indexed]) {
    for (const item of definitionsIn(file.text, file.path)) {
      // Code this call removes is not there to reuse.
      if (changed.has(file.path) && removedNames.has(item.name)) continue;
      pool.push({ ...item, path: file.path, words: wordsOf(item, file.path) });
    }
  }
  const existing: Found[] = [];
  const asked: { item: Found; matches: number[] }[] = [];
  for (const item of fresh.slice(0, MAX_NEW_DEFINITIONS)) {
    const ranked: { candidate: Found; score: number }[] = [];
    for (const candidate of pool) {
      const score = overlap(item.words, candidate.words);
      const shared = sharedCount(item.words.code, candidate.words.code);
      if (score < MIN_OVERLAP || shared < MIN_SHARED_WORDS) continue;
      ranked.push({ candidate, score });
    }
    ranked.sort((a, b) => b.score - a.score);
    const matches: number[] = [];
    for (const { candidate } of ranked.slice(0, MAX_CANDIDATES)) {
      let index = existing.indexOf(candidate);
      if (index === -1) {
        index = existing.length;
        existing.push(candidate);
      }
      matches.push(index);
    }
    if (matches.length > 0) asked.push({ item, matches });
  }
  if (asked.length === 0) return;

  const once = logOnce(deps);
  const userMessages = latestUserMessages(deps.userMessages ?? []);
  const show = (path: string) => relative(disk.root, path) || path;
  const questions: Record<string, Question> = {};
  for (const [n, { matches }] of asked.entries()) {
    for (const m of matches) {
      questions[`r${n}_x${m}_duplicates`] = {
        type: 'noul',
        instructions: `Does the new function in \`new_code[${n}]\` do the same job as the existing function in \`existing[${m}]\`, so the existing one should be reused instead?`,
        criteria: REUSE_CRITERIA,
      };
    }
    if (userMessages.length > 0) {
      questions[`r${n}_user_asked`] = userAsked(`a separate function in \`new_code[${n}]\` instead of reusing existing code`, 'The user asks for a separate implementation, or tells the agent not to use or change the existing code.');
    }
  }
  const request: ReuseRequest = {
    state: {
      purpose: 'Decide whether each new function in `new_code` repeats an existing function in `existing` that it should reuse. `existing` holds the closest matches found in the project by shared words. They may all be unrelated. Comments were removed from both.',
      ...(userMessages.length > 0 ? { user_messages: userMessages } : {}),
      new_code: asked.map(({ item }) => ({ path: show(item.path), name: item.name, code: headTail(withoutComments(item.code, item.path), MAX_NEW_CODE_CHARS).text })),
      existing: existing.map(item => ({ path: show(item.path), line: item.line, name: item.name, code: headTail(withoutComments(item.code, item.path), MAX_CANDIDATE_CHARS).text })),
    },
    questions,
  };
  return {
    state: request.state,
    questions: request.questions,
    finish: answers => finishReuse(asked, existing, show, once, answers),
  };
}

export async function checkReuse(tool: string, args: unknown, deps: ReviewDeps): Promise<string | undefined> {
  const prep = await prepareReuse(tool, args, deps);
  if (!prep) return;
  const settings = deps.load();
  if (settings.error || settings.key.trim() === '') return;
  const answers = await callTypeSafe(logOnce(deps), settings, { state: prep.state, questions: prep.questions }, 'No reuse note was added.');
  return prep.finish(answers);
}

function finishReuse(asked: { item: Found; matches: number[] }[], existing: Found[], show: (path: string) => string, once: ReviewDeps, answers: Record<string, unknown> | undefined): string | undefined {
  if (!answers) return;
  const findings: Finding[] = [];
  for (const [n, { item, matches }] of asked.entries()) {
    let best: Found | undefined;
    let bestScore = 0;
    for (const m of matches) {
      const answer = answers[`r${n}_x${m}_duplicates`];
      const score = noulScore(answer) ?? 0;
      if (noulIsSure(answer) && score > bestScore) {
        best = existing[m];
        bestScore = score;
      }
    }
    if (!best) continue;
    if (askedFor(answers, `r${n}`, once, `${show(item.path)}: the user asked for a separate ${item.name}. No reuse note was added.`)) continue;
    findings.push({
      kind: 'reuse',
      key: `${item.path}\n${item.name}`,
      path: show(item.path),
      test: `function "${item.name}"`,
      block: false,
      fails: [REUSE_RULE],
      evidence: [`  existing: ${show(best.path)}:${best.line} ${cut(best.code.split('\n')[0]?.trim() ?? '')}`, `  new: ${cut(item.code.split('\n')[0]?.trim() ?? '')}`],
      next: `Reuse ${best.name} from ${show(best.path)} instead of a new copy. If the new one must differ, keep it or ask the user.`,
    });
  }
  if (findings.length === 0) return;
  return [
    'Jevy note: this change was made, but it may repeat code that already exists.',
    ...listed(findings, item => item.next),
    'Check it, and fix it if the note is right.',
  ].join('\n');
}

function wordSet(text: string): Set<string> {
  const out = new Set<string>();
  for (const identifier of text.match(/[A-Za-z_$][\w$]*/g) ?? []) {
    for (const part of identifier.replace(/([a-z0-9])([A-Z])/g, '$1 $2').split(/[\s_$]+/)) {
      const word = part.toLowerCase();
      if (word.length >= 3 && !STOP_WORDS.has(word)) out.add(word);
    }
  }
  return out;
}

function wordsOf(item: Definition, path: string): Words {
  return { name: wordSet(item.name), code: wordSet(withoutComments(item.code, path)) };
}

// After the first line, so a renamed copy still matches.
function bodyWords(item: Found): Set<string> {
  return wordSet(withoutComments(item.code, item.path).split('\n').slice(1).join('\n'));
}

function sharedCount(a: Set<string>, b: Set<string>): number {
  let shared = 0;
  for (const word of a) if (b.has(word)) shared += 1;
  return shared;
}

function jaccard(a: Set<string>, b: Set<string>): number {
  const shared = sharedCount(a, b);
  const all = a.size + b.size - shared;
  return all === 0 ? 0 : shared / all;
}

// Name words count twice, so a shared name outranks a shared loop.
function overlap(a: Words, b: Words): number {
  const names = sharedCount(a.name, b.name);
  const codes = sharedCount(a.code, b.code);
  const nameTotal = a.name.size + b.name.size - names;
  const codeTotal = a.code.size + b.code.size - codes;
  const total = 2 * nameTotal + codeTotal;
  if (total === 0) return 0;
  return (2 * names + codes) / total;
}
