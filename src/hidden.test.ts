import { describe, expect, test } from 'bun:test';
import { deps, jsonResponse, memoryDisk } from './fakes.test.ts';
import { checkHiddenErrors } from './hidden.ts';
import { type Settings } from './settings.ts';

describe('hidden-error check', () => {
  const LOAD = 'export function load(path: string): Config {\n  return JSON.parse(readFileSync(path, \'utf8\'));\n}\n';
  const project = { '/repo/src/config.ts': LOAD };
  const swallow = {
    filePath: '/repo/src/config.ts',
    oldString: '  return JSON.parse(readFileSync(path, \'utf8\'));',
    newString: '  try {\n    return JSON.parse(readFileSync(path, \'utf8\'));\n  } catch {\n    return {};\n  }',
  };
  const sure = { type: 'noul', noul: 0.9, confidence: 0.9 };

  interface HiddenBody {
    state: { purpose: string; user_messages?: string[]; last_failure?: { command: string; output: string }; changes: { path: string; function: string; old?: string; new: string }[] };
    questions: Record<string, { type: string; instructions: string; criteria: { true: string; false: string } }>;
  }

  function run(tool: string, args: unknown, answers: Record<string, unknown>, options: { files?: Record<string, string>; userMessages?: string[]; lastFailure?: { command: string; output: string }; settings?: Partial<Settings>; fail?: boolean } = {}) {
    const bodies: HiddenBody[] = [];
    const { disk } = memoryDisk(options.files ?? project);
    const used = deps((_url, init) => {
      bodies.push(JSON.parse(String(init.body)) as HiddenBody);
      if (options.fail) return Promise.reject(new Error('offline'));
      return Promise.resolve(jsonResponse({ answers }));
    }, options.settings ?? { key: 'ts_secret' }, disk);
    return { result: checkHiddenErrors(tool, args, { ...used, userMessages: options.userMessages, lastFailure: options.lastFailure }), bodies, used };
  }

  test('asks one question per source change that handles or drops an error, with comments kept and the last failure', async () => {
    const failure = { command: 'bun test', output: 'SyntaxError: Unexpected token' };
    const withComment = { ...swallow, newString: `  // A broken file must not stop startup.\n${swallow.newString}` };
    const asked = run('edit', withComment, {}, { lastFailure: failure });
    expect(await asked.result).toBeUndefined();
    expect(asked.bodies).toHaveLength(1);
    const body = asked.bodies[0];
    expect(body?.state.changes).toEqual([{ path: 'src/config.ts', function: 'function "load"', old: swallow.oldString, new: withComment.newString }]);
    expect(body?.state.last_failure).toEqual(failure);
    expect(body?.state.user_messages).toBeUndefined();
    expect(body?.questions).toEqual({
      x0_hides_error: {
        type: 'noul',
        instructions: 'Does the change in `changes[0]` hide a failure instead of handling it, so an error that should stop the code or reach the caller now passes silently?',
        criteria: {
          true: 'It swallows an exception with an empty or log-only catch and goes on as if it worked, catches broadly and returns a default or a fake success, adds `?.`, `??`, or `|| []` to silence a crash that `last_failure` or a test showed, removes a throw or an error return, ignores a returned error (for example Go `_ = err`, or Rust `let _ =` or `unwrap_or_default()`), or turns an error into a warning.',
          false: 'The error is rethrown or wrapped with context, handled by a real recovery the caller expects, part of documented best-effort code such as cleanup, telemetry, or an optional feature, or logged and still reported to the caller.',
        },
      },
    });
  });

  test('notes only when sure, with the lines that hide it', async () => {
    expect(await run('edit', swallow, { x0_hides_error: sure }).result).toBe([
      'Jevy note: this change was made, but it may hide an error instead of handling it.',
      '- src/config.ts, function "load"',
      '  Hidden error: The change lets a failure pass silently instead of handling it or reporting it.',
      '  now: } catch {',
      '  next: Let the error fail loudly or reach the caller, or handle it for real. If hiding it is meant, ask the user.',
      'Check it, and fix it if the note is right.',
    ].join('\n'));
    expect(await run('edit', swallow, { x0_hides_error: { type: 'noul', noul: 0.7 } }).result).toBeUndefined();
    expect(await run('edit', swallow, { x0_hides_error: { type: 'noul', noul: 0.9, confidence: 0.5 } }).result).toBeUndefined();
  });

  test('asks about a removed error return, and shows the old line', async () => {
    const files = { '/repo/src/check.go': 'func check(v int) error {\n\tif v < 0 {\n\t\treturn err\n\t}\n\treturn nil\n}\n' };
    const result = await run('edit', { filePath: '/repo/src/check.go', oldString: '\t\treturn err', newString: '\t\treturn nil' }, { x0_hides_error: sure }, { files }).result;
    expect(result).toContain('- src/check.go, function "check"');
    expect(result).toContain('  was: return err\n  next:');
  });

  test('makes no call for a change that touches no error handling, for tests, helpers, generated code, or without a key', async () => {
    const plain = run('edit', { ...swallow, newString: '  return parse(readFileSync(path, \'utf8\'));' }, {});
    expect(await plain.result).toBeUndefined();
    expect(plain.bodies).toHaveLength(0);
    const content = 'try { run() } catch { return [] }';
    for (const filePath of ['/repo/src/config.test.ts', '/repo/src/__mocks__/config.ts', '/repo/src/testUtils.ts', '/repo/src/api.gen.ts', '/repo/node_modules/x/index.js']) {
      const skipped = run('write', { filePath, content }, {});
      expect(await skipped.result).toBeUndefined();
      expect(skipped.bodies).toHaveLength(0);
    }
    const generated = run('write', { filePath: '/repo/src/api.ts', content: `// Code generated by x. DO NOT EDIT.\n${content}` }, {});
    expect(await generated.result).toBeUndefined();
    expect(generated.bodies).toHaveLength(0);
    const noKey = run('edit', swallow, { x0_hides_error: sure }, { settings: { key: '' } });
    expect(await noKey.result).toBeUndefined();
    expect(noKey.bodies).toHaveLength(0);
  });

  test('drops the note when the user asked to let the error pass, with the shared user-intent question', async () => {
    const asked = run('edit', swallow, { x0_hides_error: sure, x0_user_asked: { type: 'noul', noul: 0.6 } }, { userMessages: ['If the config is broken, just use defaults.'] });
    expect(await asked.result).toBeUndefined();
    expect(asked.bodies[0]?.questions.x0_user_asked?.criteria.true).toBe('The user asks to ignore, suppress, or silence this error, or to make the code keep going when it fails.');
    expect(asked.used.logs).toEqual(['src/config.ts: the user asked to let this error pass. No hidden-error note was added.']);
  });

  test('adds nothing when TypeSafe fails', async () => {
    const failing = run('edit', swallow, {}, { fail: true });
    expect(await failing.result).toBeUndefined();
    expect(failing.used.logs).toEqual(['TypeSafe request failed. No hidden-error note was added.']);
  });
});
