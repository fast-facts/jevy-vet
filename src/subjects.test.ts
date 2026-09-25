import { describe, expect, test } from 'bun:test';
import { editsFrom, stripComments, testFilesFrom, titleOf } from './subjects.ts';

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

describe('editsFrom', () => {
  const none = () => undefined;

  test('pairs an edit fragment and titles it from the file on disk', () => {
    const onDisk = 'import { add } from \'./add\';\ntest(\'adds\', () => {\n  expect(add(1, 2)).toBe(3)\n})';
    const pairs = editsFrom('edit', { filePath: 'a.test.ts', oldString: 'expect(add(1, 2)).toBe(3)', newString: 'expect(add(1, 2)).toBeDefined()' }, path => path === 'a.test.ts' ? onDisk : undefined);
    expect(pairs).toEqual([{ path: 'a.test.ts', title: 'adds', old: 'expect(add(1, 2)).toBe(3)', new: 'expect(add(1, 2)).toBeDefined()' }]);
  });

  test('skips non-test paths, empty oldString, and comment-only or whitespace-only changes', () => {
    expect(editsFrom('edit', { filePath: 'a.ts', oldString: 'x', newString: 'y' }, none)).toEqual([]);
    expect(editsFrom('edit', { filePath: 'a.test.ts', oldString: '', newString: 'test(\'x\', () => {})' }, none)).toEqual([]);
    expect(editsFrom('edit', { filePath: 'a.test.ts', oldString: 'expect(a).toBe(1)', newString: 'expect(a).toBe(1) // checked by hand\n' }, none)).toEqual([]);
    expect(editsFrom('edit', { filePath: 'test_a.py', oldString: 'assert a == 1', newString: 'assert  a == 1  # fine' }, none)).toEqual([]);
  });

  test('pairs whole tests by title and marks a missing one as removed with the added tests as possible replacements', () => {
    const oldText = 'test(\'a\', () => { expect(f()).toBe(1) })\ntest(\'b\', () => { expect(g()).toBe(2) })\ntest(\'c\', () => {})';
    const newText = 'test(\'a\', () => { expect(f()).toBe(1) })\ntest(\'b\', () => { expect(g()).toBeTruthy() })\ntest(\'c2\', () => {})';
    expect(editsFrom('edit', { filePath: 'a.test.ts', oldString: oldText, newString: newText }, none)).toEqual([
      { path: 'a.test.ts', title: 'b', old: 'test(\'b\', () => { expect(g()).toBe(2) })', new: 'test(\'b\', () => { expect(g()).toBeTruthy() })' },
      { path: 'a.test.ts', title: 'c', old: 'test(\'c\', () => {})', new: '', added: 'test(\'c2\', () => {})' },
    ]);
  });

  test('compares a write with the file on disk, and ignores a new file', () => {
    const onDisk = 'test(\'a\', () => { expect(f()).toBe(1) })';
    const content = 'test(\'a\', () => { expect(f()).toBe(2) })';
    expect(editsFrom('write', { filePath: '/r/a.test.ts', content }, path => path === '/r/a.test.ts' ? onDisk : undefined)).toEqual([
      { path: '/r/a.test.ts', title: 'a', old: onDisk, new: content },
    ]);
    expect(editsFrom('write', { filePath: '/r/b.test.ts', content }, none)).toEqual([]);
  });

  test('reads removed and added lines from each patch hunk and skips pure additions', () => {
    const patchText = [
      '*** Begin Patch',
      '*** Update File: a.test.ts',
      '@@ test(\'adds\'',
      ' test(\'adds\', () => {',
      '-  expect(add(1, 2)).toBe(3)',
      '+  expect(add(1, 2)).toBe(4)',
      ' })',
      '@@',
      '+test(\'new\', () => {})',
      '*** Update File: a.ts',
      '@@',
      '-x',
      '+y',
      '*** End Patch',
    ].join('\n');
    expect(editsFrom('apply_patch', { patchText }, none)).toEqual([{
      path: 'a.test.ts',
      title: 'adds',
      old: 'test(\'adds\', () => {\n  expect(add(1, 2)).toBe(3)\n})',
      new: 'test(\'adds\', () => {\n  expect(add(1, 2)).toBe(4)\n})',
    }]);
  });

  test('treats a deleted test file as removing each of its tests, and reads a moved file at its old path', () => {
    const patchText = [
      '*** Begin Patch',
      '*** Delete File: old.test.ts',
      '*** Update File: a.test.ts',
      '*** Move to: b.test.ts',
      '@@',
      '-expect(x).toBe(1)',
      '+expect(x).toBe(2)',
      '*** End Patch',
    ].join('\n');
    const read = (path: string) => path === 'old.test.ts' ? 'test(\'one\', () => { expect(1).toBe(1) })' : undefined;
    expect(editsFrom('apply_patch', { patchText }, read)).toEqual([
      { path: 'old.test.ts', title: 'one', old: 'test(\'one\', () => { expect(1).toBe(1) })', new: '' },
      { path: 'a.test.ts', old: 'expect(x).toBe(1)', new: 'expect(x).toBe(2)' },
    ]);
  });
});

describe('stripComments', () => {
  test('drops line and block comments but keeps comment markers inside strings', () => {
    const text = [
      '// the old value was wrong, the code is right',
      'expect(url).toBe(\'http://x\') /* looser on purpose */',
      'expect(s).toBe("a // b") // trailing',
    ].join('\n');
    expect(stripComments(text, 'a.test.ts')).toBe('expect(url).toBe(\'http://x\')\nexpect(s).toBe("a // b")');
  });

  test('drops Python hash comments but keeps a hash inside a string', () => {
    expect(stripComments('# changed to match output\nassert tag == "#1"  # ok', 'test_a.py')).toBe('assert tag == "#1"');
  });
});
