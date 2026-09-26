import { describe, expect, test } from 'bun:test';
import { contextFor, type Disk, headTail, instructionFilesFor, type InstructionPlaces, isGenerated, MAX_CODE_CHARS, MAX_CODE_FILE_CHARS, sentencesOf } from './context.ts';
import { type TestFile, testFilesFrom } from './subjects.ts';

function disk(files: Record<string, string>, root = '/repo'): Disk & { reads: string[] } {
  const reads: string[] = [];
  return {
    root,
    reads,
    read(path) {
      reads.push(path);
      return files[path];
    },
    list(dir) {
      return Object.keys(files).filter(path => path.startsWith(`${dir}/`) && !path.slice(dir.length + 1).includes('/')).map(path => path.slice(dir.length + 1));
    },
  };
}

function written(filePath: string, content: string): TestFile {
  const file = testFilesFrom('write', { filePath, content })[0];
  if (!file) throw new Error('not a test file');
  return file;
}

function paths(file: TestFile, d: Disk): string[] {
  return contextFor(file, d).code.map(item => item.path);
}

describe('contextFor', () => {
  test('sends only the new setup when there is no disk', () => {
    const file = written('src/a.test.ts', 'import { a } from \'./a\';\ntest(\'a\', () => { expect(a()).toBe(1) })');
    expect(contextFor(file, undefined)).toEqual({ setup: 'import { a } from \'./a\';', setupTruncated: false, code: [] });
  });

  test('resolves relative TypeScript imports, a .js specifier, and an index file', () => {
    const d = disk({
      '/repo/src/a.ts': 'export const a = () => 1',
      '/repo/src/b.ts': 'export const b = () => 2',
      '/repo/src/lib/index.ts': 'export const c = () => 3',
      '/repo/node_modules/x/index.ts': 'NOPE',
    });
    const file = written('/repo/src/a.test.ts', [
      'import { a } from \'./a\';',
      'import { b } from \'./b.js\';',
      'const { c } = require(\'./lib\');',
      'import x from \'../node_modules/x\';',
      'test(\'a\', () => { expect(a()).toBe(1) })',
    ].join('\n'));
    expect(paths(file, d)).toEqual(['src/a.ts', 'src/b.ts', 'src/lib/index.ts']);
  });

  test('finds the sibling file by name, including from __tests__', () => {
    const d = disk({ '/repo/src/money.ts': 'export const cents = (n: number) => Math.round(n * 100)' });
    expect(paths(written('/repo/src/money.spec.ts', 'test(\'x\', () => {})'), d)).toEqual(['src/money.ts']);
    expect(paths(written('/repo/src/__tests__/money.ts', 'test(\'x\', () => {})'), d)).toEqual(['src/money.ts']);
  });

  test('resolves a relative path against the project folder', () => {
    const d = disk({ '/repo/src/a.ts': 'export const a = 1' });
    expect(paths(written('src/a.test.ts', 'test(\'a\', () => {})'), d)).toEqual(['src/a.ts']);
  });

  test('does not read outside the project folder or read other test files', () => {
    const d = disk({ '/etc/a.ts': 'SECRET', '/repo/src/b.test.ts': 'OTHER TEST' });
    const file = written('/repo/src/a.test.ts', 'import a from \'../../etc/a\';\nimport b from \'./b.test\';\ntest(\'a\', () => {})');
    expect(contextFor(file, d).code).toEqual([]);
    expect(d.reads).not.toContain('/etc/a.ts');
    expect(d.reads).not.toContain('/repo/src/b.test.ts');
  });

  test('finds Python code by module import, relative import, and test_ name', () => {
    const d = disk({
      '/repo/app/pricing.py': 'def total(items):\n    return sum(items)',
      '/repo/tests/helpers.py': 'def make():\n    return 1',
      '/repo/tests/cart.py': 'def cart():\n    return []',
    });
    const file = written('/repo/tests/test_cart.py', [
      'from app.pricing import total',
      'from .helpers import make',
      'def test_total():',
      '    assert total([1, 2]) == 3',
    ].join('\n'));
    expect(paths(file, d)).toEqual(['app/pricing.py', 'tests/helpers.py', 'tests/cart.py']);
  });

  test('uses the Go package files next to the test, sibling first', () => {
    const d = disk({
      '/repo/pkg/a.go': 'package pkg\nfunc A() int { return 1 }',
      '/repo/pkg/sum.go': 'package pkg\nfunc Sum(a, b int) int { return a + b }',
      '/repo/pkg/other_test.go': 'package pkg',
    });
    expect(paths(written('/repo/pkg/sum_test.go', 'func TestSum(t *testing.T) {}'), d)).toEqual(['pkg/sum.go', 'pkg/a.go']);
  });

  test('maps a Java or Kotlin test under src/test to src/main, and a Rust test to its source file', () => {
    const d = disk({
      '/repo/src/main/java/a/Cart.java': 'class Cart {}',
      '/repo/src/main/kotlin/a/Cart.kt': 'class Cart',
      '/repo/src/lib.rs': 'fn add() {}',
    });
    expect(paths(written('/repo/src/test/java/a/CartTest.java', '@Test\nvoid adds() {}'), d)).toEqual(['src/main/java/a/Cart.java']);
    expect(paths(written('/repo/src/test/kotlin/a/CartTest.kt', '@Test\nfun adds() {}'), d)).toEqual(['src/main/kotlin/a/Cart.kt']);
    expect(paths(written('/repo/src/lib_test.rs', '#[test]\nfn add() {}'), d)).toEqual(['src/lib.rs']);
  });

  test('sends only the imported definitions from a large file', () => {
    const filler = Array.from({ length: 2000 }, (_v, i) => `export function other${i}() { return ${i} }`).join('\n');
    const d = disk({ '/repo/src/big.ts': `${filler}\nexport function wanted(n: number) {\n  return n * 2\n}\n${filler}` });
    const file = written('/repo/src/big.test.ts', 'import { wanted as w } from \'./big\';\ntest(\'w\', () => { expect(w(2)).toBe(4) })');
    const code = contextFor(file, d).code[0];
    expect(code?.truncated).toBe(true);
    expect(code?.text).toBe('export function wanted(n: number) {\n  return n * 2\n}');
  });

  test('keeps the head and tail of a large file when no definition is found', () => {
    const d = disk({ '/repo/src/big.ts': `HEAD${'x'.repeat(40_000)}TAIL` });
    const code = contextFor(written('/repo/src/big.test.ts', 'test(\'x\', () => {})'), d).code[0];
    expect(code?.truncated).toBe(true);
    expect(code?.text.length).toBeLessThanOrEqual(MAX_CODE_FILE_CHARS);
    expect(code?.text).toStartWith('HEAD');
    expect(code?.text).toEndWith('TAIL');
  });

  test('stops adding code at the total budget', () => {
    const files: Record<string, string> = {};
    const imports: string[] = [];
    for (let i = 0; i < 5; i += 1) {
      files[`/repo/src/m${i}.ts`] = 'y'.repeat(15_000);
      imports.push(`import m${i} from './m${i}';`);
    }
    const code = contextFor(written('/repo/src/x.test.ts', `${imports.join('\n')}\ntest('x', () => {})`), disk(files)).code;
    expect(code.reduce((sum, item) => sum + item.text.length, 0)).toBeLessThanOrEqual(MAX_CODE_CHARS);
    expect(code.length).toBeLessThan(5);
  });

  test('takes setup and imports from the file on disk for an edit', () => {
    const d = disk({
      '/repo/src/a.test.ts': 'import { a } from \'./a\';\nconst helper = () => a();\ntest(\'old\', () => {})',
      '/repo/src/a.ts': 'export const a = () => 1',
    });
    const file = testFilesFrom('edit', { filePath: '/repo/src/a.test.ts', oldString: 'x', newString: 'test(\'new\', () => { expect(helper()).toBe(1) })' })[0];
    if (!file) throw new Error('missing');
    const context = contextFor(file, d);
    expect(context.setup).toBe('import { a } from \'./a\';\nconst helper = () => a();');
    expect(context.code.map(item => item.path)).toEqual(['src/a.ts']);
  });
});

