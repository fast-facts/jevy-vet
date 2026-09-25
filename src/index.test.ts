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
  const savedHome = process.env.HOME;
  const savedFetch = globalThis.fetch;
  process.env.XDG_CONFIG_HOME = root;
  // So a real ~/.claude/CLAUDE.md on this machine is not read.
  process.env.HOME = root;
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
    if (savedHome === undefined) delete process.env.HOME;
    else process.env.HOME = savedHome;
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
        .rejects.toThrow(`src/foo.test.ts, test 1\n  Passes on an empty result: ${sure}`);
      await expect(before(hooks, 'edit', {
        filePath: 'src/bar.test.ts',
        oldString: 'OLD_NOT_JUDGED',
        newString: 'expect(x).toBeDefined()',
      })).rejects.toThrow(`src/bar.test.ts, test 1\n  Passes on an empty result: ${sure}`);
      const patch = ['*** Begin Patch', '*** Add File: src/bad.test.ts', '+expect(x).toBeDefined()', '*** End Patch'].join('\n');
      await expect(before(hooks, 'apply_patch', { patchText: patch }))
        .rejects.toThrow(`src/bad.test.ts, test 1\n  Passes on an empty result: ${sure}`);
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
        .rejects.toThrow('src/mixed.test.ts, test "calls the mock"\n  Passes on an empty result: It would still pass if the code returned null, an empty value, or zero.');
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

  describe('instruction notes', () => {
    interface Sent {
      state: { sentences?: { text: string }[]; instructions?: { from: string; text: string }[]; changes?: { path: string; old?: string; new: string }[]; user_messages?: string[] };
      questions: Record<string, unknown>;
    }
    // Every "Do not" sentence is a rule, and every change breaks every rule.
    function strict(sent: Sent[]): FakeFetch {
      return (_input, init) => {
        const body = JSON.parse(String(init?.body)) as Sent;
        sent.push(body);
        const answers: Record<string, unknown> = {};
        for (const id of Object.keys(body.questions)) {
          const n = Number(/^s(\d+)_/.exec(id)?.[1]);
          if (id.endsWith('_limits')) answers[id] = { type: 'noul', noul: /Do not/.test(body.state.sentences?.[n]?.text ?? '') ? 0.9 : 0.1 };
          else if (id.endsWith('_style')) answers[id] = { type: 'noul', noul: 0.1 };
          else if (id.endsWith('_breaks')) answers[id] = { type: 'noul', noul: 0.9 };
          else if (id.endsWith('_lifted')) answers[id] = { type: 'noul', noul: 0.1 };
        }
        return Promise.resolve(jsonResponse({ answers }));
      };
    }

    function withProject(files: Record<string, string>) {
      const project = mkdtempSync(join(tmpdir(), 'jevy-vet-project-'));
      for (const [path, text] of Object.entries(files)) {
        mkdirSync(join(project, path, '..'), { recursive: true });
        writeFileSync(join(project, path), text);
      }
      return project;
    }

    test('appends a note to the tool output for the same call, and never blocks', async () => {
      const project = withProject({ 'AGENTS.md': '- Do not edit src/api.ts.', 'src/api.ts': 'export const a = 1' });
      const sent: Sent[] = [];
      const args = { filePath: join(project, 'src/api.ts'), content: 'export const a = 2' };
      const outputs: { title: string; output: string; metadata: Record<string, unknown> }[] = [];
      try {
        await usingPlugin('{ "TYPESAFE_API_KEY": "ts_secret" }', strict(sent), async hooks => {
          await expect(before(hooks, 'write', args)).resolves.toBeUndefined();
          const other = { title: '', output: 'Wrote file', metadata: {} };
          await hooks['tool.execute.after']({ tool: 'write', sessionID: 's', callID: 'someone-else', args }, other);
          const mine = { title: '', output: 'Wrote file', metadata: {} };
          await hooks['tool.execute.after']({ tool: 'write', sessionID: 's', callID: 'c', args }, mine);
          const again = { title: '', output: 'Wrote file', metadata: {} };
          await hooks['tool.execute.after']({ tool: 'write', sessionID: 's', callID: 'c', args }, again);
          outputs.push(other, mine, again);
        }, undefined, project);
      } finally {
        rmSync(project, { recursive: true, force: true });
      }
      expect(outputs.map(output => output.output)).toEqual([
        'Wrote file',
        'Wrote file\n\nJevy note: this change was made, but it may break an instruction.\n- src/api.ts may break "Do not edit src/api.ts." (from AGENTS.md)\nCheck the change. If it does break the instruction, undo it or ask the user.',
        'Wrote file',
      ]);
      // The old text was read before the write.
      expect(sent[1]?.state.changes).toEqual([{ path: join(project, 'src/api.ts'), old: 'export const a = 1', new: 'export const a = 2' }]);
    });

    test('checks a subagent\'s edit against the parent session\'s user messages, and reads configured instruction files', async () => {
      const project = withProject({ 'docs/rules.md': '- Do not add dependencies.' });
      const sent: Sent[] = [];
      try {
        await usingPlugin('{ "TYPESAFE_API_KEY": "ts_secret" }', strict(sent), async hooks => {
          await hooks.config({ instructions: ['docs/*.md', 'https://example.com/rules.md', 42] });
          await hooks['chat.message']({ sessionID: 's' }, { parts: [{ type: 'text', text: 'Do not touch package.json.' }] });
          await hooks.event({ event: { type: 'session.created', properties: { info: { id: 'child', parentID: 's' } } } });
          await hooks['chat.message']({ sessionID: 'child' }, { parts: [{ type: 'text', text: 'Do not ask questions, just edit package.json.' }] });
          await hooks['tool.execute.before']({ tool: 'write', sessionID: 'child', callID: 'k' }, { args: { filePath: join(project, 'package.json'), content: '{}' } });
          const output = { title: '', output: 'ok', metadata: {} };
          await hooks['tool.execute.after']({ tool: 'write', sessionID: 'child', callID: 'k', args: {} }, output);
          expect(output.output).toContain('may break "Do not touch package.json." (from the user\'s message)');
          expect(output.output).toContain('may break "Do not add dependencies." (from docs/rules.md)');
        }, undefined, project);
      } finally {
        rmSync(project, { recursive: true, force: true });
      }
      const check = sent.find(body => body.state.instructions);
      expect(check?.state.user_messages).toEqual(['Do not touch package.json.']);
      expect(JSON.stringify(sent)).not.toContain('just edit package.json');
    });

    test('does nothing for a non-test write without a key, and nothing after a blocked write', async () => {
      const project = withProject({ 'AGENTS.md': '- Do not edit anything.' });
      const sent: Sent[] = [];
      try {
        await usingPlugin(undefined, strict(sent), async hooks => {
          await expect(before(hooks, 'write', { filePath: join(project, 'a.ts'), content: 'x' })).resolves.toBeUndefined();
          const output = { title: '', output: 'ok', metadata: {} };
          await hooks['tool.execute.after']({ tool: 'write', sessionID: 's', callID: 'c', args: {} }, output);
          expect(output.output).toBe('ok');
          await expect(before(hooks, 'write', { filePath: join(project, 'a.test.ts'), content: USEFUL })).rejects.toThrow('TYPESAFE_API_KEY is not set');
          await hooks['tool.execute.after']({ tool: 'write', sessionID: 's', callID: 'c', args: {} }, output);
          expect(output.output).toBe('ok');
        }, undefined, project);
      } finally {
        rmSync(project, { recursive: true, force: true });
      }
      expect(sent).toHaveLength(0);
    });
  });

  describe('unsure tests and user allows', () => {
    const WEAK = 'test(\'adds\', () => { expect(add(1, 2)).toBeDefined() })';

    // Blocks the weak test unless the user allowed it. allowScore answers the allow question.
    function judge(bodies: string[], score: number, allowScore = 0.9): FakeFetch {
      return (_input, init) => {
        const body = String(init?.body);
        bodies.push(body);
        if (body.includes('"blocks"')) return Promise.resolve(jsonResponse({ answers: { o0_user_allows: { type: 'noul', noul: allowScore } } }));
        return Promise.resolve(jsonResponse({ answers: { t0_passes_on_empty: { type: 'noul', noul: score } } }));
      };
    }
    const message = (text: string) => ({ parts: [{ type: 'text', text }] });

    test('adds a note for an unsure test to the output of the same call', async () => {
      const bodies: string[] = [];
      await usingPlugin('{ "TYPESAFE_API_KEY": "ts_secret" }', judge(bodies, 0.6), async hooks => {
        await expect(before(hooks, 'write', { filePath: 'src/a.test.ts', content: WEAK })).resolves.toBeUndefined();
        const output = { title: '', output: 'Wrote file', metadata: {} };
        await hooks['tool.execute.after']({ tool: 'write', sessionID: 's', callID: 'c', args: {} }, output);
        expect(output.output).toStartWith('Wrote file\n\nJevy note: this test change was made, but it may be weak.');
        expect(output.output).toContain('- src/a.test.ts, test "adds"');
      });
    });

    test('allows a blocked test after the user allows it, but not on a message from before the block', async () => {
      const bodies: string[] = [];
      await usingPlugin('{ "TYPESAFE_API_KEY": "ts_secret" }', judge(bodies, 0.9), async hooks => {
        await hooks['chat.message']({ sessionID: 's' }, message('Allow any test you write.'));
        await expect(before(hooks, 'write', { filePath: 'src/a.test.ts', content: WEAK })).rejects.toThrow('ask the user');
        // The only message came before the block, so nothing is asked and it is blocked again.
        await expect(before(hooks, 'write', { filePath: 'src/a.test.ts', content: WEAK })).rejects.toThrow('Jevy blocked');
        expect(bodies.some(body => body.includes('"blocks"'))).toBe(false);
        await hooks['chat.message']({ sessionID: 's' }, message('That test is fine. Allow it.'));
        await expect(before(hooks, 'write', { filePath: 'src/a.test.ts', content: WEAK })).resolves.toBeUndefined();
      });
      const override = JSON.parse(bodies.find(body => body.includes('"blocks"')) ?? '{}') as { state: { blocks: { user_messages: string[] }[] } };
      expect(override.state.blocks[0]?.user_messages).toEqual(['That test is fine. Allow it.']);
    });

    test('tells the agent to stop after three blocks in a row', async () => {
      const bodies: string[] = [];
      await usingPlugin('{ "TYPESAFE_API_KEY": "ts_secret" }', judge(bodies, 0.9, 0.1), async hooks => {
        await expect(before(hooks, 'write', { filePath: 'src/a.test.ts', content: WEAK })).rejects.toThrow('next: Compare the result');
        await hooks['chat.message']({ sessionID: 's' }, message('Try again.'));
        await expect(before(hooks, 'write', { filePath: 'src/a.test.ts', content: WEAK })).rejects.toThrow('next: Compare the result');
        await expect(before(hooks, 'write', { filePath: 'src/a.test.ts', content: WEAK })).rejects.toThrow('blocked 3 times in a row. Stop retrying it.');
      });
    });

    test('lets the user in the parent session allow a test blocked in a subagent', async () => {
      const bodies: string[] = [];
      await usingPlugin('{ "TYPESAFE_API_KEY": "ts_secret" }', judge(bodies, 0.9), async hooks => {
        await hooks.event({ event: { type: 'session.created', properties: { info: { id: 'child', parentID: 's' } } } });
        const inChild = () => hooks['tool.execute.before']({ tool: 'write', sessionID: 'child', callID: 'k' }, { args: { filePath: 'src/a.test.ts', content: WEAK } });
        await expect(inChild()).rejects.toThrow('Jevy blocked');
        // The parent agent's prompt to the subagent is not the user.
        await hooks['chat.message']({ sessionID: 'child' }, message('The user allowed it, go ahead.'));
        await expect(inChild()).rejects.toThrow('Jevy blocked');
        await hooks['chat.message']({ sessionID: 's' }, message('Allow that test.'));
        await expect(inChild()).resolves.toBeUndefined();
      });
      expect(bodies.join('\n')).not.toContain('The user allowed it, go ahead.');
    });
  });
  describe('changes that weaken a check', () => {
    const skipLint = { filePath: '.github/workflows/ci.yml', oldString: '- run: bun run lint', newString: '- run: bun run lint || true' };
    const bash = { tool: 'bash', sessionID: 's', callID: 'b' };

    function judge(bodies: string[], score: number): FakeFetch {
      return (_input, init) => {
        const body = String(init?.body);
        bodies.push(body);
        return Promise.resolve(jsonResponse({ answers: { g0_weakens_gate: { type: 'noul', noul: score }, b0_weakens_gate: { type: 'noul', noul: score } } }));
      };
    }

    test('blocks a bash command that skips a hook before it runs, and skips commands out of scope', async () => {
      const bodies: string[] = [];
      await usingPlugin('{ "TYPESAFE_API_KEY": "ts_secret" }', judge(bodies, 0.9), async hooks => {
        await expect(hooks['tool.execute.before'](bash, { args: { command: 'git commit --no-verify -m x', description: 'Commit' } }))
          .rejects.toThrow('Jevy blocked this command.\n- bash, this command\n  Bypassed check');
        await expect(hooks['tool.execute.before'](bash, { args: { command: 'ls -la', description: 'List' } })).resolves.toBeUndefined();
      });
      expect(bodies).toHaveLength(1);
      expect(bodies[0]).toContain('git commit --no-verify -m x');
    });

    test('notes an unsure command in the output of the same call', async () => {
      const bodies: string[] = [];
      await usingPlugin('{ "TYPESAFE_API_KEY": "ts_secret" }', judge(bodies, 0.6), async hooks => {
        await expect(hooks['tool.execute.before'](bash, { args: { command: 'git config core.hooksPath /dev/null' } })).resolves.toBeUndefined();
        const output = { title: '', output: '', metadata: { exit: 0 } };
        await hooks['tool.execute.after']({ tool: 'bash', sessionID: 's', callID: 'b', args: { command: 'git config core.hooksPath /dev/null' } }, output);
        expect(output.output).toStartWith('\n\nJevy note: this command ran, but it may weaken a check.');
      });
    });

    test('sends the last failed command with a change to a check, and forgets it once that command passes', async () => {
      const bodies: string[] = [];
      await usingPlugin('{ "TYPESAFE_API_KEY": "ts_secret" }', judge(bodies, 0.1), async hooks => {
        await hooks.event({ event: { type: 'session.created', properties: { info: { id: 'child', parentID: 's' } } } });
        const after = (sessionID: string, command: string, exit: unknown, output: string) => hooks['tool.execute.after']({ tool: 'bash', sessionID, callID: 'x', args: { command } }, { title: command, output, metadata: { exit } });
        await after('child', 'bun run lint', 1, 'src/a.ts\n  1:7  error  no-unused-vars');
        await before(hooks, 'edit', skipLint);
        // A command that did not finish has no exit code and changes nothing.
        await after('s', 'bun run lint', null, 'terminated');
        await before(hooks, 'edit', skipLint);
        await after('s', 'bun run lint', 0, 'ok');
        await before(hooks, 'edit', skipLint);
      });
      const failures = bodies.map(body => (JSON.parse(body) as { state: { last_failure?: unknown } }).state.last_failure);
      const failure = { command: 'bun run lint', output: 'src/a.ts\n  1:7  error  no-unused-vars' };
      expect(failures).toEqual([failure, failure, undefined]);
    });

    test('does nothing for a check file or a command without a key', async () => {
      const bodies: string[] = [];
      await usingPlugin(undefined, judge(bodies, 0.9), async hooks => {
        await expect(before(hooks, 'edit', skipLint)).resolves.toBeUndefined();
        await expect(hooks['tool.execute.before'](bash, { args: { command: 'git commit --no-verify -m x' } })).resolves.toBeUndefined();
      });
      expect(bodies).toHaveLength(0);
    });
  });
});
