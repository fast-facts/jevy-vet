import { describe, expect, test } from 'bun:test';
import { testFilesFrom, titleOf } from './subjects.ts';

describe('testFilesFrom', () => {
  test('splits a write into setup and one case per test', () => {
    const content = ['import { add } from \'./add\';', '', 'test(\'one\', () => {})', 'it.each([1])(\'two\', () => {})'].join('\n');
    expect(testFilesFrom('write', { filePath: 'a.test.ts', content })).toEqual([{
      path: 'a.test.ts',
      cases: ['test(\'one\', () => {})', 'it.each([1])(\'two\', () => {})'],
      setup: 'import { add } from \'./add\';',
      source: content,
      edited: false,
    }]);
  });

  test('keeps a fragment with no test marker as one case and marks edits', () => {
    expect(testFilesFrom('edit', { filePath: 'a.test.ts', oldString: 'x', newString: 'expect(x).toBe(1)' })).toEqual([{
      path: 'a.test.ts',
      cases: ['expect(x).toBe(1)'],
      setup: '',
      source: 'expect(x).toBe(1)',
      edited: true,
    }]);
  });

  test('marks an added patch file as whole and an updated one as edited', () => {
    const patchText = [
      '*** Begin Patch',
      '*** Add File: a.test.ts',
      '+test(\'a\', () => {})',
      '*** Update File: b.test.ts',
      '@@',
      '+test(\'b\', () => {})',
      '*** End Patch',
    ].join('\n');
    expect(testFilesFrom('apply_patch', { patchText }).map(file => [file.path, file.edited])).toEqual([['a.test.ts', false], ['b.test.ts', true]]);
  });

  test('splits async Python tests', () => {
    const content = 'import pytest\n\nasync def test_a():\n    assert 1\n\ndef test_b():\n    assert 2';
    expect(testFilesFrom('write', { filePath: 'test_x.py', content })[0]?.cases).toEqual(['async def test_a():\n    assert 1', 'def test_b():\n    assert 2']);
  });
});

describe('titleOf', () => {
  test('reads titles from common test forms', () => {
    expect(titleOf('test(\'adds two numbers\', () => {})')).toBe('adds two numbers');
    expect(titleOf('it("says \\"hi\\"", () => {})')).toBe('says \\"hi\\"');
    expect(titleOf('it.only(`works`, () => {})')).toBe('works');
    expect(titleOf('def test_total():\n    pass')).toBe('test_total');
    expect(titleOf('func TestSum(t *testing.T) {}')).toBe('TestSum');
    expect(titleOf('@Test\npublic void addsItems() {}')).toBe('addsItems');
    expect(titleOf('expect(x).toBe(1)')).toBeUndefined();
  });
});
