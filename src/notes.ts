import { type HiddenDeps, prepareHiddenErrors } from './hidden.ts';
import { type InstructionDeps, prepareInstructions } from './instructions.ts';
import { callTypeSafe, logOnce, MAX_QUESTIONS, type Question, type ReviewDeps } from './jev.ts';
import { prepareReuse } from './reuse.ts';
import { prepareStaleDocs } from './stale.ts';

export type NotesDeps = InstructionDeps & HiddenDeps;

// Off until a live A/B shows the merged request keeps precision.
let NOTES_MERGED = false;
export function notesMerged(): boolean {
  return NOTES_MERGED;
}
// Tests only. Production stays off until the A/B lands.
export function setNotesMerged(value: boolean): void {
  NOTES_MERGED = value;
}

// One shared intent question per file instead of per check. Off: kept
// only if an A/B shows no precision loss.
const SHARED_INTENT_PER_FILE = false;

// Chars, at 3 per token. Past either limit, or past the question limit,
// the combined request falls back to one request per check.
const MAX_STATE_PLUS_LONGEST = 72_000;
const MAX_STATE_PLUS_ALL = 150_000;

interface Part {
  prefix: string;
  about: string;
  body: Record<string, unknown>;
  questions: Record<string, Question>;
  finish: (answers: Record<string, unknown> | undefined) => string | undefined;
  // The original requests, for the size fallback. Same bodies, no re-read.
  sends: { state: { purpose: string }; questions: Record<string, Question>; allowed: string }[];
}

interface SectionPrep {
  state: { purpose: string; user_messages?: string[] };
  questions: Record<string, Question>;
  finish: (answers: Record<string, unknown> | undefined) => string | undefined;
}

interface Candidate {
  prep: SectionPrep | undefined;
  prefix: string;
  about: string;
  names: string[];
  allowed: string;
}

// One TypeSafe request for the four note checks. Sentence requests stay
// separate and run first. Only question paths gain a prefix.
export async function checkNotes(tool: string, args: unknown, deps: NotesDeps): Promise<string | undefined> {
  // Invoked together, so every sync disk read runs before the first await.
  const [instruction, reuse, hidden, stale] = await Promise.all([
    prepareInstructions(tool, args, deps, true).catch(() => undefined),
    prepareReuse(tool, args, deps).catch(() => undefined),
    prepareHiddenErrors(tool, args, deps).catch(() => undefined),
    prepareStaleDocs(tool, args, deps).catch(() => undefined),
  ]);
  // More than one instruction chunk keeps its local ids, so it cannot merge.
  if (instruction && instruction.requests.length !== 1) {
    return runSeparate(
      instruction.requests.map(request => ({ state: request.state, questions: request.questions, allowed: 'No instruction note was added.' })),
      results => instruction.finish(results),
      deps,
    );
  }
  const first = instruction?.requests[0];
  const candidates: Candidate[] = [
    { prep: first && instruction ? { state: first.state, questions: first.questions, finish: answers => instruction.finish([answers]) } : undefined, prefix: 'instructions', about: 'Whether each change breaks an instruction.', names: ['instructions', 'changes'], allowed: 'No instruction note was added.' },
    { prep: reuse, prefix: 'reuse', about: 'Whether each new function repeats existing code.', names: ['new_code', 'existing'], allowed: 'No reuse note was added.' },
    { prep: hidden, prefix: 'hidden', about: 'Whether each change hides a failure.', names: ['changes'], allowed: 'No hidden-error note was added.' },
    { prep: stale, prefix: 'stale', about: 'Whether each comment or doc is wrong after the change.', names: ['changes', 'comments'], allowed: 'No stale-comment note was added.' },
  ];
  const parts: Part[] = [];
  for (const candidate of candidates) {
    if (!candidate.prep) continue;
    parts.push({
      prefix: candidate.prefix,
      about: candidate.about,
      body: bodyOf(candidate.prep.state),
      questions: rewrite(candidate.prep.questions, candidate.prefix, candidate.names),
      finish: candidate.prep.finish,
      sends: [{ state: candidate.prep.state, questions: candidate.prep.questions, allowed: candidate.allowed }],
    });
  }
  if (parts.length === 0) return;
  dedupeSharedIntents(parts);

  const userMessages = deps.userMessages ?? [];
  const sections: { purpose: string } & Record<string, unknown> = {
    purpose: `Decide whether each note below applies. Sections: ${parts.map(part => `\`${part.prefix}\` (${part.about})`).join(', ')}. \`user_messages\` are shared.`,
    ...(userMessages.length > 0 ? { user_messages: userMessages } : {}),
  };
  for (const part of parts) sections[part.prefix] = { about: part.about, ...part.body };
  const questions: Record<string, Question> = {};
  for (const part of parts) {
    for (const [id, question] of Object.entries(part.questions)) questions[`${part.prefix}_${id}`] = question;
  }
  if (tooBig(sections, questions)) {
    return runSeparate(parts.flatMap(part => part.sends), results => {
      const notes: string[] = [];
      for (const [n, part] of parts.entries()) {
        const note = part.finish(results[n]);
        if (note) notes.push(note);
      }
      return notes.join('\n\n') || undefined;
    }, deps);
  }
  const settings = deps.load();
  if (settings.error || settings.key.trim() === '') return;
  // A combined failure logs one line.
  const answers = await callTypeSafe(logOnce(deps), settings, { state: sections, questions }, 'No note was added.');
  return finishParts(parts, answers);
}