describe('headTail', () => {
  test('leaves short text alone and cuts long text to the budget', () => {
    expect(headTail('abc', 10)).toEqual({ text: 'abc', truncated: false });
    const cut = headTail(`${'a'.repeat(500)}${'b'.repeat(500)}`, 200);
    expect(cut.truncated).toBe(true);
    expect(cut.text.length).toBeLessThanOrEqual(200);
    expect(cut.text).toStartWith('a');
    expect(cut.text).toEndWith('b');
    expect(cut.text).toContain('characters cut');
  });
});

describe('instructionFilesFor', () => {
  const places = (extra: Partial<InstructionPlaces> = {}): InstructionPlaces => ({
    worktree: '/repo',
    home: '/home/u',
    env: {},
    configured: [],
    glob: () => [],
    ...extra,
  });
  const found = (changed: string[], files: Record<string, string>, extra: Partial<InstructionPlaces> = {}, root = '/repo') =>
    instructionFilesFor(changed, places(extra), disk(files, root)).map(file => file.path);

  test('takes the global AGENTS.md before ~/.claude/CLAUDE.md, like OpenCode', () => {
    const both = { '/home/u/.config/opencode/AGENTS.md': 'global', '/home/u/.claude/CLAUDE.md': 'claude' };
    expect(found([], both)).toEqual(['/home/u/.config/opencode/AGENTS.md']);
    expect(found([], { '/home/u/.claude/CLAUDE.md': 'claude' })).toEqual(['/home/u/.claude/CLAUDE.md']);
    expect(found([], { '/x/opencode/AGENTS.md': 'xdg' }, { env: { XDG_CONFIG_HOME: '/x' } })).toEqual(['/x/opencode/AGENTS.md']);
    expect(found([], { '/home/u/.claude/CLAUDE.md': 'claude' }, { env: { OPENCODE_DISABLE_CLAUDE_CODE: '1' } })).toEqual([]);
    expect(found([], { '/home/u/.claude/CLAUDE.md': 'claude' }, { env: { OPENCODE_DISABLE_CLAUDE_CODE_PROMPT: 'true' } })).toEqual([]);
  });

  test('takes every copy of the first project file name found up to the worktree', () => {
    const files = {
      '/mono/AGENTS.md': 'top',
      '/mono/app/AGENTS.md': 'app',
      '/mono/app/CLAUDE.md': 'ignored, AGENTS.md was found first',
      '/AGENTS.md': 'above the worktree',
    };
    expect(found([], files, { worktree: '/mono' }, '/mono/app')).toEqual(['/mono/AGENTS.md', '/mono/app/AGENTS.md']);
    expect(found([], { '/repo/CLAUDE.md': 'claude' })).toEqual(['/repo/CLAUDE.md']);
    expect(found([], { '/repo/CLAUDE.md': 'claude', '/repo/CONTEXT.md': 'context' }, { env: { OPENCODE_DISABLE_CLAUDE_CODE: '1' } })).toEqual(['/repo/CONTEXT.md']);
    expect(found([], { '/repo/AGENTS.md': 'a' }, { env: { OPENCODE_DISABLE_PROJECT_CONFIG: 'true' } })).toEqual([]);
  });

  test('adds configured paths and globs but no URLs', () => {
    const globs: string[] = [];
    const glob = (pattern: string, cwd: string) => {
      globs.push(`${cwd}|${pattern}`);
      return pattern === 'docs/*.md' ? ['/repo/docs/rules.md'] : pattern === 'team.md' ? ['/home/u/team.md'] : [];
    };
    const files = { '/repo/docs/rules.md': 'rules', '/home/u/team.md': 'team' };
    expect(found([], files, { configured: ['docs/*.md', '~/team.md', 'https://example.com/rules.md'], glob })).toEqual(['/repo/docs/rules.md', '/home/u/team.md']);
    expect(globs).toEqual(['/repo|docs/*.md', '/home/u|team.md']);
  });

  test('adds the nearest instruction file in each folder above a changed file, inside the project only', () => {
    const files = {
      '/repo/AGENTS.md': 'root',
      '/repo/src/AGENTS.md': 'src',
      '/repo/src/api/CLAUDE.md': 'api',
      '/repo/src/api/CONTEXT.md': 'not used, CLAUDE.md comes first',
      '/repo/node_modules/pkg/AGENTS.md': 'package',
    };
    expect(found(['src/api/routes.ts', '/repo/node_modules/pkg/index.js'], files)).toEqual(['/repo/AGENTS.md', '/repo/src/AGENTS.md', '/repo/src/api/CLAUDE.md']);
  });

  test('cuts each file and stops at the total budget', () => {
    const big = 'x'.repeat(20_000);
    const files = { '/home/u/.config/opencode/AGENTS.md': big, '/repo/AGENTS.md': big, '/repo/a/AGENTS.md': big, '/repo/a/b/AGENTS.md': big, '/repo/a/b/c/AGENTS.md': big };
    const result = instructionFilesFor(['a/b/c/x.ts'], places(), disk(files));
    expect(result.every(file => file.text.length <= 8000)).toBe(true);
    expect(result.reduce((sum, file) => sum + file.text.length, 0)).toBeLessThanOrEqual(24_000);
    expect(result.map(file => file.path)).toEqual(['/home/u/.config/opencode/AGENTS.md', '/repo/AGENTS.md', '/repo/a/AGENTS.md']);
  });
});

