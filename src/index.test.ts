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
  const answer = { type: 'noul', noul: 0.1, confidence: 0.9 };
  return {
    model: 'jev-latest',
    answers: {
      t0_no_visible_result: answer,
      t0_copied_expectation: answer,
      t0_trivial: answer,
      t0_no_behavior: answer,
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

async function usingPlugin(
  config: string | undefined,
  fetchImpl: typeof fetch,
  run: (hooks: Hooks) => Promise<void>,
  log: PluginLog = () => Promise.resolve(undefined),
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
  globalThis.fetch = fetchImpl;
  try {
    await run(await plugin({ client: { app: { log } } }));
  } finally {
    if (savedXdg === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = savedXdg;
    globalThis.fetch = savedFetch;
    rmSync(root, { recursive: true, force: true });
  }
}

function before(hooks: Hooks, tool: string, args: unknown) {
  return hooks['tool.execute.before']({ tool, sessionID: 's', callID: 'c' }, { args });
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
    const fetchImpl: typeof fetch = (input, init) => {
      url = String(input);
      auth = new Headers(init?.headers).get('Authorization') ?? '';
      bodies.push(String(init?.body));
      return Promise.resolve(jsonResponse({
        answers: { t0_no_visible_result: { noul: 0.91, confidence: 0.88 } },
      }));
    };
    const sure = 'It does not check a result a caller could see.';
    await usingPlugin('{ "TYPESAFE_API_KEY": "ts_secret", "TYPESAFE_BASE_URL": "https://jev.example/" }', fetchImpl, async hooks => {
      await expect(before(hooks, 'write', { filePath: 'src/foo.test.ts', content: 'expect(x).toBeDefined()' }))
        .rejects.toThrow(`src/foo.test.ts: ${sure}`);
      await expect(before(hooks, 'edit', {
        filePath: 'src/bar.test.ts',
        oldString: 'OLD_NOT_JUDGED',
        newString: 'expect(x).toBeDefined()',
      })).rejects.toThrow(`src/bar.test.ts: ${sure}`);
      const patch = ['*** Begin Patch', '*** Add File: src/bad.test.ts', '+expect(x).toBeDefined()', '*** End Patch'].join('\n');
      await expect(before(hooks, 'apply_patch', { patchText: patch }))
        .rejects.toThrow(`src/bad.test.ts: ${sure}`);
    });
    expect(url).toBe('https://jev.example/v1/systemone');
    expect(auth).toBe('Bearer ts_secret');
    expect(bodies).toHaveLength(3);
    expect(bodies.join('\n')).toContain('src/bad.test.ts');
    expect(bodies.join('\n')).not.toContain('ts_secret');
    expect(bodies.join('\n')).not.toContain('OLD_NOT_JUDGED');
  });

  test('allows a passing test and skips a non-test write', async () => {
    let called = 0;
    const fetchImpl: typeof fetch = () => {
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
    const fetchImpl: typeof fetch = (_input, init) => {
      body = String(init?.body);
      return Promise.resolve(jsonResponse({
        answers: { t0_no_visible_result: { noul: 0.91, confidence: 0.9 } },
      }));
    };
    await usingPlugin('{ "TYPESAFE_API_KEY": "ts_secret" }', fetchImpl, async hooks => {
      await expect(before(hooks, 'write', { filePath: 'src/mixed.test.ts', content: [mocked, adds].join('\n') }))
        .rejects.toThrow('src/mixed.test.ts: It does not check a result a caller could see.');
    });
    const parsed = JSON.parse(body) as { state: { tests: { text: string }[] } };
    expect(parsed.state.tests.map(item => item.text)).toEqual([mocked, adds]);
    expect(body).not.toContain('ts_secret');
  });

  test('still allows the write when logging fails', async () => {
    const down: typeof fetch = () => Promise.resolve(jsonResponse({ error: 'down' }, 503));
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
