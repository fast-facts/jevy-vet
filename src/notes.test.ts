import { describe, expect, test } from 'bun:test';
import { asyncTreeDisk, deps, jsonResponse, memoryDisk } from './fakes.test.ts';
import { sentencesOf } from './context.ts';
import { checkHiddenErrors } from './hidden.ts';
import { checkInstructions } from './instructions.ts';
import { type Question, type ReviewDeps } from './jev.ts';
import { checkNotes, type NotesDeps } from './notes.ts';
import { ProjectIndex } from './project.ts';
import { checkReuse } from './reuse.ts';
import { type Settings } from './settings.ts';
import { checkStaleDocs } from './stale.ts';

const TO_ISO_DAY = 'export function toIsoDay(date: Date): string {\n  return date.toISOString().slice(0, 10);\n}\n';
const FORMAT_DAY = '// Formats the day.\nexport function formatDay(day: Date): string {\n  try {\n    return day.toISOString().slice(0, 10);\n  } catch {\n    return \'\';\n  }\n}';
const RULE = 'Do not add formatDay.';

interface NoteBody {
  state: Record<string, unknown>;
  questions: Record<string, Question>;
}

function sure(): Record<string, unknown> {
  return { type: 'noul', noul: 0.9, confidence: 0.9 };
}

function low(): Record<string, unknown> {
  return { type: 'noul', noul: 0.1 };
}

// One write that trips all four note checks: a duplicate function with a
// catch-all and a comment, breaking a cached instruction rule.
function allFour(answer: (id: string) => Record<string, unknown>, options: { messages?: string[]; settings?: Partial<Settings>; fail?: boolean; cache?: Map<string, boolean> } = {}) {
  const files = { '/repo/src/date.ts': TO_ISO_DAY };
  const bodies: NoteBody[] = [];
  const { disk } = memoryDisk(files);
  const used = deps((_url, init) => {
    const body = JSON.parse(String(init.body)) as NoteBody;
    bodies.push(body);
    if (options.fail) return Promise.reject(new Error('offline'));
    const answers: Record<string, unknown> = {};
    for (const id of Object.keys(body.questions)) answers[id] = answer(id);
    return Promise.resolve(jsonResponse({ answers }));
  }, options.settings ?? { key: 'ts_secret' }, disk);
  const tree = asyncTreeDisk(files);
  // The rule and the user sentences start classified, so no sentence request runs.
  const cache = options.cache ?? (() => {
    const map = new Map<string, boolean>([[`file\n${RULE}`, true]]);
    for (const message of options.messages ?? []) {
      for (const text of sentencesOf(message)) {
        if (!map.has(`user\n${text}`)) map.set(`user\n${text}`, false);
      }
    }
    return map;
  })();
  const notes: NotesDeps & { logs: string[] } = Object.assign(used, {
    userMessages: options.messages,
    project: new ProjectIndex(tree.disk),
    cache,
    instructionFiles: () => [{ path: 'AGENTS.md', text: `- ${RULE}` }],
  });
  const args = { filePath: 'src/format.ts', content: FORMAT_DAY };
  return { result: checkNotes('write', args, notes), bodies, used: notes, args };
}

