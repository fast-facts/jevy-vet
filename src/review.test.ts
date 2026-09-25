import { describe, expect, test } from 'bun:test';
import { review, type ReviewDeps } from './review.ts';
import { type Settings } from './settings.ts';

const USEFUL = 'test(\'adds\', () => { expect(add(1, 2)).toBe(3) })';

function deps(fetchImpl: ReviewDeps['fetch'], settings: Partial<Settings> = { key: 'ts_secret' }, disk?: ReviewDeps['disk']): ReviewDeps & { logs: string[]; loads: number } {
  const logs: string[] = [];
  let loads = 0;
  return {
    load() {
      loads += 1;
      return {
        key: settings.key ?? '',
        baseUrl: settings.baseUrl ?? '',
        path: settings.path ?? '/cfg/opencode/jevy-vet.jsonc',
        error: settings.error,
      };
    },
    fetch: fetchImpl,
    disk,
    log: message => {
      logs.push(message);
    },
    logs,
    get loads() {
      return loads;
    },
  };
}

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
      t0_copied_expectation: answer,
      t0_mocks_code_under_test: answer,
      t0_trivial_code: answer,
    },
  };
}

interface SentBody {
  model: string;
  state: {
    purpose: string;
    files: {
      path: string;
      setup: string;
      setup_truncated?: boolean;
      code_under_test: { path: string; text: string; truncated: boolean }[];
      cases: { id: string; title?: string; test: string; truncated?: boolean }[];
    }[];
  };
  questions: Record<string, { type: string; instructions: string; criteria: { true: string; false: string } }>;
}

function memoryDisk(files: Record<string, string>, root = '/repo') {
  const reads: string[] = [];
  return {
    reads,
    disk: {
      root,
      read(path: string) {
        reads.push(path);
        return files[path];
      },
      list(dir: string) {
        return Object.keys(files).filter(path => path.startsWith(`${dir}/`) && !path.slice(dir.length + 1).includes('/')).map(path => path.slice(dir.length + 1));
      },
    },
  };
}

