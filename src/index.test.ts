import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'bun:test';
import plugin from './index.ts';

const USEFUL = 'test(\'adds\', () => { expect(add(1, 2)).toBe(3) })';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

function allowBody() {
  const answer = { type: 'noul', noul: 0.1 };
  return {
    model: 'jev-latest',
    answers: {
      t0_title_mismatch: answer,
      t0_passes_on_empty: answer,
    },
  };
}

interface LogBody {
  service: string;
  level: 'debug' | 'info' | 'warn' | 'error';
  message: string;
}

type Hooks = Awaited<ReturnType<typeof plugin>>;
type PluginLog = (input: { body: LogBody }) => Promise<unknown>;
type FakeFetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

async function usingPlugin(
  config: string | undefined,
  fetchImpl: FakeFetch,
  run: (hooks: Hooks) => Promise<void>,
  log: PluginLog = () => Promise.resolve(undefined),
  directory?: string,
) {
  const root = mkdtempSync(join(tmpdir(), 'jevy-vet-'));
  const savedXdg = process.env.XDG_CONFIG_HOME;
  const savedFetch = globalThis.fetch;
  process.env.XDG_CONFIG_HOME = root;
  if (config !== undefined) {
    const dir = join(root, 'opencode');
    mkdirSync(dir);
    writeFileSync(join(dir, 'jevy-vet.jsonc'), config);
  }
  globalThis.fetch = fetchImpl as typeof fetch;
  try {
    await run(await plugin({ directory: directory ?? join(root, 'project'), client: { app: { log } } }));
  } finally {
    if (savedXdg === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = savedXdg;
    globalThis.fetch = savedFetch;
    rmSync(root, { recursive: true, force: true });
  }
}

function before(hooks: Hooks, tool: string, args: unknown) {
  const input: { tool: string; sessionID: string; callID: string } = { tool, sessionID: 's', callID: 'c' };
  return hooks['tool.execute.before'](input, { args });
}

describe('plugin', () => {
  test('exports only the plugin function', async () => {
    const mod = await import('./index.ts');
    const values = Object.values(mod);
    expect(values).toHaveLength(1);
    expect(typeof values[0]).toBe('function');
    expect(values[0]).toBe(plugin);
  });

  test('throws the block reason from the hook and ignores the environment', async () => {
    const previous = process.env.TYPESAFE_API_KEY;
    process.env.TYPESAFE_API_KEY = 'ts_from_env';
    try {
      await usingPlugin(undefined, () => Promise.resolve(jsonResponse(allowBody())), async hooks => {
        await expect(before(hooks, 'write', { filePath: 'src/foo.test.ts', content: USEFUL }))
          .rejects.toThrow('TYPESAFE_API_KEY is not set');
      });
    } finally {
      if (previous === undefined) delete process.env.TYPESAFE_API_KEY;
      else process.env.TYPESAFE_API_KEY = previous;
    }
  });

  test('blocks write, edit, and apply_patch when Jev is sure', async () => {
    let url = '';
    let auth = '';
    const bodies: string[] = [];
    const fetchImpl: FakeFetch = (input, init) => {
      url = String(input);
      auth = new Headers(init?.headers).get('Authorization') ?? '';
      bodies.push(String(init?.body));
      return Promise.resolve(jsonResponse({
        answers: { t0_passes_on_empty: { noul: 0.91 } },
      }));
    };
    const sure = 'It would still pass if the code returned null, an empty value, or zero.';
    await usingPlugin('{ "TYPESAFE_API_KEY": "ts_secret", "TYPESAFE_BASE_URL": "https://jev.example/" }', fetchImpl, async hooks => {
      await expect(before(hooks, 'write', { filePath: 'src/foo.test.ts', content: 'expect(x).toBeDefined()' }))
        .rejects.toThrow(`src/foo.test.ts (test 1): ${sure}`);
      await expect(before(hooks, 'edit', {
        filePath: 'src/bar.test.ts',
        oldString: 'OLD_NOT_JUDGED',
        newString: 'expect(x).toBeDefined()',
      })).rejects.toThrow(`src/bar.test.ts (test 1): ${sure}`);
      const patch = ['*** Begin Patch', '*** Add File: src/bad.test.ts', '+expect(x).toBeDefined()', '*** End Patch'].join('\n');
      await expect(before(hooks, 'apply_patch', { patchText: patch }))
        .rejects.toThrow(`src/bad.test.ts (test 1): ${sure}`);
    });
    expect(url).toBe('https://jev.example/v1/systemone');
    expect(auth).toBe('Bearer ts_secret');
    // write, edit (new-test request and edit request), apply_patch.
    expect(bodies).toHaveLength(4);
    expect(bodies.join('\n')).toContain('src/bad.test.ts');
    expect(bodies.join('\n')).not.toContain('ts_secret');
    expect(bodies.filter(body => body.includes('"files"')).join('\n')).not.toContain('OLD_NOT_JUDGED');
  });

  test('allows a passing test and skips a non-test write', async () => {
    let called = 0;
    const fetchImpl: FakeFetch = () => {
      called += 1;
      return Promise.resolve(jsonResponse(allowBody()));
    };
    await usingPlugin('{ "TYPESAFE_API_KEY": "ts_secret" }', fetchImpl, async hooks => {
      await expect(before(hooks, 'write', { filePath: 'src/foo.test.ts', content: USEFUL })).resolves.toBeUndefined();
      await expect(before(hooks, 'write', { filePath: 'src/foo.ts', content: USEFUL })).resolves.toBeUndefined();
    });
    expect(called).toBe(1);
  });

  test('allows a TypeSafe failure and logs a warning', async () => {
    const logs: LogBody[] = [];
    const log: PluginLog = input => {
      logs.push(input.body);
      return Promise.resolve(undefined);
    };
    await usingPlugin('{ "TYPESAFE_API_KEY": "ts_secret" }', () => Promise.resolve(jsonResponse({ error: 'down' }, 503)), async hooks => {
      await expect(before(hooks, 'write', { filePath: 'src/foo.test.ts', content: USEFUL })).resolves.toBeUndefined();
    }, log);
    expect(logs).toEqual([{
      service: 'jevy-vet',
      level: 'warn',
      message: 'TypeSafe returned 503. The test write was allowed.',
    }]);

    logs.length = 0;
    await usingPlugin('{ "TYPESAFE_API_KEY": "ts_secret" }', () => Promise.reject(new Error('network')), async hooks => {
      await expect(before(hooks, 'edit', { filePath: 'src/foo.test.ts', oldString: 'old', newString: USEFUL }))
        .resolves.toBeUndefined();
    }, log);
    expect(logs).toEqual([{
      service: 'jevy-vet',
      level: 'warn',
      message: 'TypeSafe request failed. The test write was allowed.',
    }]);
  });

  test('blocks one bad test in a file of several', async () => {
    const mocked = 'test(\'calls the mock\', () => { expect(spy).toHaveBeenCalled() })';
    const adds = 'test(\'adds\', () => { expect(add(1, 2)).toBe(3) })';
    let body = '';
    const fetchImpl: FakeFetch = (_input, init) => {
      body = String(init?.body);
      return Promise.resolve(jsonResponse({
        answers: { t0_passes_on_empty: { noul: 0.91 } },
      }));
    };
    await usingPlugin('{ "TYPESAFE_API_KEY": "ts_secret" }', fetchImpl, async hooks => {
      await expect(before(hooks, 'write', { filePath: 'src/mixed.test.ts', content: [mocked, adds].join('\n') }))
        .rejects.toThrow('src/mixed.test.ts (test "calls the mock"): It would still pass if the code returned null, an empty value, or zero.');
    });
    const parsed = JSON.parse(body) as { state: { files: { cases: { test: string }[] }[] } };
    expect(parsed.state.files[0].cases.map(item => item.test)).toEqual([mocked, adds]);
    expect(body).not.toContain('ts_secret');
  });

  test('reads the code under test from the project folder only', async () => {
    const project = mkdtempSync(join(tmpdir(), 'jevy-vet-project-'));
    const outside = mkdtempSync(join(tmpdir(), 'jevy-vet-outside-'));
    let body = '';
    try {
      mkdirSync(join(project, 'src'));
      writeFileSync(join(project, 'src', 'math.ts'), 'export function add(a: number, b: number) { return a + b }');
      writeFileSync(join(outside, 'secret.ts'), 'export const SECRET_OUTSIDE = 1');
      const rel = join('..', '..', outside.slice(outside.lastIndexOf('/') + 1), 'secret');
      const content = [`import { add } from './math';`, `import { SECRET_OUTSIDE } from '${rel}';`, USEFUL].join('\n');
      const fetchImpl: FakeFetch = (_input, init) => {
        body = String(init?.body);
        return Promise.resolve(jsonResponse(allowBody()));
      };
      await usingPlugin('{ "TYPESAFE_API_KEY": "ts_secret" }', fetchImpl, async hooks => {
        await expect(before(hooks, 'write', { filePath: join(project, 'src', 'math.test.ts'), content })).resolves.toBeUndefined();
      }, undefined, project);
    } finally {
      rmSync(project, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
    const parsed = JSON.parse(body) as { state: { files: { code_under_test: { path: string; text: string; truncated: boolean }[] }[] } };
    expect(parsed.state.files[0].code_under_test).toEqual([
      { path: 'src/math.ts', text: 'export function add(a: number, b: number) { return a + b }', truncated: false },
    ]);
    expect(body).not.toContain('export const SECRET_OUTSIDE');
  });

  test('sends the user\'s latest real messages with a test edit, but not a subagent\'s prompt', async () => {
    const project = mkdtempSync(join(tmpdir(), 'jevy-vet-project-'));
    const bodies: string[] = [];
    const fetchImpl: FakeFetch = (_input, init) => {
      bodies.push(String(init?.body));
      return Promise.resolve(jsonResponse({ answers: {} }));
    };
    const edit = { filePath: join(project, 'a.test.ts'), oldString: 'expect(add(1, 2)).toBe(3)', newString: 'expect(add(1, 2)).toBe(4)' };
    const editBodies = () => bodies.filter(body => body.includes('"edits"')).map(body => JSON.parse(body) as { state: { user_messages?: string[] } });
    try {
      writeFileSync(join(project, 'a.test.ts'), 'test(\'adds\', () => {\n  expect(add(1, 2)).toBe(3)\n})');
      await usingPlugin('{ "TYPESAFE_API_KEY": "ts_secret" }', fetchImpl, async hooks => {
        for (const text of ['one', 'two', 'three', 'Change add so 1 + 2 is 4.']) {
          await hooks['chat.message']({ sessionID: 's' }, { parts: [{ type: 'text', text }, { type: 'text', text: 'hint', synthetic: true }, { type: 'text', text: 'IGNORED_PART', ignored: true }, { type: 'file', text: 'FILE_PART' }] });
        }
        await hooks['chat.message']({ sessionID: 'child' }, { parts: [{ type: 'text', text: 'Update the expected value.' }] });
        await hooks.event({ event: { type: 'session.created', properties: { info: { id: 'child', parentID: 's' } } } });
        await before(hooks, 'edit', edit);
        await hooks['tool.execute.before']({ tool: 'edit', sessionID: 'child' }, { args: edit });
        await hooks['tool.execute.before']({ tool: 'edit', sessionID: 'other' }, { args: edit });
      }, undefined, project);
    } finally {
      rmSync(project, { recursive: true, force: true });
    }
    expect(editBodies().map(body => body.state.user_messages)).toEqual([['two', 'three', 'Change add so 1 + 2 is 4.'], undefined, undefined]);
    expect(bodies.join('\n')).not.toContain('hint');
    expect(bodies.join('\n')).not.toContain('IGNORED_PART');
    expect(bodies.join('\n')).not.toContain('FILE_PART');
  });

  test('still allows the write when logging fails', async () => {
    const down: FakeFetch = () => Promise.resolve(jsonResponse({ error: 'down' }, 503));
    const args = { filePath: 'src/foo.test.ts', content: USEFUL };
    await usingPlugin('{ "TYPESAFE_API_KEY": "ts_secret" }', down, async hooks => {
      await expect(before(hooks, 'write', args)).resolves.toBeUndefined();
    }, () => {
      throw new Error('log down');
    });
    await usingPlugin('{ "TYPESAFE_API_KEY": "ts_secret" }', down, async hooks => {
      await expect(before(hooks, 'write', args)).resolves.toBeUndefined();
    }, () => Promise.reject(new Error('log down')));
  });
});
