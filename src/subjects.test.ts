import { describe, expect, test } from 'bun:test';
import { changesFrom, commandFrom, definitionsIn, editsFrom, isCommentLine, isDefinitionFile, isGatePath, isTestSupport, literalsIn, stripComments, testFilesFrom, titleOf, touchesGates } from './subjects.ts';

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

  test('skips a helper-only edit with no test marker, but keeps a real new test', () => {
    const added = 'test(\'a\', () => { expect(x).toBe(1) })';
    expect(testFilesFrom('edit', { filePath: 'a.test.ts', oldString: 'x', newString: 'expect(x).toBe(1)' })).toEqual([]);
    expect(testFilesFrom('edit', { filePath: 'a.test.ts', oldString: 'x', newString: added })).toEqual([{
      path: 'a.test.ts',
      cases: [added],
      setup: '',
      source: added,
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

describe('isCommentLine', () => {
  test('matches comment lines but not a Rust attribute or a shebang', () => {
    expect(['// why', ' * @param a', '/** doc', '# note'].every(isCommentLine)).toBe(true);
    expect(['#[derive(Debug)]', '#!/usr/bin/env node', 'return a; // why'].some(isCommentLine)).toBe(false);
  });
});

describe('changesFrom', () => {
  const disk: Record<string, string> = { 'src/api.ts': 'export function get() {}', 'old.md': 'old notes' };
  const read = (path: string) => disk[path];

  test('covers any path for edit and write, with old text as contrast', () => {
    expect(changesFrom('edit', { filePath: 'src/api.ts', oldString: 'get()', newString: 'fetch()' }, read)).toEqual([{ path: 'src/api.ts', old: 'get()', new: 'fetch()' }]);
    expect(changesFrom('write', { filePath: 'src/api.ts', content: 'export function fetch() {}' }, read)).toEqual([{ path: 'src/api.ts', old: 'export function get() {}', new: 'export function fetch() {}' }]);
    expect(changesFrom('write', { filePath: 'README.md', content: '# New' }, read)).toEqual([{ path: 'README.md', new: '# New' }]);
    expect(changesFrom('read', { filePath: 'src/api.ts' }, read)).toEqual([]);
    expect(changesFrom('edit', { filePath: '', newString: 'x' }, read)).toEqual([]);
  });

  test('reads each file of a patch, and checks a move where the file ends up', () => {
    const patchText = [
      '*** Begin Patch',
      '*** Add File: docs/new.md',
      '+hello',
      '*** Update File: src/api.ts',
      '*** Move to: src/client.ts',
      '@@ export',
      ' export function get() {',
      '-  return 1',
      '+  return 2',
      '*** Delete File: old.md',
      '*** End Patch',
    ].join('\n');
    expect(changesFrom('apply_patch', { patchText }, read)).toEqual([
      { path: 'docs/new.md', new: 'hello' },
      { path: 'src/client.ts', old: 'export function get() {\n  return 1', new: 'export function get() {\n  return 2' },
      { path: 'old.md', old: 'old notes', new: '' },
    ]);
  });
});

describe('check files and commands', () => {
  test('recognizes CI, script, test, lint, type-check, and hook files', () => {
    const yes = [
      '.github/workflows/ci.yml', '/repo/.github/workflows/release.yaml', '.circleci/config.yml', '.husky/pre-commit', '.gitlab-ci.yml', 'Jenkinsfile',
      'package.json', 'pkg/package.json', 'bunfig.toml', 'tsconfig.json', 'tsconfig.build.json', 'jsconfig.json',
      'eslint.config.js', 'eslint.config.mjs', '.eslintrc.json', '.eslintrc', '.eslintignore', 'biome.json',
      'jest.config.ts', 'vitest.config.mts', 'vite.config.ts', 'playwright.config.ts', '.mocharc.yml', '.nycrc.json',
      'pyproject.toml', 'pytest.ini', 'setup.cfg', 'tox.ini', '.coveragerc', 'mypy.ini', 'ruff.toml', '.flake8',
      '.golangci.yml', '.pre-commit-config.yaml', 'lefthook.yml', 'Makefile', 'C:\\repo\\tsconfig.json',
    ];
    for (const path of yes) expect([path, isGatePath(path)]).toEqual([path, true]);
    for (const path of ['src/index.ts', 'README.md', 'src/add.test.ts', 'docs/workflows.md', 'package-lock.json', 'tsconfig.ts', '.github/CODEOWNERS']) {
      expect([path, isGatePath(path)]).toEqual([path, false]);
    }
  });

  test('reads a bash command and its workdir', () => {
    expect(commandFrom('bash', { command: 'git status', workdir: '/repo', description: 'x' })).toEqual({ command: 'git status', workdir: '/repo' });
    expect(commandFrom('bash', { command: 'ls' })).toEqual({ command: 'ls' });
    expect(commandFrom('bash', { command: '  ' })).toBeUndefined();
    expect(commandFrom('write', { command: 'git status' })).toBeUndefined();
    expect(commandFrom('bash', 'git status')).toBeUndefined();
  });

  test('scopes commands to git, tests, test folders, and check files', () => {
    for (const command of ['git commit --no-verify -m x', 'cd a && git push', 'rm src/a.test.ts', 'rm -rf tests', 'rm -r ./test/', 'mv src/__tests__ /tmp', 'sed -i s/x/y/ .eslintrc.json', 'echo \'{}\' > tsconfig.json', 'HUSKY=0 npm run release', 'bun pm pkg set scripts.test=true', 'bun set-script test true', 'rm .husky/pre-commit']) {
      expect([command, touchesGates(command)]).toEqual([command, true]);
    }
    for (const command of ['bun test', 'npm test', 'go test ./...', 'ls -la', 'bun run lint', 'cat src/index.ts', 'npx tsc --noEmit -p .', 'bun install']) {
      expect([command, touchesGates(command)]).toEqual([command, false]);
    }
  });
});

describe('definitionsIn', () => {
  test('finds functions, arrow functions, and methods, each to its closing line', () => {
    const text = [
      'import { read } from \'./read\';',
      'export function formatDate(d: Date): string {',
      '  return d.toISOString().slice(0, 10);',
      '}',
      'const isEven = (n: number) => n % 2 === 0;',
      'export const load = async (path: string): Promise<string> => {',
      '  return read(path);',
      '};',
      'export const LIMIT = 10;',
      'class Parser {',
      '  parse(text: string): number {',
      '    if (text) {',
      '      return 1;',
      '    }',
      '    return 0;',
      '  }',
      '}',
    ].join('\n');
    expect(definitionsIn(text, 'src/a.ts')).toEqual([
      { name: 'formatDate', line: 2, code: 'export function formatDate(d: Date): string {\n  return d.toISOString().slice(0, 10);\n}' },
      { name: 'isEven', line: 5, code: 'const isEven = (n: number) => n % 2 === 0;' },
      { name: 'load', line: 6, code: 'export const load = async (path: string): Promise<string> => {\n  return read(path);\n};' },
      { name: 'parse', line: 11, code: '  parse(text: string): number {\n    if (text) {\n      return 1;\n    }\n    return 0;\n  }' },
    ]);
  });

  test('finds Python, Go, Rust, and Kotlin definitions', () => {
    expect(definitionsIn('def total(values):\n    return sum(values)\n\nasync def fetch():\n    pass\n', 'a.py').map(item => [item.name, item.line])).toEqual([['total', 1], ['fetch', 4]]);
    expect(definitionsIn('func (s *Store) Save(x int) error {\n\treturn nil\n}\n', 'a.go')[0]).toEqual({ name: 'Save', line: 1, code: 'func (s *Store) Save(x int) error {\n\treturn nil\n}' });
    expect(definitionsIn('pub fn parse(s: &str) -> u32 {\n    0\n}\n', 'a.rs')[0]?.name).toBe('parse');
    expect(definitionsIn('private fun String.slug(): String {\n    return lowercase()\n}\n', 'a.kt')[0]?.name).toBe('slug');
  });

  test('skips test files and files it cannot read definitions from', () => {
    const text = 'export function a() {\n  return 1;\n}';
    expect(definitionsIn(text, 'src/a.test.ts')).toEqual([]);
    expect(definitionsIn(text, 'src/__tests__/a.ts')).toEqual([]);
    expect(definitionsIn(text, 'README.md')).toEqual([]);
    expect(definitionsIn(text, 'src/A.java')).toEqual([]);
    expect(isDefinitionFile('src/a.mjs')).toBe(true);
    expect(isDefinitionFile('test_a.py')).toBe(false);
  });
});

describe('literalsIn', () => {
  test('finds strings and numbers with their lines, and skips imports, comments, and common numbers', () => {
    const text = [
      'import { a } from \'./a\';',
      'const b = require("./b");',
      '// 42 in a comment',
      'if (qty === 42 && name === "Ada") return 210.5;',
      'for (let i = 0; i < 10; i += 1) total -= 1;',
      'const s = `hi ${name}`;',
      'const t = \'x\' + \'7\' + v2 + 3.14;',
      '\t"fmt"',
    ].join('\n');
    expect(literalsIn(text)).toEqual([
      { value: 'Ada', line: 4 },
      { value: '42', line: 4 },
      { value: '210.5', line: 4 },
      { value: '3.14', line: 7 },
    ]);
  });
});

describe('isTestSupport', () => {
  test('matches tests, fixtures, mocks, and test helpers, by folder or name', () => {
    for (const path of ['src/a.test.ts', 'test/helpers.ts', 'src/__mocks__/api.ts', 'src/__fixtures__/users.ts', 'conftest.py', 'src/testUtils.ts', 'src/test-helpers.js', 'src/fakeClock.ts', 'pkg/testdata/gen.go']) {
      expect(isTestSupport(path)).toBe(true);
    }
    for (const path of ['src/price.ts', 'src/contest.ts', 'lib/pricing.py']) expect(isTestSupport(path)).toBe(false);
  });
});
