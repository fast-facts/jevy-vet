import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'bun:test';
import { loadCases, questionKind, type ResultRow, runCases, summarize } from './run.ts';

describe('loadCases', () => {
  test('loads a case and rejects a bad field', () => {
    const cases = loadCases('{"id":"a","check":"hidden","input":{"tool":"edit"},"expect":{"x0_hides_error":true},"source":"hand"}\n');
    expect(cases).toHaveLength(1);
    expect(cases[0]?.check).toBe('hidden');
    expect(() => loadCases('{"id":"a","check":"review","input":{},"source":"hand"}\n')).toThrow(/expect/);
    expect(() => loadCases('{"id":"a","check":"nope","input":{},"expect":{},"source":"hand"}\n')).toThrow(/check/);
    expect(() => loadCases('{"id":"a","check":"review","input":{},"expect":{"t0_title_mismatch":1},"source":"hand"}\n')).toThrow(/expect/);
  });
});

describe('dry mode', () => {
  test('reports an expected question that was never asked', async () => {
    const report = await runCases([{
      id: 'missing',
      check: 'review',
      input: { tool: 'edit', args: { filePath: 'src/cart.ts', oldString: 'const a = 1;', newString: 'const a = 2;' } },
      expect: { t0_title_mismatch: true },
      source: 'hand',
    }]);
    expect(report.failures.some(failure => failure.includes('t0_title_mismatch'))).toBe(true);
    expect(report.requests).toBe(0);
  });
});

describe('summarize', () => {
  test('groups by question kind and counts the cutoffs', () => {
    const text = readFileSync(join(import.meta.dir, 'fixtures/cutoff-rows.jsonl'), 'utf8');
    const rows = text.split('\n').filter(line => line.trim() !== '').map(line => JSON.parse(line) as ResultRow);
    const kinds = summarize(rows);
    const hidden = kinds.find(kind => kind.kind === '_hides_error');
    expect(hidden).toEqual({ kind: '_hides_error', n: 3, positives: 2, negatives: 1, sure: 1, unsure: 1, auroc: 1 });
    const support = kinds.find(kind => kind.kind === '_support');
    expect(support?.n).toBe(2);
    const failed = support?.options?.find(option => option.option === 'failed_run');
    expect(failed).toEqual({ option: 'failed_run', n: 2, positives: 1, negatives: 1, sure: 1, unsure: 0, auroc: 1 });
    const supported = support?.options?.find(option => option.option === 'supported');
    expect(supported?.positives).toBe(1);
    expect(supported?.sure).toBe(0);
    expect(supported?.unsure).toBe(1);
    expect(questionKind('c0_i1_breaks')).toBe('_breaks');
    expect(questionKind('claims_user_asked')).toBe('claims_user_asked');
  });
});

describe('live mode', () => {
  test('refuses to start without a key and never logs it', async () => {
    const secret = 'ts_secret_do_not_log';
    const logs: string[] = [];
    let fetched = false;
    const load = () => ({ key: secret, baseUrl: '', path: '/cfg/opencode/jevy-vet.jsonc', error: 'Could not read /cfg/opencode/jevy-vet.jsonc.' });
    await expect(runCases([], { live: true, load, log: message => logs.push(message), fetch: async () => {
      fetched = true;
      return new Response('{}');
    } })).rejects.toThrow('No TypeSafe key. Live eval did not start.');
    expect(fetched).toBe(false);
    expect(logs.join('\n')).not.toContain(secret);
    await expect(runCases([], {
      live: true,
      load: () => ({ key: '', baseUrl: '', path: '/cfg/opencode/jevy-vet.jsonc' }),
      log: message => logs.push(message),
    })).rejects.toThrow('No TypeSafe key. Live eval did not start.');
    expect(logs.join('\n')).not.toContain(secret);
  });
});
