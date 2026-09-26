import { isAbsolute, relative } from 'node:path';
import { headTail, type InstructionFile, sentencesOf } from './context.ts';
import { callTypeSafe, ignoredPath, logOnce, MAX_EDIT_SIDE_CHARS, MAX_QUESTIONS, noulIsSure, noulScore, type Question, reader, type ReviewDeps, withoutComments } from './jev.ts';
import { type Settings } from './settings.ts';
import { type Change, changesFrom } from './subjects.ts';

// The instruction check. It warns and never blocks: a rule read from prose is a guess, and
// the user may have changed their mind in a way this plugin cannot see.
const MAX_INSTRUCTIONS = 20;
const MAX_FILE_SENTENCES = 150;
const MAX_SENTENCES_PER_REQUEST = 50;
const MAX_CACHED_SENTENCES = 2000;
const MAX_CHANGES = 10;
const MAX_WARNINGS = 5;

// Off by default: when on, chat.message reads the key before any tool runs,
// earlier than the key rule allows. Open question whether that breaks the rule.
export const CLASSIFY_ON_MESSAGE = false;

export interface SentenceDeps extends ReviewDeps {
  // Answers by sentence. true means a rule worth checking.
  cache: Map<string, boolean>;
  // Sentences being classified now. The check awaits these instead of asking again.
  sentenceInflight?: Map<string, Promise<void>>;
}

export interface InstructionDeps extends SentenceDeps {
  // Instruction files that apply to the changed paths, global first and nearest last.
  instructionFiles: (paths: string[]) => InstructionFile[];
}

export interface Sentence {
  key: string;
  text: string;
  // An instruction file path, or `user_messages[n]`.
  from: string;
}
interface SentenceRequest {
  state: { purpose: string; user_messages?: string[]; sentences: { from: string; text: string }[] };
  questions: Record<string, Question>;
}

export interface RuleRequest {
  state: {
    purpose: string;
    user_messages?: string[];
    instructions: { from: string; text: string }[];
    changes: Change[];
  };
  questions: Record<string, Question>;
}

export interface InstructionPrep {
  requests: RuleRequest[];
  finish: (results: (Record<string, unknown> | undefined)[]) => string | undefined;
  // Shared with the wrapper, so sentence and rule failures log one line.
  once: ReviewDeps;
  settings: Settings;
}

// Reads the disk before its first await, so a `write` is compared with the file as it was.
// Sentence requests stay separate and run first; only rule questions are returned for merging.
export async function prepareInstructions(tool: string, args: unknown, deps: InstructionDeps, silentSentences = false): Promise<InstructionPrep | undefined> {
  const root = deps.disk?.root ?? '';
  const changes = changesFrom(tool, args, reader(deps.disk)).filter(change => !ignoredPath(change.path)).slice(0, MAX_CHANGES);
  if (changes.length === 0) return;
  const userMessages = deps.userMessages ?? [];
  const files = deps.instructionFiles(changes.map(change => change.path));
  if (files.length === 0 && userMessages.length === 0) return;
  // A missing key blocks only a test write.
  const settings = deps.load();
  if (settings.error || settings.key.trim() === '') return;
  const once = logOnce(deps);

  const show = (path: string) => (root && isAbsolute(path) ? relative(root, path) : path) || path;
  const fromFiles: Sentence[] = [];
  for (const file of files) {
    for (const text of sentencesOf(file.text)) fromFiles.push({ key: `file\n${text}`, text, from: show(file.path) });
  }
  const sentences: Sentence[] = [];
  const seen = new Set<string>();
  for (const sentence of [...fromFiles.slice(-MAX_FILE_SENTENCES), ...userSentences(userMessages)]) {
    if (seen.has(sentence.key)) continue;
    seen.add(sentence.key);
    sentences.push(sentence);
  }

  // Sentence requests run first. An early start warms the same keys, so this awaits them.
  const sentenceDeps: SentenceDeps = silentSentences ? { ...deps, log: undefined } : { ...deps, log: once.log };
  await startSentenceClassification(sentences, sentenceDeps, settings);

  const rules = sentences.filter(sentence => deps.cache.get(sentence.key) === true).slice(-MAX_INSTRUCTIONS);
  if (rules.length === 0) return;

  // Leave room for one lift question per rule, so a batch stays within the question limit.
  const perRequest = Math.max(1, Math.floor((MAX_QUESTIONS - rules.length) / rules.length));
  const requests: RuleRequest[] = [];
  for (let start = 0; start < changes.length; start += perRequest) {
    requests.push(ruleRequest(changes.slice(start, start + perRequest), rules, userMessages));
  }
  return {
    requests,
    finish: results => finishInstructions(requests, rules, show, results),
    once,
    settings,
  };
}

