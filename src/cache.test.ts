import { describe, expect, test } from 'bun:test';
import { deps, jsonResponse } from './fakes.test.ts';
import { callTypeSafe, type ReviewDeps } from './jev.ts';

function batch(purpose: string, extra: Record<string, unknown> = {}) {
  return {
    state: { purpose, ...extra },
    questions: {
      q0: { type: 'noul' as const, instructions: 'Is it bad?', criteria: { true: 'yes', false: 'no' } },
    },
  };
}

function setup() {
  let calls = 0;
  const used = deps(() => {
    calls += 1;
    return Promise.resolve(jsonResponse({ answers: { q0: { type: 'noul', noul: 0.9 } } }));
  });
  return { used, settings: used.load(), calls: () => calls };
}

describe('answer cache', () => {
  test('asks once for two identical calls', async () => {
    const { used, settings, calls } = setup();
    const first = await callTypeSafe(used, settings, batch('Decide.'), 'The change was allowed.');
    const second = await callTypeSafe(used, settings, batch('Decide.'), 'The change was allowed.');
    expect(calls()).toBe(1);
    expect(second).toEqual(first);
  });

  test('shares one fetch between concurrent identical calls', async () => {
    const { used, settings, calls } = setup();
    const [first, second] = await Promise.all([
      callTypeSafe(used, settings, batch('Decide.'), 'The change was allowed.'),
      callTypeSafe(used, settings, batch('Decide.'), 'The change was allowed.'),
    ]);
    expect(calls()).toBe(1);
    expect(second).toEqual(first);
  });

  test('asks again when the user messages change', async () => {
    const { used, settings, calls } = setup();
    await callTypeSafe(used, settings, batch('Decide.'), 'The change was allowed.');
    await callTypeSafe(used, settings, batch('Decide.', { user_messages: ['Do it.'] }), 'The change was allowed.');
    expect(calls()).toBe(2);
  });

  test('never caches a failure', async () => {
    const settings = { key: 'ts_secret', baseUrl: '', path: '/cfg' };
    const broken: ReviewDeps['fetch'][] = [
      () => Promise.reject(new Error('offline')),
      () => Promise.resolve(jsonResponse({ error: 'down' }, 503)),
      () => Promise.resolve(new Response('not json', { status: 200 })),
      () => Promise.resolve(jsonResponse({ nodata: true })),
    ];
    for (const fetchImpl of broken) {
      let calls = 0;
      const counting: ReviewDeps['fetch'] = (url, init) => {
        calls += 1;
        return fetchImpl(url, init);
      };
      const used = deps(counting);
      await callTypeSafe(used, settings, batch('Decide.'), 'The change was allowed.');
      expect(await callTypeSafe(used, settings, batch('Decide.'), 'The change was allowed.')).toBeUndefined();
      expect(calls).toBe(2);
    }
  });

  test('keeps fetch count at 1 within 29 minutes and refetches to count 2 after 31 minutes', async () => {
    const { used, settings, calls } = setup();
    let now = 1_000_000;
    used.now = () => now;
    await callTypeSafe(used, settings, batch('Decide.'), 'The change was allowed.');
    now += 29 * 60 * 1000;
    await callTypeSafe(used, settings, batch('Decide.'), 'The change was allowed.');
    expect(calls()).toBe(1);
    now += 2 * 60 * 1000;
    await callTypeSafe(used, settings, batch('Decide.'), 'The change was allowed.');
    expect(calls()).toBe(2);
  });

  test('keeps fetch count at 501 for 501 answers and refetches evicted oldest to count 502', async () => {
    const { used, settings, calls } = setup();
    for (let n = 0; n < 501; n += 1) {
      await callTypeSafe(used, settings, batch(`Decide ${n}.`), 'The change was allowed.');
    }
    expect(calls()).toBe(501);
    await callTypeSafe(used, settings, batch('Decide 0.'), 'The change was allowed.');
    expect(calls()).toBe(502);
    await callTypeSafe(used, settings, batch('Decide 500.'), 'The change was allowed.');
    expect(calls()).toBe(502);
  });
});
