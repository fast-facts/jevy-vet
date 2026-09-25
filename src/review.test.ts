import { describe, expect, test } from 'bun:test';
import { review, type ReviewDeps } from './review.ts';
import { type Settings } from './settings.ts';

const USEFUL = 'test(\'adds\', () => { expect(add(1, 2)).toBe(3) })';

function deps(fetchImpl: ReviewDeps['fetch'], settings: Partial<Settings> = { key: 'ts_secret' }): ReviewDeps & { logs: string[]; loads: number } {
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
    const parsed = JSON.parse(body) as {
      model: string;
      questions: Record<string, { type: string; criteria: { true: string; false: string } }>;
    };
    expect(parsed.model).toBe('jev-latest');
    expect(parsed.questions.t0_no_visible_result.type).toBe('noul');
    expect(parsed.questions.t0_no_visible_result.criteria).toEqual({ true: 'yes', false: 'no' });
    expect(parsed.questions.t0_copied_expectation).toBeDefined();
    expect(parsed.questions.t0_trivial).toBeDefined();
    expect(parsed.questions.t0_no_behavior).toBeDefined();
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
        t0_no_visible_result: { noul: 0.91, confidence: 0.88 },
        t0_copied_expectation: { noul: 0.1 },
        t0_trivial: { noul: 0.2 },
        t0_no_behavior: { noul: 0.2 },
      },
    }))));
    expect(result).toContain('src/foo.test.ts');
    expect(result).toContain('It does not check a result a caller could see.');
    expect(result).not.toContain('old');
  });

  test('allows a low score and an uncertain high score', async () => {
    const low = await review('write', { filePath: 'foo.test.ts', content: USEFUL }, deps(() => Promise.resolve(jsonResponse(allowBody()))));
    const unsure = await review('write', { filePath: 'foo.test.ts', content: USEFUL }, deps(() => Promise.resolve(jsonResponse({
      answers: { t0_trivial: { noul: 0.99, confidence: 0.4 } },
    }))));
    expect(low).toBeUndefined();
    expect(unsure).toBeUndefined();
  });

  test('blocks when confidence is missing and noul is at the line', async () => {
    const result = await review('write', { filePath: 'foo_test.go', content: 'func TestGet(t *testing.T) {}' }, deps(() => Promise.resolve(jsonResponse({
      answers: { t0_no_behavior: { noul: 0.8 } },
    }))));
    expect(result).toContain('foo_test.go');
    expect(result).toContain('It does not check a rule, a boundary, or a failure mode.');
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
          t0_no_visible_result: { noul: 0.1 },
          t1_copied_expectation: { noul: 0.92, confidence: 0.9 },
        },
      }));
    }));
    const parsed = JSON.parse(body) as { state: { tests: { path: string; text: string }[] } };
    expect(parsed.state.tests.map(item => item.path)).toEqual(['src/foo.test.ts', 'src/bar.test.ts']);
    expect(parsed.state.tests[0].text).toBe(USEFUL);
    expect(parsed.state.tests[1].text).toContain('expect(bar()).toBe(1)');
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
        t0_no_visible_result: { noul: 0.1, confidence: 0.9 },
        t1_no_visible_result: { noul: 0.93, confidence: 0.91 },
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

  test('cuts long test text and says it was cut', async () => {
    let body = '';
    const content = `${'a'.repeat(2001)}TAIL`;
    await review('write', { filePath: 'foo.test.ts', content }, deps((_url, init) => {
      body = String(init?.body);
      return Promise.resolve(jsonResponse(allowBody()));
    }));
    const parsed = JSON.parse(body) as { state: { tests: { text: string; truncated: boolean }[] }; questions: Record<string, { instructions: string }> };
    expect(parsed.state.tests[0].truncated).toBe(true);
    expect(parsed.state.tests[0].text).toHaveLength(2000);
    expect(parsed.state.tests[0].text).not.toContain('TAIL');
    expect(parsed.questions.t0_trivial.instructions).toContain('cut off');
  });

  test('recognizes common test paths', async () => {
    const paths = ['a.test.ts', 'a.spec.tsx', 'a.test.mjs', 'foo_test.go', 'foo_test.py', 'test_foo.py', 'FooTest.java', 'src/__tests__/foo.ts', 'src/foo.ts', 'latest.kt', 'fixture.json'];
    const judged: string[] = [];
    for (const filePath of paths) {
      let called = false;
      await review('write', { filePath, content: USEFUL }, deps(() => {
        called = true;
        return Promise.resolve(jsonResponse(allowBody()));
      }));
      if (called) judged.push(filePath);
    }
    expect(judged).toEqual(['a.test.ts', 'a.spec.tsx', 'a.test.mjs', 'foo_test.go', 'foo_test.py', 'test_foo.py', 'FooTest.java', 'src/__tests__/foo.ts']);
  });
});