function bodyOf(state: { purpose: string; user_messages?: string[] }): Record<string, unknown> {
  const body: Record<string, unknown> = { ...state };
  delete body.purpose;
  delete body.user_messages;
  return body;
}

// Prefix ids and rewrite state paths to the merged section. Only paths change.
function rewrite(questions: Record<string, Question>, prefix: string, names: string[]): Record<string, Question> {
  const out: Record<string, Question> = {};
  for (const [id, question] of Object.entries(questions)) {
    let text = question.instructions;
    for (const name of names) text = text.split(`\`${name}[`).join(`\`${prefix}.${name}[`);
    out[id] = { ...question, instructions: text };
  }
  return out;
}

// Intent questions stay one per check and change. Only the same intent
// on the same change text would dedupe, and none do today.
function dedupeSharedIntents(parts: Part[]): void {
  if (!SHARED_INTENT_PER_FILE) return;
  void parts;
}

function tooBig(state: Record<string, unknown>, questions: Record<string, Question>): boolean {
  if (Object.keys(questions).length > MAX_QUESTIONS) return true;
  const stateChars = JSON.stringify(state).length;
  let longest = 0;
  let all = 0;
  for (const question of Object.values(questions)) {
    const length = JSON.stringify(question).length;
    all += length;
    if (length > longest) longest = length;
  }
  return stateChars + longest > MAX_STATE_PLUS_LONGEST || stateChars + all > MAX_STATE_PLUS_ALL;
}

// One request per check, from the already-read states. Same notes and order.
async function runSeparate(sends: Part['sends'], finish: (results: (Record<string, unknown> | undefined)[]) => string | undefined, deps: ReviewDeps): Promise<string | undefined> {
  const settings = deps.load();
  if (settings.error || settings.key.trim() === '') return;
  const once = logOnce(deps);
  const results = await Promise.all(sends.map(send => callTypeSafe(once, settings, { state: send.state, questions: send.questions }, send.allowed)));
  return finish(results);
}

function finishParts(parts: Part[], answers: Record<string, unknown> | undefined): string | undefined {
  if (!answers) return;
  const notes: string[] = [];
  for (const part of parts) {
    const sub: Record<string, unknown> = {};
    for (const [id, answer] of Object.entries(answers)) {
      if (!id.startsWith(`${part.prefix}_`)) continue;
      sub[id.slice(part.prefix.length + 1)] = answer;
    }
    const note = part.finish(sub);
    if (note) notes.push(note);
  }
  return notes.join('\n\n') || undefined;
}