describe('review', () => {
  test('does not call Jev for a non-test write', async () => {
    let called = false;
    const used = deps(() => {
      called = true;
      return Promise.resolve(jsonResponse(allowBody()));
    });
    const result = await review('write', { filePath: 'src/foo.ts', content: USEFUL }, used);
    expect(result).toBeUndefined();
    expect(called).toBe(false);
    expect(used.loads).toBe(0);
  });

  test('does not call Jev for other tools', async () => {
    let called = false;
    const result = await review('read', { filePath: 'src/foo.test.ts' }, deps(() => {
      called = true;
      return Promise.resolve(jsonResponse(allowBody()));
    }));
    expect(result).toBeUndefined();
    expect(called).toBe(false);
  });

  test('posts the test to TypeSafe with the bearer key', async () => {
    let url = '';
    let auth = '';
    let body = '';
    const result = await review('write', { filePath: '/repo/src/foo.test.ts', content: USEFUL }, deps((input, init) => {
      url = String(input);
      auth = new Headers(init?.headers).get('Authorization') ?? '';
      body = String(init?.body);
      return Promise.resolve(jsonResponse(allowBody()));
    }));
    expect(result).toBeUndefined();
    expect(url).toBe('https://api.typesafe.ai/v1/systemone');
    expect(auth).toBe('Bearer ts_secret');
    expect(body).toContain(USEFUL);
    expect(body).not.toContain('ts_secret');
    const parsed = JSON.parse(body) as SentBody;
    expect(parsed.model).toBe('jev-latest');
    expect(parsed.questions.t0_title_mismatch.type).toBe('noul');
    expect(parsed.questions.t0_title_mismatch.criteria).toEqual({ true: 'yes', false: 'no' });
    expect(parsed.questions.t0_title_mismatch.instructions).toContain('`files[0].cases[0].test`');
    expect(parsed.questions.t0_passes_on_empty.criteria.true).toContain('No assertion would notice');
    expect(parsed.state.files[0].cases[0]).toEqual({ id: 't0', title: 'adds', test: USEFUL });
  });

  test('uses TYPESAFE_BASE_URL and drops a trailing slash', async () => {
    let url = '';
    await review('write', { filePath: 'foo.test.ts', content: USEFUL }, deps(input => {
      url = String(input);
      return Promise.resolve(jsonResponse(allowBody()));
    }, { key: 'ts_secret', baseUrl: 'https://jev.example/' }));
    expect(url).toBe('https://jev.example/v1/systemone');
  });

  test('blocks a test write when the key is missing and does not call Jev', async () => {
    let called = false;
    const result = await review('write', { filePath: 'src/foo.test.ts', content: USEFUL }, deps(() => {
      called = true;
      return Promise.resolve(jsonResponse(allowBody()));
    }, { key: '', path: '/cfg/opencode/jevy-vet.jsonc' }));
    expect(result).toContain('TYPESAFE_API_KEY is not set');
    expect(result).toContain('src/foo.test.ts');
    expect(result).toContain('/cfg/opencode/jevy-vet.jsonc');
    expect(called).toBe(false);
  });

  test('blocks a test write when the config file cannot be read', async () => {
    let called = false;
    const result = await review('write', { filePath: 'src/foo.test.ts', content: USEFUL }, deps(() => {
      called = true;
      return Promise.resolve(jsonResponse(allowBody()));
    }, { error: '/cfg/opencode/jevy-vet.jsonc is not valid.' }));
    expect(result).toContain('/cfg/opencode/jevy-vet.jsonc is not valid.');
    expect(result).toContain('src/foo.test.ts');
    expect(called).toBe(false);
  });

  test('blocks when a hard rule is confident', async () => {
    const result = await review('edit', { filePath: 'src/foo.test.ts', oldString: 'old', newString: 'expect(x).toBeDefined()' }, deps(() => Promise.resolve(jsonResponse({
      answers: {
        t0_passes_on_empty: { noul: 0.91 },
        t0_title_mismatch: { noul: 0.1 },
      },
    }))));
    expect(result).toContain('src/foo.test.ts (test 1): It would still pass if the code returned null, an empty value, or zero.');
    expect(result).not.toContain('title');
    expect(result).not.toContain('old');
  });

  test('allows a low score and an uncertain high score', async () => {
    const low = await review('write', { filePath: 'foo.test.ts', content: USEFUL }, deps(() => Promise.resolve(jsonResponse(allowBody()))));
    const unsure = await review('write', { filePath: 'foo.test.ts', content: USEFUL }, deps(() => Promise.resolve(jsonResponse({
      answers: { t0_passes_on_empty: { noul: 0.99, confidence: 0.4 } },
    }))));
    expect(low).toBeUndefined();
    expect(unsure).toBeUndefined();
  });

  test('blocks when confidence is missing and noul is at the line', async () => {
    const result = await review('write', { filePath: 'foo_test.go', content: 'func TestGet(t *testing.T) {}' }, deps(() => Promise.resolve(jsonResponse({
      answers: { t0_title_mismatch: { noul: 0.8 } },
    }))));
    expect(result).toContain('foo_test.go (test "TestGet"): Its title promises a behavior that none of its assertions check.');
  });

  test('allows the write when TypeSafe fails', async () => {
    const down = deps(() => Promise.resolve(jsonResponse({ error: 'down' }, 503)));
    const broken = deps(() => Promise.reject(new Error('network')));
    expect(await review('write', { filePath: 'foo.test.ts', content: USEFUL }, down)).toBeUndefined();
    expect(down.logs[0]).toContain('503');
    expect(await review('write', { filePath: 'foo.test.ts', content: USEFUL }, broken)).toBeUndefined();
    expect(broken.logs[0]).toContain('request failed');
  });

  test('judges added test files in a patch and skips deletes and non-tests', async () => {
    let body = '';
    const patch = [
      '*** Begin Patch',
      '*** Add File: src/foo.test.ts',
      `+${USEFUL}`,
      '*** Add File: src/foo.ts',
      '+export const x = 1',
      '*** Delete File: src/old.test.ts',
      '*** Update File: src/bar.ts',
      '*** Move to: src/bar.test.ts',
      '@@',
      '+expect(bar()).toBe(1)',
      '*** End Patch',
    ].join('\n');
    await review('apply_patch', { patchText: patch }, deps((_url, init) => {
      body = String(init?.body);
      return Promise.resolve(jsonResponse({
        answers: {
          t0_title_mismatch: { noul: 0.1 },
          t1_title_mismatch: { noul: 0.1 },
        },
      }));
    }));
    const parsed = JSON.parse(body) as SentBody;
    expect(parsed.state.files.map(item => item.path)).toEqual(['src/foo.test.ts', 'src/bar.test.ts']);
    expect(parsed.state.files[0].cases[0].test).toBe(USEFUL);
    expect(parsed.state.files[1].cases[0].test).toContain('expect(bar()).toBe(1)');
    expect(parsed.questions.t1_title_mismatch.instructions).toContain('`files[1].cases[0].test`');
  });

  test('names only the failing file in a patch', async () => {
    const patch = [
      '*** Begin Patch',
      '*** Add File: src/good.test.ts',
      '+test(\'ok\', () => expect(1).toBe(1))',
      '*** Add File: src/bad.test.ts',
      '+expect(x).toBeDefined()',
      '*** End Patch',
    ].join('\n');
    const result = await review('apply_patch', { patchText: patch }, deps(() => Promise.resolve(jsonResponse({
      answers: {
        t0_passes_on_empty: { noul: 0.1 },
        t1_passes_on_empty: { noul: 0.93 },
      },
    }))));
    expect(result).toContain('src/bad.test.ts');
    expect(result).not.toContain('src/good.test.ts');
  });

  test('does not call Jev for a context-only patch or a bad patch', async () => {
    let called = false;
    const fetchImpl: ReviewDeps['fetch'] = () => {
      called = true;
      return Promise.resolve(jsonResponse(allowBody()));
    };
    const contextOnly = ['*** Begin Patch', '*** Update File: src/foo.test.ts', '@@', ' function old() {', '*** End Patch'].join('\n');
    expect(await review('apply_patch', { patchText: contextOnly }, deps(fetchImpl))).toBeUndefined();
    expect(await review('apply_patch', { patchText: 'not a patch' }, deps(fetchImpl))).toBeUndefined();
    expect(called).toBe(false);
  });

  test('reads a heredoc-wrapped patch', async () => {
    let body = '';
    const patch = ['cat <<\'EOF\'', '*** Begin Patch', '*** Add File: a.test.ts', `+${USEFUL}`, '*** End Patch', 'EOF'].join('\n');
    await review('apply_patch', { patchText: patch }, deps((_url, init) => {
      body = String(init?.body);
      return Promise.resolve(jsonResponse(allowBody()));
    }));
    expect(body).toContain('a.test.ts');
    expect(body).toContain(USEFUL);
  });

  test('keeps the head and tail of a long test and says it was cut', async () => {
    let body = '';
    const content = `test('long', () => {${'a'.repeat(20_000)}TAIL })`;
    await review('write', { filePath: 'foo.test.ts', content }, deps((_url, init) => {
      body = String(init?.body);
      return Promise.resolve(jsonResponse(allowBody()));
    }));
    const parsed = JSON.parse(body) as SentBody;
    const sent = parsed.state.files[0].cases[0];
    expect(sent.truncated).toBe(true);
    expect(sent.test.length).toBeLessThanOrEqual(12_000);
    expect(sent.test.length).toBeGreaterThan(2000);
    expect(sent.test).toStartWith('test(\'long\'');
    expect(sent.test).toContain('TAIL })');
    expect(sent.test).toContain('characters cut');
    expect(parsed.questions.t0_title_mismatch.instructions).toContain('cut');
  });

  test('does not cut a test under the limit', async () => {
    let body = '';
    const content = `test('mid', () => {${'a'.repeat(5000)}})`;
    await review('write', { filePath: 'foo.test.ts', content }, deps((_url, init) => {
      body = String(init?.body);
      return Promise.resolve(jsonResponse(allowBody()));
    }));
    const parsed = JSON.parse(body) as SentBody;
    expect(parsed.state.files[0].cases[0].test).toBe(content);
    expect(parsed.state.files[0].cases[0].truncated).toBeUndefined();
  });

  test('skips code-under-test questions when no code under test is found', async () => {
    let body = '';
    await review('write', { filePath: '/repo/src/foo.test.ts', content: USEFUL }, deps((_url, init) => {
      body = String(init?.body);
      return Promise.resolve(jsonResponse(allowBody()));
    }, { key: 'ts_secret' }, memoryDisk({}).disk));
    const parsed = JSON.parse(body) as SentBody;
    expect(Object.keys(parsed.questions).sort()).toEqual(['t0_passes_on_empty', 't0_title_mismatch']);
    expect(parsed.state.files[0].code_under_test).toEqual([]);
  });

  test('sends the imported code, the setup, and each test as its own case', async () => {
    let body = '';
    const content = [
      'import { add } from \'./math\';',
      'const twice = (n: number) => add(n, n);',
      'test(\'adds\', () => { expect(add(1, 2)).toBe(3) })',
      'test(\'doubles\', () => { expect(twice(2)).toBe(4) })',
    ].join('\n');
    const code = 'export function add(a: number, b: number) { return a + b }';
    const { disk } = memoryDisk({ '/repo/src/math.ts': code });
    const result = await review('write', { filePath: '/repo/src/math.test.ts', content }, deps((_url, init) => {
      body = String(init?.body);
      return Promise.resolve(jsonResponse({ answers: { t1_copied_expectation: { noul: 0.95 } } }));
    }, { key: 'ts_secret' }, disk));
    const parsed = JSON.parse(body) as SentBody;
    const file = parsed.state.files[0];
    expect(file.setup).toContain('const twice');
    expect(file.code_under_test).toEqual([{ path: 'src/math.ts', text: code, truncated: false }]);
    expect(file.cases.map(item => item.title)).toEqual(['adds', 'doubles']);
    expect(file.cases[0].test).not.toContain('import');
    expect(Object.keys(parsed.questions)).toHaveLength(10);
    expect(parsed.questions.t1_copied_expectation.instructions).toContain('`files[0].code_under_test`');
    expect(parsed.questions.t1_trivial_code.instructions).toContain('`files[0].cases[1].test`');
    expect(result).toBe([
      'Jevy blocked this test write.',
      '/repo/src/math.test.ts (test "doubles"): The expected value is computed with the same logic as the code under test.',
      'Rewrite the test so a wrong result would fail it, or do not add it.',
    ].join('\n'));
  });

  test('reads setup and imports from the file on disk for an edit, but judges only newString', async () => {
    let body = '';
    const onDisk = ['import { add } from \'./math\';', 'test(\'old\', () => { expect(add(2, 2)).toBe(4) })'].join('\n');
    const { disk } = memoryDisk({
      '/repo/src/math.test.ts': onDisk,
      '/repo/src/math.ts': 'export const add = (a: number, b: number) => a + b',
    });
    await review('edit', {
      filePath: 'src/math.test.ts',
      oldString: 'OLD_NOT_JUDGED',
      newString: 'test(\'adds\', () => { expect(add(1, 2)).toBe(3) })',
    }, deps((_url, init) => {
      body = String(init?.body);
      return Promise.resolve(jsonResponse(allowBody()));
    }, { key: 'ts_secret' }, disk));
    const parsed = JSON.parse(body) as SentBody;
    const file = parsed.state.files[0];
    expect(file.setup).toBe('import { add } from \'./math\';');
    expect(file.code_under_test.map(item => item.path)).toEqual(['src/math.ts']);
    expect(file.cases).toHaveLength(1);
    expect(file.cases[0].test).toContain('adds');
    expect(body).not.toContain('test(\'old\'');
    expect(body).not.toContain('OLD_NOT_JUDGED');
  });

  test('splits many tests into more than one request and merges the answers', async () => {
    const bodies: SentBody[] = [];
    const content = Array.from({ length: 30 }, (_v, i) => `test('case ${i}', () => { expect(f(${i})).toBe(${i}) })`).join('\n');
    const { disk } = memoryDisk({ '/repo/f.ts': 'export const f = (n: number) => n' });
    const result = await review('write', { filePath: '/repo/f.test.ts', content }, deps((_url, init) => {
      const parsed = JSON.parse(String(init?.body)) as SentBody;
      bodies.push(parsed);
      const answers = 't29_mocks_code_under_test' in parsed.questions ? { t29_mocks_code_under_test: { noul: 0.9 } } : {};
      return Promise.resolve(jsonResponse({ answers }));
    }, { key: 'ts_secret' }, disk));
    expect(bodies).toHaveLength(2);
    expect(bodies.every(body => Object.keys(body.questions).length <= 100)).toBe(true);
    expect(bodies.every(body => body.state.files[0].code_under_test.length === 1)).toBe(true);
    expect(bodies[1].state.files[0].cases[0].id).toBe('t20');
    expect(bodies[1].questions.t20_title_mismatch.instructions).toContain('`files[0].cases[0].test`');
    expect(result).toContain('/repo/f.test.ts (test "case 29"): It replaces the code it tests with a mock or stub.');
  });

  test('still blocks on one request when another request fails', async () => {
    let calls = 0;
    const content = Array.from({ length: 30 }, (_v, i) => `test('case ${i}', () => { expect(f(${i})).toBe(${i}) })`).join('\n');
    const { disk } = memoryDisk({ '/repo/f.ts': 'export const f = (n: number) => n' });
    const used = deps(() => {
      calls += 1;
      if (calls === 1) return Promise.resolve(jsonResponse({ error: 'down' }, 503));
      return Promise.resolve(jsonResponse({ answers: { t25_title_mismatch: { noul: 0.9 } } }));
    }, { key: 'ts_secret' }, disk);
    const result = await review('write', { filePath: '/repo/f.test.ts', content }, used);
    expect(result).toContain('test "case 25"');
    expect(used.logs).toEqual(['TypeSafe returned 503. The test write was allowed.']);
  });

  test('recognizes common test paths', async () => {
    const paths = ['a.test.ts', 'a.spec.tsx', 'a.test.mjs', 'foo_test.go', 'foo_test.rs', 'foo_test.exs', 'foo_test.py', 'test_foo.py', 'FooTest.java', 'FooTest.kt', 'src/__tests__/foo.ts', 'src/foo.ts', 'latest.kt', 'fixture.json'];
    const judged: string[] = [];
    for (const filePath of paths) {
      let called = false;
      await review('write', { filePath, content: USEFUL }, deps(() => {
        called = true;
        return Promise.resolve(jsonResponse(allowBody()));
      }));
      if (called) judged.push(filePath);
    }
    expect(judged).toEqual(['a.test.ts', 'a.spec.tsx', 'a.test.mjs', 'foo_test.go', 'foo_test.rs', 'foo_test.exs', 'foo_test.py', 'test_foo.py', 'FooTest.java', 'FooTest.kt', 'src/__tests__/foo.ts']);
  });
});