// User sentences with the same keys the check uses, so an early request matches.
export function userSentences(messages: string[]): Sentence[] {
  const out: Sentence[] = [];
  for (const [n, message] of messages.entries()) {
    for (const text of sentencesOf(message)) out.push({ key: `user\n${text}`, text, from: `user_messages[${n}]` });
  }
  return out;
}

// Same request as the check, so an early start hits the answer cache.
export async function startSentenceClassification(sentences: Sentence[], deps: SentenceDeps, settings: Settings): Promise<void> {
  const userMessages = deps.userMessages ?? [];
  const shared = deps.sentenceInflight ?? new Map<string, Promise<void>>();
  const fresh: Sentence[] = [];
  const waits: Promise<void>[] = [];
  for (const sentence of sentences) {
    const found = shared.get(sentence.key);
    if (found) {
      waits.push(found);
      continue;
    }
    if (deps.cache.has(sentence.key)) continue;
    fresh.push(sentence);
  }
  const chunks: Sentence[][] = [];
  for (let start = 0; start < fresh.length; start += MAX_SENTENCES_PER_REQUEST) chunks.push(fresh.slice(start, start + MAX_SENTENCES_PER_REQUEST));
  for (const chunk of chunks) {
    const request = sentenceRequest(chunk, userMessages);
    const run = (async (): Promise<void> => {
      const answers = await callTypeSafe(deps, settings, request, 'No instruction note was added.');
      for (const [n, sentence] of chunk.entries()) {
        const limits = noulScore(answers?.[`s${n}_limits`]);
        const style = noulScore(answers?.[`s${n}_style`]);
        // A missing answer is asked again next time.
        if (limits === undefined || style === undefined) continue;
        deps.cache.set(sentence.key, limits >= 0.5 && style < 0.5);
        if (deps.cache.size > MAX_CACHED_SENTENCES) {
          const oldest = deps.cache.keys().next().value;
          if (oldest !== undefined) deps.cache.delete(oldest);
        }
      }
    })();
    for (const sentence of chunk) shared.set(sentence.key, run);
    waits.push(run);
    // A settled chunk leaves the map. A later turn asks again only on a cache miss.
    void run.finally(() => {
      for (const sentence of chunk) if (shared.get(sentence.key) === run) shared.delete(sentence.key);
    });
  }
  await Promise.all(waits);
}

export async function checkInstructions(tool: string, args: unknown, deps: InstructionDeps): Promise<string | undefined> {
  const prep = await prepareInstructions(tool, args, deps);
  if (!prep) return;
  const results = await Promise.all(prep.requests.map(request => callTypeSafe(prep.once, prep.settings, request, 'No instruction note was added.')));
  return prep.finish(results);
}

function finishInstructions(requests: RuleRequest[], rules: Sentence[], show: (path: string) => string, results: (Record<string, unknown> | undefined)[]): string | undefined {
  const warnings: string[] = [];
  for (const [r, request] of requests.entries()) {
    const answers = results[r];
    if (!answers) continue;
    // A later user message that lifts the rule wins. Unsure counts as lifted.
    const lifted = new Set<number>();
    for (const k of rules.keys()) {
      const answer = noulScore(answers[`i${k}_lifted`]);
      if (answer !== undefined && answer >= 0.5) lifted.add(k);
    }
    for (const [j, change] of request.state.changes.entries()) {
      for (const [k, rule] of rules.entries()) {
        if (lifted.has(k) || !noulIsSure(answers[`c${j}_i${k}_breaks`])) continue;
        const quoted = rule.text.length > 200 ? `${rule.text.slice(0, 197)}...` : rule.text;
        const source = rule.from.startsWith('user_messages') ? 'the user\'s message' : rule.from;
        warnings.push(`- ${show(change.path)} may break "${quoted}" (from ${source})`);
      }
    }
  }
  if (warnings.length === 0) return;
  const shown = [...new Set(warnings)];
  return [
    'Jevy note: this change was made, but it may break an instruction.',
    ...shown.slice(0, MAX_WARNINGS),
    ...(shown.length > MAX_WARNINGS ? [`- and ${shown.length - MAX_WARNINGS} more`] : []),
    'Check the change. If it does break the instruction, undo it or ask the user.',
  ].join('\n');
}