describe('merged notes', () => {
  test('sends one request for every note check, with one shared user_messages', async () => {
    const { result, bodies } = allFour(id => (id.endsWith('_lifted') || id.endsWith('_user_asked') ? low() : sure()), { messages: ['Please add formatDay.'] });
    const note = await result;
    expect(bodies).toHaveLength(1);
    const body = bodies[0] as NoteBody;
    expect(body.state.user_messages).toEqual(['Please add formatDay.']);
    for (const section of ['instructions', 'reuse', 'hidden', 'stale']) {
      expect(body.state[section]).toBeDefined();
      expect(body.state[section]).not.toHaveProperty('user_messages');
      expect(body.state[section]).not.toHaveProperty('purpose');
    }
    expect(Object.keys(body.questions).sort()).toEqual([
      'hidden_x0_hides_error', 'hidden_x0_user_asked',
      'instructions_c0_i0_breaks', 'instructions_i0_lifted',
      'reuse_r0_user_asked', 'reuse_r0_x0_duplicates',
      'stale_c0_stale', 'stale_x0_user_asked',
    ]);
    expect(note).toContain('may break an instruction');
    expect(note).toContain('may repeat code');
    expect(note).toContain('may hide an error');
    expect(note).toContain('no longer match');
  });

  test('rewrites only paths, and routes colliding intent ids to the right check', async () => {
    const { result, bodies } = allFour(id => {
      if (id === 'stale_x0_user_asked') return { type: 'noul', noul: 0.9 };
      if (id.endsWith('_lifted') || id.endsWith('_user_asked')) return low();
      return sure();
    }, { messages: ['Just bump it, leave the docs.'] });
    const note = await result;
    // The stale note drops (user asked), the hidden note stays.
    expect(note).toContain('may hide an error');
    expect(note).not.toContain('no longer match');
    const body = bodies[0] as NoteBody;
    expect(body.questions.hidden_x0_hides_error?.instructions).toBe('Does the change in `hidden.changes[0]` hide a failure instead of handling it, so an error that should stop the code or reach the caller now passes silently?');
    expect(body.questions.reuse_r0_x0_duplicates?.instructions).toContain('`reuse.new_code[0]`');
    expect(body.questions.stale_c0_stale?.instructions).toContain('`stale.comments[0]`');
    expect(body.questions.instructions_c0_i0_breaks?.instructions).toContain('`instructions.changes[0]`');
  });

  test('matches the separate checks note for note', async () => {
    const split = (id: string) => (id.endsWith('_lifted') || id.endsWith('_user_asked') ? low() : sure());
    const merged = allFour(id => split(id.slice(id.indexOf('_') + 1)), { messages: ['Please add formatDay.'] });
    const mergedNote = await merged.result;
    const files = { '/repo/src/date.ts': TO_ISO_DAY };
    const splitFetch: ReviewDeps['fetch'] = (_url, init) => {
      const body = JSON.parse(String(init.body)) as NoteBody;
      const answers: Record<string, unknown> = {};
      for (const id of Object.keys(body.questions)) answers[id] = split(id);
      return Promise.resolve(jsonResponse({ answers }));
    };
    const disk = memoryDisk(files).disk;
    const project = new ProjectIndex(asyncTreeDisk(files).disk);
    const messages = ['Please add formatDay.'];
    const made = <T extends object>(extra: T) => Object.assign(deps(splitFetch, { key: 'ts_secret' }, disk), { userMessages: messages, ...extra });
    const found = await Promise.all([
      checkInstructions('write', merged.args, made({ cache: new Map<string, boolean>([[`file\n${RULE}`, true]]), instructionFiles: () => [{ path: 'AGENTS.md', text: `- ${RULE}` }] })),
      checkReuse('write', merged.args, made({ project })),
      checkHiddenErrors('write', merged.args, made({})),
      checkStaleDocs('write', merged.args, made({ project })),
    ]);
    expect(mergedNote).toBe(found.filter(note => note).join('\n\n'));
  });

  test('keeps the sentence requests separate and earlier', async () => {
    const { result, bodies } = allFour(id => {
      if (id.endsWith('_style')) return low();
      if (id.endsWith('_limits')) return { type: 'noul', noul: 0.9 };
      if (id.endsWith('_lifted') || id.endsWith('_user_asked')) return low();
      return sure();
    }, { cache: new Map<string, boolean>() });
    await result;
    expect(bodies).toHaveLength(2);
    expect(bodies[0]?.state.sentences).toBeDefined();
    expect(bodies[1]?.state.instructions).toBeDefined();
    expect(Object.keys(bodies[1]?.questions ?? {}).some(id => id.includes('_limits'))).toBe(false);
  });

  test('falls back to one request per check when instructions split', async () => {
    const many = Array.from({ length: 30 }, (_, n) => `- Do not edit module${n}.`).join('\n');
    const cache = new Map<string, boolean>();
    for (let n = 0; n < 30; n += 1) cache.set(`file\nDo not edit module${n}.`, true);
    const patchText = ['*** Begin Patch', ...Array.from({ length: 12 }, (_, n) => [`*** Add File: f${n}.ts`, `+export const v${n} = ${n}`]).flat(), '*** End Patch'].join('\n');
    const bodies: NoteBody[] = [];
    const { disk } = memoryDisk({});
    const used = deps((_url, init) => {
      const body = JSON.parse(String(init.body)) as NoteBody;
      bodies.push(body);
      const answers: Record<string, unknown> = {};
      for (const id of Object.keys(body.questions)) answers[id] = low();
      return Promise.resolve(jsonResponse({ answers }));
    }, { key: 'ts_secret' }, disk);
    const notes: NotesDeps = Object.assign(used, {
      cache,
      instructionFiles: () => [{ path: 'AGENTS.md', text: many }],
    });
    const note = await checkNotes('apply_patch', { patchText }, notes);
    expect(note).toBeUndefined();
    // Three rule chunks, each its own request, with plain ids.
    expect(bodies).toHaveLength(3);
    expect(bodies.every(body => Array.isArray(body.state.instructions))).toBe(true);
    expect(bodies.flatMap(body => Object.keys(body.questions)).some(id => id.includes('instructions_'))).toBe(false);
  });

  test('adds nothing and logs once when TypeSafe fails', async () => {
    const { result, used } = allFour(() => sure(), { fail: true });
    expect(await result).toBeUndefined();
    expect(used.logs).toEqual(['TypeSafe request failed. No note was added.']);
  });

  test('adds nothing without a key', async () => {
    const { result, bodies, used } = allFour(() => sure(), { settings: { key: '' } });
    expect(await result).toBeUndefined();
    expect(bodies).toHaveLength(0);
    expect(used.logs).toEqual([]);
  });
});
