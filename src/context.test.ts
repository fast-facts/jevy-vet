import { describe, expect, test } from 'bun:test';
import { contextFor, type Disk, docSections, headTail, instructionFilesFor, type InstructionPlaces, isGenerated, MAX_CODE_CHARS, MAX_CODE_FILE_CHARS, relatedTests, sentencesOf, sourceFiles } from './context.ts';
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

// Lists folders as well as files, the way readdir does.
function tree(files: Record<string, string>): Disk {
  return {
    root: '/repo',
    read: path => files[path],
    list(dir) {
      const names = new Set<string>();
      for (const path of Object.keys(files)) {
        if (path.startsWith(`${dir}/`)) names.add(path.slice(dir.length + 1).split('/')[0] ?? '');
      }
      return [...names];
    },
  };
}

describe('sourceFiles', () => {
  test('reads source files and skips tests, dot folders, installed, built, generated, ignored, and given files', () => {
    const code = 'export function a() {}';
    const files: Record<string, string> = {
      '/repo/.gitignore': '# comment\n/local.ts\ncache/\n**/*.snap.ts\n!keep.ts\nsrc/legacy/*.js\n',
      '/repo/src/a.ts': code,
      '/repo/src/deep/b.py': 'def b():\n    pass',
      '/repo/src/a.test.ts': code,
      '/repo/src/__tests__/helper.ts': code,
      '/repo/src/changed.ts': code,
      '/repo/.git/x.ts': code,
      '/repo/node_modules/x/index.js': code,
      '/repo/vendor/x.go': code,
      '/repo/dist/a.js': code,
      '/repo/src/a.min.js': code,
      '/repo/src/types.d.ts': code,
      '/repo/src/api.pb.go': code,
      '/repo/src/schema.ts': `// Code generated by x. DO NOT EDIT.\n${code}`,
      '/repo/local.ts': code,
      '/repo/src/local.ts': code,
      '/repo/cache/a.ts': code,
      '/repo/src/ui/button.snap.ts': code,
      '/repo/src/legacy/old.js': code,
      '/repo/src/legacy/keep/new.js': code,
      '/repo/README.md': '# readme',
    };
    expect(sourceFiles(tree(files), new Set(['/repo/src/changed.ts'])).map(file => file.path).sort()).toEqual([
      '/repo/src/a.ts',
      '/repo/src/deep/b.py',
      '/repo/src/legacy/keep/new.js',
      '/repo/src/local.ts',
    ]);
  });

  test('skips very large files', () => {
    expect(sourceFiles(tree({ '/repo/big.ts': 'x'.repeat(200_001), '/repo/ok.ts': 'x' }), new Set()).map(file => file.path)).toEqual(['/repo/ok.ts']);
  });
});

describe('relatedTests', () => {
  test('finds tests that import or are named for the file, the way contextFor maps a test to its code', () => {
    const files: Record<string, string> = {
      '/repo/src/price.ts': 'export function total() {}',
      '/repo/src/price.test.ts': 'test(\'x\', () => {})',
      '/repo/src/__tests__/price.ts': 'test(\'y\', () => {})',
      '/repo/tests/cart.spec.ts': 'import { total } from \'../src/price.js\';',
      '/repo/tests/other.test.ts': 'import { tax } from \'../src/tax\';',
      '/repo/src/tax.ts': 'export function tax() {}',
      '/repo/py/test_price.py': 'from price import total',
      '/repo/py/price.py': 'def total():\n    pass',
    };
    expect(relatedTests(tree(files), 'src/price.ts').map(file => file.path).sort()).toEqual([
      '/repo/src/__tests__/price.ts',
      '/repo/src/price.test.ts',
      '/repo/tests/cart.spec.ts',
    ]);
    expect(relatedTests(tree(files), '/repo/py/price.py').map(file => file.path)).toEqual(['/repo/py/test_price.py']);
  });

  test('skips installed and ignored tests, and stops at ten', () => {
    const files: Record<string, string> = {
      '/repo/.gitignore': 'old/\n',
      '/repo/src/a.ts': 'export const a = 1',
      '/repo/node_modules/x/a.test.ts': 'import { a } from \'../../src/a\';',
      '/repo/old/a.test.ts': 'import { a } from \'../src/a\';',
    };
    for (let i = 0; i < 12; i += 1) files[`/repo/tests/a${i}.test.ts`] = 'import { a } from \'../src/a\';';
    const found = relatedTests(tree(files), 'src/a.ts').map(file => file.path);
    expect(found).toHaveLength(10);
    expect(found.every(path => path.startsWith('/repo/tests/'))).toBe(true);
  });
});

describe('docSections', () => {
  test('returns the markdown section that names a function as a whole word, and skips instruction files and changelogs', () => {
    const files: Record<string, string> = {
      '/repo/README.md': '# App\n\nIntro.\n\n## Retry\n\nCall `retry` to run a call again.\n\n## Other\n\nretryCount is unrelated.\n',
      '/repo/docs/guide.mdx': 'Use retry() for flaky calls.\n',
      '/repo/AGENTS.md': 'retry must stay small.\n',
      '/repo/docs/CHANGELOG.md': 'retry was added.\n',
      '/repo/node_modules/x/README.md': 'retry\n',
    };
    expect(docSections(tree(files), ['retry'])).toEqual([
      { path: '/repo/README.md', line: 7, name: 'retry', text: '## Retry\n\nCall `retry` to run a call again.' },
      { path: '/repo/docs/guide.mdx', line: 1, name: 'retry', text: 'Use retry() for flaky calls.' },
    ]);
  });

  test('stops at five sections', () => {
    const files: Record<string, string> = {};
    for (let i = 0; i < 8; i += 1) files[`/repo/docs/d${i}.md`] = `# D${i}\n\nretry here.\n`;
    expect(docSections(tree(files), ['retry'])).toHaveLength(5);
  });

  test('leaves markdown out of source files and related tests', () => {
    const files: Record<string, string> = {
      '/repo/src/a.ts': 'export function a() {}',
      '/repo/src/a.md': 'export function a() {}',
      '/repo/tests/README.md': 'import { a } from \'../src/a\';',
    };
    expect(sourceFiles(tree(files), new Set()).map(file => file.path)).toEqual(['/repo/src/a.ts']);
    expect(relatedTests(tree(files), 'src/a.ts')).toEqual([]);
  });
});

describe('isGenerated', () => {
  test('matches generated names and a generated mark near the top', () => {
    expect(isGenerated('src/api.pb.go', 'package api')).toBe(true);
    expect(isGenerated('src/api.ts', '// @generated by x\nexport {}')).toBe(true);
    expect(isGenerated('src/api.ts', `${'x'.repeat(600)}\n// DO NOT EDIT`)).toBe(false);
  });
});
