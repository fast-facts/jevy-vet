import { describe, expect, test } from 'bun:test';
import { deps, jsonResponse, memoryDisk } from './fakes.test.ts';
import { checkInstructions, CLASSIFY_ON_MESSAGE, type InstructionDeps, startSentenceClassification, userSentences } from './instructions.ts';
import { type ReviewDeps } from './jev.ts';
import { type Settings } from './settings.ts';

describe('instruction check', () => {
  interface Sent {
    state: {
      purpose: string;
      user_messages?: string[];
      sentences?: { from: string; text: string }[];
      instructions?: { from: string; text: string }[];
      changes?: { path: string; old?: string; new: string }[];
    };
    questions: Record<string, { type: string; instructions: string; criteria: { true: string; false: string } }>;
  }
  type Answer = (id: string, body: Sent) => Record<string, unknown> | undefined;

  const rules: Answer = (id, body) => {
    const n = Number(/^s(\d+)_/.exec(id)?.[1]);
    const text = body.state.sentences?.[n]?.text ?? '';
    if (id.endsWith('_limits')) return { type: 'noul', noul: /Do not|Never|Only/.test(text) ? 0.95 : 0.05 };
    if (id.endsWith('_style')) return { type: 'noul', noul: /indent|quotes/.test(text) ? 0.9 : 0.05 };
    return undefined;
  };
  const breaks = (match: (rule: string, change: { path: string; new: string }) => boolean, lifted = 0.1): Answer => (id, body) => {
    const pair = /^c(\d+)_i(\d+)_breaks$/.exec(id);
    if (pair) {
      const change = body.state.changes?.[Number(pair[1])];
      const rule = body.state.instructions?.[Number(pair[2])]?.text ?? '';
      return { type: 'noul', noul: change && match(rule, change) ? 0.9 : 0.1 };
    }
    if (id.endsWith('_lifted')) return { type: 'noul', noul: lifted };
    return rules(id, body);
  };

  function judge(answer: Answer) {
    const sent: Sent[] = [];
    const fetchImpl: ReviewDeps['fetch'] = (_url, init) => {
      const body = JSON.parse(String(init.body)) as Sent;
      sent.push(body);
      const answers: Record<string, unknown> = {};
      for (const id of Object.keys(body.questions)) {
        const value = answer(id, body);
        if (value) answers[id] = value;
      }
      return Promise.resolve(jsonResponse({ model: 'jev-latest', answers }));
    };
    return { sent, fetchImpl };
  }

  function instructionDeps(
    fetchImpl: ReviewDeps['fetch'],
    options: { files?: Record<string, string>; disk?: Record<string, string>; messages?: string[]; cache?: Map<string, boolean>; settings?: Partial<Settings> } = {},
  ): InstructionDeps & { logs: string[]; asked: string[][] } {
    const base = deps(fetchImpl, options.settings ?? { key: 'ts_secret' }, memoryDisk(options.disk ?? {}).disk);
    const asked: string[][] = [];
    return Object.assign(base, {
      userMessages: options.messages ?? [],
      cache: options.cache ?? new Map<string, boolean>(),
      asked,
      instructionFiles: (paths: string[]) => {
        asked.push(paths);
        return Object.entries(options.files ?? {}).map(([path, text]) => ({ path, text }));
      },
    });
  }

  const AGENTS = '- Do not change `src/api.ts` signatures.\n- Use 2-space indent.\n- The project uses Bun.';
  const edit = { filePath: '/repo/src/api.ts', oldString: 'export function get(id: string) {', newString: 'export function get(id: number) {' };

  test('asks the two extraction questions per sentence, then warns with the file and the quoted rule', async () => {
    const { sent, fetchImpl } = judge(breaks(rule => rule.includes('signatures')));
    const note = await checkInstructions('edit', edit, instructionDeps(fetchImpl, { files: { '/repo/AGENTS.md': AGENTS } }));
    expect(note).toBe([
      'Jevy note: this change was made, but it may break an instruction.',
      '- src/api.ts may break "Do not change `src/api.ts` signatures." (from AGENTS.md)',
      'Check the change. If it does break the instruction, undo it or ask the user.',
    ].join('\n'));
    const [extract, check] = sent;
    expect(extract?.state.sentences).toEqual([
      { from: 'AGENTS.md', text: 'Do not change `src/api.ts` signatures.' },
      { from: 'AGENTS.md', text: 'Use 2-space indent.' },
      { from: 'AGENTS.md', text: 'The project uses Bun.' },
    ]);
    expect(extract?.questions.s0_limits?.instructions).toBe('Is the sentence in `sentences[0].text` an instruction that limits what the agent may change or how?');
    expect(extract?.questions.s0_style?.instructions).toBe('Is the sentence in `sentences[0].text` only about formatting or code style?');
    // The style rule and the description are not checked against the edit.
    expect(check?.state.instructions).toEqual([{ from: 'AGENTS.md', text: 'Do not change `src/api.ts` signatures.' }]);
    expect(check?.state.changes).toEqual([{ path: '/repo/src/api.ts', new: 'export function get(id: number) {' }]);
    expect(check?.questions.c0_i0_breaks?.instructions).toBe('Does the change in `changes[0]` violate the instruction in `instructions[0].text`?');
    expect(Object.keys(check?.questions ?? {})).toEqual(['c0_i0_breaks']);
  });

  test('asks each sentence once, across edits, and forgets unanswered ones', async () => {
    const cache = new Map<string, boolean>();
    const { sent, fetchImpl } = judge(breaks(() => false));
    expect(await checkInstructions('edit', edit, instructionDeps(fetchImpl, { files: { '/repo/AGENTS.md': AGENTS }, cache }))).toBeUndefined();
    expect(await checkInstructions('edit', edit, instructionDeps(fetchImpl, { files: { '/repo/AGENTS.md': AGENTS }, cache }))).toBeUndefined();
    expect(sent.map(body => body.state.sentences ? 'extract' : 'check')).toEqual(['extract', 'check', 'check']);
    expect([...cache.values()]).toEqual([true, false, false]);
    const emptyCache = new Map<string, boolean>();
    const { fetchImpl: silent } = judge(() => undefined);
    expect(await checkInstructions('edit', edit, instructionDeps(silent, { files: { '/repo/AGENTS.md': AGENTS }, cache: emptyCache }))).toBeUndefined();
    expect(emptyCache.size).toBe(0);
  });

  test('takes rules from the user\'s messages, and a later message can lift a rule', async () => {
    const messages = ['Never touch the billing code.', 'Actually, go ahead and fix billing too.'];
    const touchesBilling = breaks(rule => rule.includes('billing'), 0.9);
    const lifted = judge(touchesBilling);
    const change = { filePath: '/repo/src/billing.ts', content: 'export const rate = 2' };
    expect(await checkInstructions('write', change, instructionDeps(lifted.fetchImpl, { messages }))).toBeUndefined();
    const check = lifted.sent[1];
    expect(check?.state.user_messages).toEqual(messages.slice(-1));
    expect(check?.state.instructions).toEqual([{ from: 'user_messages[0]', text: 'Never touch the billing code.' }]);
    expect(check?.questions.i0_lifted?.instructions).toBe('Does a message in `user_messages` that comes after the instruction in `instructions[0]` take it back or allow an exception to it?');

    const kept = judge(breaks(rule => rule.includes('billing'), 0.2));
    expect(await checkInstructions('write', change, instructionDeps(kept.fetchImpl, { messages: [messages[0] ?? ''] })))
      .toContain('- src/billing.ts may break "Never touch the billing code." (from the user\'s message)');
  });

  test('warns only when Jev is sure', async () => {
    const unsure: Answer = (id, body) => id.endsWith('_breaks') ? { type: 'noul', noul: 0.79 } : rules(id, body);
    expect(await checkInstructions('edit', edit, instructionDeps(judge(unsure).fetchImpl, { files: { '/repo/AGENTS.md': AGENTS } }))).toBeUndefined();
    const lowConfidence: Answer = (id, body) => id.endsWith('_breaks') ? { type: 'noul', noul: 0.95, confidence: 0.5 } : rules(id, body);
    expect(await checkInstructions('edit', edit, instructionDeps(judge(lowConfidence).fetchImpl, { files: { '/repo/AGENTS.md': AGENTS } }))).toBeUndefined();
  });

  test('checks non-test files of every kind, and strips comments only from code', async () => {
    const { sent, fetchImpl } = judge(breaks(() => false));
    const patchText = [
      '*** Begin Patch',
      '*** Add File: docs/guide.md',
      '+Don\'t run `rm -rf` // really',
      '*** Add File: src/db.ts',
      '+const url = "x" // the user said this is fine',
      '*** End Patch',
    ].join('\n');
    await checkInstructions('apply_patch', { patchText }, instructionDeps(fetchImpl, { files: { '/repo/AGENTS.md': AGENTS } }));
    expect(sent[1]?.state.changes).toEqual([
      { path: 'docs/guide.md', new: 'Don\'t run `rm -rf` // really' },
      { path: 'src/db.ts', new: 'const url = "x"' },
    ]);
  });

  test('compares a write with the file on disk before it', async () => {
    const { sent, fetchImpl } = judge(breaks(() => false));
    const d = instructionDeps(fetchImpl, { files: { '/repo/AGENTS.md': AGENTS }, disk: { '/repo/src/api.ts': 'export function get(id: string) {}' } });
    await checkInstructions('write', { filePath: 'src/api.ts', content: 'export function get(id: number) {}' }, d);
    expect(sent[1]?.state.changes).toEqual([{ path: 'src/api.ts', new: 'export function get(id: number) {}' }]);
    expect(d.asked).toEqual([['src/api.ts']]);
  });

  test('keeps each request within the question limit and caps rules and changes', async () => {
    const many = Array.from({ length: 30 }, (_, n) => `- Do not edit module${n}.`).join('\n');
    const patchText = ['*** Begin Patch', ...Array.from({ length: 12 }, (_, n) => [`*** Add File: f${n}.ts`, `+export const v${n} = ${n}`]).flat(), '*** End Patch'].join('\n');
    const { sent, fetchImpl } = judge(breaks(() => false));
    await checkInstructions('apply_patch', { patchText }, instructionDeps(fetchImpl, { files: { '/repo/AGENTS.md': many }, messages: ['Only change what I ask.'] }));
    const checks = sent.filter(body => body.state.instructions);
    expect(checks.every(body => Object.keys(body.questions).length <= 100)).toBe(true);
    expect(checks.every(body => body.state.instructions?.length === 20)).toBe(true);
    expect(checks[0]?.state.instructions?.at(-1)).toEqual({ from: 'user_messages[0]', text: 'Only change what I ask.' });
    expect(checks.flatMap(body => body.state.changes ?? []).map(change => change.path)).toHaveLength(10);
    expect(sent.filter(body => body.state.sentences).every(body => (body.state.sentences?.length ?? 0) <= 50)).toBe(true);
  });

  test('never checks node_modules or jevy-vet\'s own config, and skips with no instructions', async () => {
    const { sent, fetchImpl } = judge(breaks(() => true));
    expect(await checkInstructions('write', { filePath: '/repo/node_modules/x/index.js', content: 'x' }, instructionDeps(fetchImpl, { files: { '/repo/AGENTS.md': AGENTS } }))).toBeUndefined();
    expect(await checkInstructions('write', { filePath: '/home/u/.config/opencode/jevy-vet.jsonc', content: '{}' }, instructionDeps(fetchImpl, { files: { '/repo/AGENTS.md': AGENTS } }))).toBeUndefined();
    expect(await checkInstructions('write', { filePath: '/repo/a.ts', content: 'x' }, instructionDeps(fetchImpl))).toBeUndefined();
    expect(await checkInstructions('read', { filePath: '/repo/a.ts' }, instructionDeps(fetchImpl, { files: { '/repo/AGENTS.md': AGENTS } }))).toBeUndefined();
    expect(sent).toHaveLength(0);
  });

  test('skips quietly without a key or config, and logs once when TypeSafe fails', async () => {
    const { sent, fetchImpl } = judge(breaks(() => true));
    const files = { '/repo/AGENTS.md': AGENTS };
    expect(await checkInstructions('edit', edit, instructionDeps(fetchImpl, { files, settings: { key: '' } }))).toBeUndefined();
    const broken = instructionDeps(fetchImpl, { files, settings: { error: 'Could not read x.' } });
    expect(await checkInstructions('edit', edit, broken)).toBeUndefined();
    expect(broken.logs).toEqual([]);
    expect(sent).toHaveLength(0);
    const d = instructionDeps(() => Promise.reject(new Error('offline')), { files });
    expect(await checkInstructions('edit', edit, d)).toBeUndefined();
    expect(d.logs).toEqual(['TypeSafe request failed. No instruction note was added.']);
    const down = instructionDeps(() => Promise.resolve(jsonResponse({ error: 'down' }, 503)), { files, cache: new Map([['file\nDo not change `src/api.ts` signatures.', true]]) });
    expect(await checkInstructions('edit', edit, down)).toBeUndefined();
    expect(down.logs).toEqual(['TypeSafe returned 503. No instruction note was added.']);
  });

  test('lists at most five warnings', async () => {
    const many = Array.from({ length: 8 }, (_, n) => `- Do not edit module${n}.`).join('\n');
    const { fetchImpl } = judge(breaks(() => true));
    const note = await checkInstructions('edit', edit, instructionDeps(fetchImpl, { files: { '/repo/AGENTS.md': many } }));
    expect(note?.split('\n').filter(line => line.startsWith('- '))).toHaveLength(6);
    expect(note).toContain('- and 3 more');
  });

  test('leaves early classification off by default', () => {
    expect(CLASSIFY_ON_MESSAGE).toBe(false);
  });

  test('skips a file rule that does not name this change', async () => {
    const cases = [
      { rule: '- Do not add another export to `src/index.ts`.', file: '/repo/src/jev.ts', ask: false },
      { rule: '- Do not add another export to `src/index.ts`.', file: '/repo/src/index.ts', ask: true },
      { rule: '- Do not edit `./src/index.ts`.', file: '/repo/src/index.ts', ask: true },
      { rule: '- Do not edit `index.ts`.', file: '/repo/src/index.ts', ask: true },
      { rule: '- Do not edit `index.ts`.', file: '/repo/src/notindex.ts', ask: false },
      { rule: '- Do not edit `src/index.ts` or `src/jev.ts`.', file: '/repo/src/jev.ts', ask: true },
      { rule: '- Never touch the billing code.', file: '/repo/src/jev.ts', ask: true },
      { rule: '- Do not edit `src/`.', file: '/repo/src/jev.ts', ask: true },
      { rule: '- Do not edit `other/`.', file: '/repo/src/jev.ts', ask: false },
    ];
    for (const item of cases) {
      const { sent, fetchImpl } = judge(breaks(() => true));
      const note = await checkInstructions('edit', { filePath: item.file, oldString: 'a', newString: 'b' }, instructionDeps(fetchImpl, { files: { '/repo/AGENTS.md': item.rule } }));
      const questions = sent[1]?.questions ?? {};
      expect({ file: item.file, rule: item.rule, asked: 'c0_i0_breaks' in questions }).toEqual({ file: item.file, rule: item.rule, asked: item.ask });
      if (item.ask) expect(note).toContain(`may break "${item.rule.slice(2)}"`);
      else {
        expect(note).toBeUndefined();
        expect(Object.keys(questions)).toEqual([]);
        expect(sent[1]?.state.changes).toEqual([{ path: item.file, new: 'b' }]);
      }
    }
  });

  test('asks the rule that names no file when another rule names a different file', async () => {
    const { sent, fetchImpl } = judge(breaks(() => true));
    const files = { '/repo/AGENTS.md': '- Do not edit `src/index.ts`.\n- Never touch the billing code.' };
    const note = await checkInstructions('edit', { filePath: '/repo/src/billing.ts', oldString: 'a', newString: 'b' }, instructionDeps(fetchImpl, { files }));
    expect(Object.keys(sent[1]?.questions ?? {})).toEqual(['c0_i1_breaks']);
    expect(note).toContain('may break "Never touch the billing code."');
    expect(note).not.toContain('src/index.ts');
  });

  const EARLY_MESSAGES = ['Do not change `src/api.ts` signatures.'];
  const EARLY_SETTINGS: Settings = { key: 'ts_secret', baseUrl: '', path: '/cfg' };

  // Deps share one cache and one in-flight map, so early work is awaited, not asked again.
  function warmingDeps(fetchImpl: ReviewDeps['fetch'], cache: Map<string, boolean>, files?: Record<string, string>) {
    const sentenceInflight = new Map<string, Promise<void>>();
    const wired = (withFiles?: Record<string, string>) => {
      const used = instructionDeps(fetchImpl, { messages: EARLY_MESSAGES, cache, files: withFiles });
      used.sentenceInflight = sentenceInflight;
      return used;
    };
    return { early: wired(), later: wired(files), settings: EARLY_SETTINGS };
  }

  test('uses sentences classified early instead of asking again', async () => {
    const { sent, fetchImpl } = judge(breaks(rule => rule.includes('signatures')));
    const cache = new Map<string, boolean>();
    const { early, later, settings } = warmingDeps(fetchImpl, cache, { '/repo/AGENTS.md': AGENTS });
    await startSentenceClassification(userSentences(EARLY_MESSAGES), early, settings);
    const note = await checkInstructions('edit', edit, later);
    expect(note).toContain('may break an instruction');
    const asked = sent.flatMap(body => body.state.sentences ?? []).filter(item => item.from === 'user_messages[0]');
    expect(asked).toHaveLength(1);
  });

  test('awaits an early classification instead of asking twice', async () => {
    let release!: (response: Response) => void;
    const held = new Promise<Response>(resolve => {
      release = resolve;
    });
    let calls = 0;
    const bodies: { state: { sentences?: { from: string; text: string }[] }; questions: Record<string, unknown> }[] = [];
    const fetchImpl: ReviewDeps['fetch'] = (_url, init) => {
      calls += 1;
      const body = JSON.parse(String(init.body)) as (typeof bodies)[number];
      bodies.push(body);
      if (calls === 1) return held;
      // Rule check, asked after the sentences arrive.
      const answers: Record<string, unknown> = {};
      for (const id of Object.keys(body.questions)) answers[id] = { type: 'noul', noul: id.endsWith('_lifted') ? 0.1 : 0.9 };
      return Promise.resolve(jsonResponse({ model: 'jev-latest', answers }));
    };
    const cache = new Map<string, boolean>();
    const { early, later, settings } = warmingDeps(fetchImpl, cache);
    const warming = startSentenceClassification(userSentences(EARLY_MESSAGES), early, settings);
    const checking = checkInstructions('edit', edit, later);
    // The check waits on the early request. No second sentence fetch.
    await Promise.resolve();
    await Promise.resolve();
    expect(calls).toBe(1);
    release(jsonResponse({ model: 'jev-latest', answers: { s0_limits: { type: 'noul', noul: 0.95 }, s0_style: { type: 'noul', noul: 0.05 } } }));
    await warming;
    const note = await checking;
    expect(calls).toBe(2);
    expect(bodies.filter(body => body.state.sentences)).toHaveLength(1);
    expect(note).toContain('may break "Do not change `src/api.ts` signatures."');
  });
});