describe('sentencesOf', () => {
  test('splits prose and list items into sentences and skips headings, tables, and code', () => {
    const text = [
      '# Rules',
      '',
      '- Do not edit `src/generated.ts`. It is rebuilt on every run.',
      '1. Keep the public API stable!',
      '* [ ] Ask before adding a dependency',
      '| a | b |',
      '```',
      'rm -rf / is not a sentence here.',
      '```',
      '---',
      'ok.',
      'Never change the database schema without a migration. e.g. use the tool.',
    ].join('\n');
    expect(sentencesOf(text)).toEqual([
      'Do not edit `src/generated.ts`.',
      'It is rebuilt on every run.',
      'Keep the public API stable!',
      'Ask before adding a dependency',
      // Only a capital starts a new sentence, so "e.g. use" stays whole.
      'Never change the database schema without a migration. e.g. use the tool.',
    ]);
  });

  test('cuts a very long sentence', () => {
    expect(sentencesOf('a'.repeat(1000))[0]).toHaveLength(400);
  });
});

// The sourceFiles, relatedTests, and docSections tests moved to project.test.ts
// with the code they check. The sync walk is gone. The shared async index serves them.
describe('isGenerated', () => {
  test('matches generated names and a generated mark near the top', () => {
    expect(isGenerated('src/api.pb.go', 'package api')).toBe(true);
    expect(isGenerated('src/api.ts', '// @generated by x\nexport {}')).toBe(true);
    expect(isGenerated('src/api.ts', `${'x'.repeat(600)}\n// DO NOT EDIT`)).toBe(false);
  });
});