function sentenceRequest(chunk: Sentence[], userMessages: string[]): SentenceRequest {
  const questions: Record<string, Question> = {};
  for (const n of chunk.keys()) {
    const at = `\`sentences[${n}].text\``;
    questions[`s${n}_limits`] = {
      type: 'noul',
      instructions: `Is the sentence in ${at} an instruction that limits what the agent may change or how?`,
      criteria: {
        true: 'It forbids, restricts, or requires something about which files, code, tests, APIs, dependencies, or commands the agent may change or use, or how it must change them.',
        false: 'It describes, explains, suggests, asks a question, or thanks. Or it is a task to do rather than a limit on how to do it.',
      },
    };
    questions[`s${n}_style`] = {
      type: 'noul',
      instructions: `Is the sentence in ${at} only about formatting or code style?`,
      criteria: {
        true: 'It is only about whitespace, line length, quotes, semicolons, naming case, import order, or other things a formatter or linter checks.',
        false: 'It is about behavior, scope, files, tests, APIs, dependencies, commands, or process.',
      },
    };
  }
  const user = chunk.some(sentence => sentence.from.startsWith('user_messages'));
  return {
    state: {
      purpose: 'Decide which sentences are rules a coding agent must follow when it edits files. `from` is the instruction file or the user message the sentence comes from. `user_messages` gives the full messages for context.',
      ...(user ? { user_messages: userMessages } : {}),
      sentences: chunk.map(sentence => ({ from: sentence.from, text: sentence.text })),
    },
    questions,
  };
}

function pathsInInstruction(text: string): string[] {
  const found: string[] = [];
  const pattern = /(?:\.\/|\/)?[A-Za-z0-9_.-]+\/[A-Za-z0-9_./-]*|[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)+/g;
  for (const match of text.matchAll(pattern)) {
    const token = match[0].replace(/\.+$/, '');
    if (!/[A-Za-z]/.test(token)) continue;
    if (token.includes('/') || /\.[A-Za-z0-9]*[A-Za-z][A-Za-z0-9]*$/.test(token)) found.push(token);
  }
  return found;
}

function pathApplies(changePath: string, instructionPath: string): boolean {
  const segs = (path: string) => path.replaceAll('\\', '/').replace(/\/+/g, '/').replace(/^(?:\.\/|\/)+/, '').split('/').filter(seg => seg !== '');
  const suffix = (path: string[], end: string[]) => end.length > 0 && end.length <= path.length && end.every((seg, n) => path[path.length - end.length + n] === seg);
  const named = segs(instructionPath);
  if (named.length === 0) return true;
  const file = instructionPath.endsWith('/') ? segs(changePath).slice(0, -1) : segs(changePath);
  return file.length > 0 && (suffix(file, named) || suffix(named, file));
}

function ruleRequest(changes: Change[], rules: Sentence[], userMessages: string[]): RuleRequest {
  const questions: Record<string, Question> = {};
  const side = (text: string, path: string) => headTail(withoutComments(text, path), MAX_EDIT_SIDE_CHARS).text;
  for (const j of changes.keys()) {
    for (const k of rules.keys()) {
      const paths = pathsInInstruction(rules[k].text);
      if (paths.length > 0 && !paths.some(path => pathApplies(changes[j].path, path))) continue;
      questions[`c${j}_i${k}_breaks`] = {
        type: 'noul',
        instructions: `Does the change in \`changes[${j}]\` violate the instruction in \`instructions[${k}].text\`?`,
        criteria: {
          true: 'The `new` text does something the instruction forbids, or leaves out something it requires, for this file.',
          false: 'The `new` text follows the instruction, or the instruction does not apply to this file or this kind of change.',
        },
      };
    }
  }
  if (userMessages.length > 0) {
    for (const k of rules.keys()) {
      questions[`i${k}_lifted`] = {
        type: 'noul',
        instructions: `Does a message in \`user_messages\` that comes after the instruction in \`instructions[${k}]\` take it back or allow an exception to it?`,
        criteria: {
          true: 'A later user message cancels, changes, or makes an exception to this instruction. Every user message comes after instruction files.',
          false: 'No later user message changes this instruction, or it comes from the latest user message.',
        },
      };
    }
  }
  return {
    state: {
      purpose: 'Decide whether each change in `changes` breaks an instruction in `instructions`. `new` is the text after the change. `old`, when present, is the text it replaced, for contrast only. `user_messages` are the user\'s messages, oldest first. The latest user message wins over earlier instructions. Comments were removed from code files.',
      ...(userMessages.length > 0 ? { user_messages: userMessages } : {}),
      instructions: rules.map(rule => ({ from: rule.from, text: rule.text })),
      changes: changes.map(change => ({
        path: change.path,
        new: side(change.new, change.path),
      })),
    },
    questions,
  };
}
