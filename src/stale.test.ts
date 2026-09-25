import { describe, expect, test } from 'bun:test';
import { deps, jsonResponse, treeDisk } from './fakes.test.ts';
import { type Settings } from './settings.ts';
import { checkStaleDocs } from './stale.ts';

describe('stale-comment check', () => {
  const RETRY = '/**\n * Retries the call up to 3 times.\n */\nexport function retry(call: () => void): void {\n  for (let i = 0; i < 3; i += 1) {\n    try {\n      return call();\n    } catch {\n      // Try again.\n    }\n  }\n  throw new Error(\'failed\');\n}\n';
  const project = {
    '/repo/src/retry.ts': RETRY,
    '/repo/README.md': '# x\n\n## Retry\n\nCall `retry` to run a call up to 3 times.\n',
    '/repo/AGENTS.md': 'Keep `retry` at 3 tries.\n',
    '/repo/CHANGELOG.md': '- `retry` tries 3 times.\n',
  };
  const more = { filePath: '/repo/src/retry.ts', oldString: '  for (let i = 0; i < 3; i += 1) {', newString: '  for (let i = 0; i < 5; i += 1) {' };
  const sure = { type: 'noul', noul: 0.9, confidence: 0.9 };

  interface StaleBody {
    state: { purpose: string; user_messages?: string[]; changes: { path: string; function: string; old?: string; new: string }[]; comments: { change: number; path: string; line?: number; text: string; edited?: true; doc?: true }[] };
    questions: Record<string, { type: string; instructions: string; criteria: { true: string; false: string } }>;
  }

  function run(tool: string, args: unknown, answers: Record<string, unknown>, options: { files?: Record<string, string>; userMessages?: string[]; settings?: Partial<Settings>; fail?: boolean } = {}) {
    const bodies: StaleBody[] = [];
    const { disk } = treeDisk(options.files ?? project);
    const used = deps((_url, init) => {
      bodies.push(JSON.parse(String(init.body)) as StaleBody);
      if (options.fail) return Promise.reject(new Error('offline'));
      return Promise.resolve(jsonResponse({ answers }));
    }, options.settings ?? { key: 'ts_secret' }, disk);
    return { result: checkStaleDocs(tool, args, { ...used, userMessages: options.userMessages }), bodies, used };
  }

  test('asks one question per comment on the changed function and per doc section that names it', async () => {
    const asked = run('edit', more, {});
    expect(await asked.result).toBeUndefined();
    expect(asked.bodies).toHaveLength(1);
    const body = asked.bodies[0];
    expect(body?.state.changes).toEqual([{ path: 'src/retry.ts', function: 'function "retry"', old: more.oldString, new: more.newString }]);
    expect(body?.state.comments).toEqual([
      { change: 0, path: 'src/retry.ts', line: 2, text: '/**\n * Retries the call up to 3 times.\n */' },
      { change: 0, path: 'src/retry.ts', line: 9, text: '      // Try again.' },
      { change: 0, path: 'README.md', line: 5, text: '## Retry\n\nCall `retry` to run a call up to 3 times.', doc: true },
    ]);
    expect(body?.state.user_messages).toBeUndefined();
    expect(body?.questions.c0_stale).toEqual({
      type: 'noul',
      instructions: 'Is the comment or doc in `comments[0]` wrong about the code after the change in `changes[0]`?',
      criteria: {
        true: 'It states a parameter, return value, error, default, or behavior that the changed code no longer has, or, when `edited` is true, it claims something the code does not do.',
        false: 'It is still true of the new code, is vague enough to stay true, was updated in the same change to match, or is about code the change did not touch.',
      },
    });
    expect(Object.keys(body?.questions ?? {})).toEqual(['c0_stale', 'c1_stale', 'c2_stale']);
  });

  test('notes only when sure, with the comment line and the changed line', async () => {
    expect(await run('edit', more, { c0_stale: sure, c2_stale: sure }).result).toBe([
      'Jevy note: this change was made, but a comment or doc may no longer match it.',
      '- src/retry.ts, function "retry"',
      '  Stale comment: A comment or doc says something the changed code no longer does.',
      '  comment: src/retry.ts:2 * Retries the call up to 3 times.',
      '  code: src/retry.ts:5 for (let i = 0; i < 5; i += 1) {',
      '  next: Update the comment or doc to match the new code. If the code is what is wrong, fix it or ask the user.',
      '- src/retry.ts, function "retry"',
      '  Stale comment: A comment or doc says something the changed code no longer does.',
      '  doc: README.md:5 Call `retry` to run a call up to 3 times.',
      '  code: src/retry.ts:5 for (let i = 0; i < 5; i += 1) {',
      '  next: Update the comment or doc to match the new code. If the code is what is wrong, fix it or ask the user.',
      'Check it, and fix it if the note is right.',
    ].join('\n'));
    expect(await run('edit', more, { c0_stale: { type: 'noul', noul: 0.7 } }).result).toBeUndefined();
    expect(await run('edit', more, { c0_stale: { type: 'noul', noul: 0.9, confidence: 0.5 } }).result).toBeUndefined();
  });

  test('leaves out docs the same call changes', async () => {
    const both = run('apply_patch', { patchText: '*** Begin Patch\n*** Update File: src/retry.ts\n@@\n-  for (let i = 0; i < 3; i += 1) {\n+  for (let i = 0; i < 5; i += 1) {\n*** Update File: README.md\n@@\n-Call `retry` to run a call up to 3 times.\n+Call `retry` to run a call up to 5 times.\n*** End Patch' }, {});
    await both.result;
    expect(both.bodies[0]?.state.comments.map(item => item.path)).toEqual(['src/retry.ts', 'src/retry.ts']);
  });

  test('checks a comment the change wrote against the code, and shows the old line for a removed one', async () => {
    const files = { '/repo/src/total.py': 'def total(items):\n    return sum(items)\n' };
    const claimed = run('edit', { filePath: '/repo/src/total.py', oldString: 'def total(items):\n', newString: 'def total(items):\n    """Skips negative items."""\n' }, { c0_stale: sure }, { files });
    const result = await claimed.result;
    expect(claimed.bodies[0]?.state.comments).toEqual([{ change: 0, path: 'src/total.py', line: 2, text: '    """Skips negative items."""', edited: true }]);
    expect(result).toContain('  comment: src/total.py:2 """Skips negative items."""\n  code: src/total.py:1 def total(items):\n');
    const go = { '/repo/src/check.go': '// check fails on a negative value.\nfunc check(v int) error {\n\tif v < 0 {\n\t\treturn errNegative\n\t}\n\treturn nil\n}\n' };
    const removed = await run('edit', { filePath: '/repo/src/check.go', oldString: '\tif v < 0 {\n\t\treturn errNegative\n\t}\n', newString: '' }, { c0_stale: sure }, { files: go }).result;
    expect(removed).toContain('  comment: src/check.go:1 // check fails on a negative value.\n  was: if v < 0 {\n');
  });

  test('makes no call without a comment or doc, for a comment-free change, for tests, helpers, generated code, or without a key', async () => {
    const bare = { '/repo/src/add.ts': 'export function add(a: number, b: number): number {\n  return a + b;\n}\n' };
    const plain = run('edit', { filePath: '/repo/src/add.ts', oldString: '  return a + b;', newString: '  return b + a;' }, {}, { files: bare });
    expect(await plain.result).toBeUndefined();
    expect(plain.bodies).toHaveLength(0);
    const blank = run('edit', { ...more, newString: `${more.oldString}\n` }, {});
    expect(await blank.result).toBeUndefined();
    expect(blank.bodies).toHaveLength(0);
    const content = '// Adds one.\nexport function add(a: number): number {\n  return a + 2;\n}\n';
    for (const filePath of ['/repo/src/add.test.ts', '/repo/src/__mocks__/add.ts', '/repo/src/testUtils.ts', '/repo/src/api.gen.ts', '/repo/node_modules/x/index.js']) {
      const skipped = run('write', { filePath, content }, {});
      expect(await skipped.result).toBeUndefined();
      expect(skipped.bodies).toHaveLength(0);
    }
    const generated = run('write', { filePath: '/repo/src/api.ts', content: `// Code generated by x. DO NOT EDIT.\n${content}` }, {});
    expect(await generated.result).toBeUndefined();
    expect(generated.bodies).toHaveLength(0);
    const noKey = run('edit', more, { c0_stale: sure }, { settings: { key: '' } });
    expect(await noKey.result).toBeUndefined();
    expect(noKey.bodies).toHaveLength(0);
  });

  test('drops the note when the user asked to leave the comments, with the shared user-intent question', async () => {
    const asked = run('edit', more, { c0_stale: sure, x0_user_asked: { type: 'noul', noul: 0.6 } }, { userMessages: ['Just bump retry to 5, leave the docs.'] });
    expect(await asked.result).toBeUndefined();
    expect(asked.bodies[0]?.questions.x0_user_asked?.instructions).toBe('Do the user\'s messages in `user_messages` ask for the change in `changes[0]` without updating its comments or docs?');
    expect(asked.bodies[0]?.questions.x0_user_asked?.criteria.true).toBe('The user asks to change only the code and leave the comments or docs as they are, or asks for the comment as written.');
    expect(asked.used.logs).toEqual(['src/retry.ts: the user asked to leave the comments as they are. No stale-comment note was added.']);
  });

  test('adds nothing when TypeSafe fails', async () => {
    const failing = run('edit', more, {}, { fail: true });
    expect(await failing.result).toBeUndefined();
    expect(failing.used.logs).toEqual(['TypeSafe request failed. No stale-comment note was added.']);
  });
});
