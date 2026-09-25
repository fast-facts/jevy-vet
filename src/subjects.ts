interface Subject {
  path: string;
  text: string;
}

// One test file in a write, edit, or patch.
// cases: the new test text, one entry per test. Only these are judged.
// setup: new text before the first test (imports, helpers). Context only.
// source: all the new text for this file. Used to find imports.
// edited: true when only part of the file is new (edit or patch update).
export interface TestFile {
  path: string;
  cases: string[];
  setup: string;
  source: string;
  edited: boolean;
}

export function testFilesFrom(tool: string, args: unknown): TestFile[] {
  const files: TestFile[] = [];
  for (const subject of subjectsFrom(tool, args)) {
    const parts = splitCases(subject.text);
    if (parts.cases.length === 0) continue;
    const patchText = tool === 'apply_patch' && isRecord(args) ? str(args, 'patchText') ?? '' : '';
    const added = patchText.split(/\r?\n/).some(line => line.startsWith(ADD_FILE) && line.slice(ADD_FILE.length).trim() === subject.path);
    const wholeFile = tool === 'write' || added;
    files.push({ path: subject.path, cases: parts.cases, setup: parts.setup, source: subject.text, edited: !wholeFile });
  }
  return files;
}

function subjectsFrom(tool: string, args: unknown): Subject[] {
  if (!isRecord(args)) return [];
  if (tool === 'write') return fromFile(str(args, 'filePath'), str(args, 'content'));
  if (tool === 'edit') return fromFile(str(args, 'filePath'), str(args, 'newString'));
  if (tool === 'apply_patch') {
    const patchText = str(args, 'patchText');
    return patchText ? subjectsFromPatch(patchText) : [];
  }
  return [];
}

function fromFile(filePath: string | undefined, text: string | undefined): Subject[] {
  const subjects: Subject[] = [];
  if (filePath !== undefined && text !== undefined) addTest(subjects, filePath, text);
  return subjects;
}

const ADD_FILE = '*** Add File:';
const UPDATE_FILE = '*** Update File:';
const MOVE_TO = '*** Move to:';
const DELETE_FILE = '*** Delete File:';

function subjectsFromPatch(patchText: string): Subject[] {
  const subjects: Subject[] = [];
  for (const file of patchFiles(patchText)) {
    if (file.op === 'add') {
      const text = file.rows.filter(row => row.startsWith('+')).map(row => row.slice(1)).join('\n');
      addTest(subjects, file.path, text);
      continue;
    }
    if (file.op !== 'update') continue;
    const text = updatedText(file.rows);
    if (text !== undefined) addTest(subjects, file.moveTo ?? file.path, text);
  }
  return subjects;
}

function patchLines(patchText: string): { lines: string[]; begin: number; end: number } | undefined {
  const trimmed = patchText.trim();
  // A pasted `cat <<EOF` wrapper is not part of the patch.
  const heredoc = trimmed.match(/^(?:cat\s+)?<<['"]?(\w+)['"]?\s*\n([\s\S]*?)\n\1\s*$/);
  const cleaned = (heredoc?.[2] ?? trimmed).replaceAll('\r\n', '\n').replaceAll('\r', '\n');
  const lines = cleaned.split('\n');
  const begin = lines.findIndex(line => line.trim() === '*** Begin Patch');
  const end = lines.findIndex(line => line.trim() === '*** End Patch');
  if (begin === -1 || end === -1 || begin >= end) return;
  return { lines, begin, end };
}

interface PatchFile {
  op: 'add' | 'update' | 'delete';
  path: string;
  moveTo?: string;
  rows: string[];
}

// New tests use the destination path. Edits use the old path.
function patchFiles(patchText: string): PatchFile[] {
  const patch = patchLines(patchText);
  if (!patch) return [];
  const { lines, begin, end } = patch;
  const files: PatchFile[] = [];
  for (let i = begin + 1; i < end;) {
    const line = lines[i] ?? '';
    let op: PatchFile['op'] | undefined;
    let prefix = '';
    if (line.startsWith(ADD_FILE)) {
      op = 'add';
      prefix = ADD_FILE;
    } else if (line.startsWith(UPDATE_FILE)) {
      op = 'update';
      prefix = UPDATE_FILE;
    } else if (line.startsWith(DELETE_FILE)) {
      op = 'delete';
      prefix = DELETE_FILE;
    }
    if (!op) {
      i += 1;
      continue;
    }
    const path = line.slice(prefix.length).trim();
    let next = i + 1;
    let moveTo = '';
    if (op === 'update' && lines[next]?.startsWith(MOVE_TO)) {
      moveTo = lines[next]?.slice(MOVE_TO.length).trim() ?? '';
      next += 1;
    }
    if (op === 'delete') {
      files.push({ op, path, rows: [] });
      i = next;
      continue;
    }
    const hunk = linesUntilHeader(lines, next, end);
    files.push({ op, path, ...(moveTo ? { moveTo } : {}), rows: hunk.rows });
    i = hunk.next;
  }
  return files;
}

function updatedText(rows: string[]): string | undefined {
  const kept: string[] = [];
  let added = false;
  for (const row of rows) {
    if (row.startsWith('@@')) continue;
    if (row.startsWith('+') && !row.startsWith('+++')) {
      kept.push(row.slice(1));
      added = true;
    } else if (row.startsWith(' ')) kept.push(row.slice(1));
  }
  if (!added) return;
  return kept.join('\n');
}

function linesUntilHeader(lines: string[], start: number, end: number): { rows: string[]; next: number } {
  const rows: string[] = [];
  let next = start;
  while (next < end && !lines[next].startsWith('***')) {
    rows.push(lines[next]);
    next += 1;
  }
  return { rows, next };
}

function addTest(subjects: Subject[], filePath: string, text: string) {
  if (filePath === '' || text.trim() === '' || !isTestPath(filePath)) return;
  subjects.push({ path: filePath, text });
}

// Line-start markers: test(, it(, func Test, def test_, @Test.
// ponytail: not a parser. A marker inside a string can split a case wrong.
const CASE_MARK = /^[ \t]*(?:(?:test|it)(?:\.[A-Za-z]+)?\(|(?:async[ \t]+)?def test_|func Test|@Test\b)/gm;

// Text before the first marker is setup. With no marker, the whole text is one case.
export function splitCases(text: string): { cases: string[]; setup: string } {
  const marks = [...text.matchAll(CASE_MARK)];
  if (marks.length === 0) return { cases: text.trim() === '' ? [] : [text.trim()], setup: '' };
  const cases: string[] = [];
  for (let i = 0; i < marks.length; i += 1) {
    const start = marks[i]?.index ?? 0;
    const end = marks[i + 1]?.index ?? text.length;
    const part = text.slice(start, end).trim();
    if (part !== '') cases.push(part);
  }
  return { cases, setup: text.slice(0, marks[0]?.index ?? 0).trim() };
}

export function titleOf(text: string): string | undefined {
  const quoted = text.match(/^[ \t]*(?:test|it)(?:\.[A-Za-z]+)?\(\s*(['"`])((?:\\.|(?!\1).)*)\1/);
  if (quoted?.[2]) return quoted[2];
  const named = text.match(/^[ \t]*(?:(?:async[ \t]+)?def (test_\w+)|func (Test\w+))/);
  if (named) return named[1] ?? named[2];
  const java = text.match(/^[ \t]*@Test\b[\s\S]*?\b(?:void|fun)\s+(\w+)/);
  return java?.[1];
}

export function isTestPath(filePath: string): boolean {
  const normalized = filePath.replaceAll('\\', '/');
  const base = normalized.slice(normalized.lastIndexOf('/') + 1);
  if (base === '') return false;
  if (/(?:^|\/)__tests__\//.test(normalized) && /\.[cm]?[jt]sx?$/.test(base)) return true;
  if (/\.(?:test|spec)\.[cm]?[jt]sx?$/.test(base)) return true;
  if (/_test\.(?:go|rs|exs|py)$/.test(base)) return true;
  if (/^test_.+\.py$/.test(base)) return true;
  if (/Test\.(?:java|kt)$/.test(base)) return true;
  return false;
}

function str(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === 'string' ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// One test that an edit changed or removed. Old text is contrast evidence only.
// added: new tests with no old match, so a renamed test is not read as a removed one.
export interface EditPair {
  path: string;
  title?: string;
  old: string;
  new: string;
  added?: string;
}

// Old and new text of each changed test in an edit, a patch update or delete, or a write over a file on disk.
// read(path) returns the test file as it is on disk now, if it can be read.
export function editsFrom(tool: string, args: unknown, read: (path: string) => string | undefined): EditPair[] {
  if (!isRecord(args)) return [];
  if (tool === 'edit') {
    const filePath = str(args, 'filePath') ?? '';
    const oldText = str(args, 'oldString') ?? '';
    const newText = str(args, 'newString') ?? '';
    if (!isTestPath(filePath) || oldText.trim() === '') return [];
    return pairCases(filePath, oldText, newText, () => read(filePath));
  }
  if (tool === 'write') {
    const filePath = str(args, 'filePath') ?? '';
    const content = str(args, 'content');
    if (!isTestPath(filePath) || content === undefined) return [];
    const onDisk = read(filePath);
    return onDisk === undefined ? [] : pairCases(filePath, onDisk, content, () => onDisk);
  }
  if (tool !== 'apply_patch') return [];
  const pairs: EditPair[] = [];
  for (const file of patchFiles(str(args, 'patchText') ?? '')) {
    // A move only changes where the new text goes. The old tests live at this path.
    if (!isTestPath(file.path)) continue;
    if (file.op === 'delete') {
      const onDisk = read(file.path);
      if (onDisk !== undefined) pairs.push(...pairCases(file.path, onDisk, '', () => onDisk));
      continue;
    }
    if (file.op !== 'update') continue;
    for (const rows of splitHunks(file.rows)) {
      if (!rows.some(row => row.startsWith('-'))) continue;
      const oldText = rows.filter(row => !row.startsWith('+')).map(row => row.slice(1)).join('\n');
      const newText = rows.filter(row => !row.startsWith('-')).map(row => row.slice(1)).join('\n');
      pairs.push(...pairCases(file.path, oldText, newText, () => read(file.path)));
    }
  }
  return pairs;
}

function splitHunks(rows: string[]): string[][] {
  const hunks: string[][] = [[]];
  for (const row of rows) {
    if (row.startsWith('@@')) hunks.push([]);
    // A blank hunk line is a context line. Its leading space is already gone.
    else if (/^[ +-]/.test(row) || row === '') hunks[hunks.length - 1]?.push(row === '' ? ' ' : row);
  }
  return hunks.filter(hunk => hunk.length > 0);
}

// Pair old and new tests by title. Text without test markers is one pair, titled from the file on disk.
function pairCases(filePath: string, oldText: string, newText: string, readDisk: () => string | undefined): EditPair[] {
  const oldCases = splitCases(oldText).cases;
  const newCases = splitCases(newText).cases;
  const titled = (cases: string[]) => cases.length > 0 && cases.every(item => titleOf(item) !== undefined);
  if (titled(oldCases) && (newCases.length === 0 || titled(newCases))) {
    const byTitle = new Map(newCases.map(item => [titleOf(item), item]));
    const oldTitles = new Set(oldCases.map(item => titleOf(item)));
    const added = newCases.filter(item => !oldTitles.has(titleOf(item))).join('\n\n');
    const pairs: EditPair[] = [];
    for (const before of oldCases) {
      const title = titleOf(before);
      const after = byTitle.get(title) ?? '';
      if (sameCode(before, after, filePath)) continue;
      pairs.push({ path: filePath, title, old: before, new: after, ...(after === '' && added !== '' ? { added } : {}) });
    }
    return pairs;
  }
  if (sameCode(oldText, newText, filePath)) return [];
  const firstLine = oldText.split('\n').map(line => line.trim()).find(line => line !== '') ?? '';
  const disk = readDisk();
  const around = disk === undefined ? undefined : splitCases(disk).cases.find(item => item.includes(firstLine));
  const title = around === undefined ? undefined : titleOf(around);
  return [{ path: filePath, ...(title ? { title } : {}), old: oldText.trim(), new: newText.trim() }];
}

function sameCode(a: string, b: string, filePath: string): boolean {
  const flat = (text: string) => stripComments(text, filePath).replace(/\s+/g, '');
  return flat(a) === flat(b);
}

// Agents explain a weakened check in a comment. Jev judges the code, not the excuse.
// ponytail: not a parser. A comment marker inside a regex literal is treated as a comment.
export function stripComments(text: string, filePath: string): string {
  const hash = /\.py$/.test(filePath);
  let out = '';
  let quote = '';
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i] ?? '';
    if (quote) {
      out += char;
      if (char === '\\') {
        out += text[i + 1] ?? '';
        i += 1;
      } else if (char === quote) quote = '';
      continue;
    }
    if (char === '"' || char === '\'' || (char === '`' && !hash)) {
      quote = char;
      out += char;
      continue;
    }
    const lineComment = hash ? char === '#' : char === '/' && text[i + 1] === '/';
    if (lineComment) {
      while (i < text.length && text[i] !== '\n') i += 1;
      out += '\n';
      continue;
    }
    if (!hash && char === '/' && text[i + 1] === '*') {
      const close = text.indexOf('*/', i + 2);
      i = close === -1 ? text.length : close + 1;
      continue;
    }
    out += char;
  }
  return out.split('\n').map(line => line.trimEnd()).filter((line, n, all) => line !== '' || (n > 0 && all[n - 1] !== '')).join('\n').trim();
}

// One file an edit changes, test or not. Old text is contrast evidence only.
export interface Change {
  path: string;
  old?: string;
  new: string;
}

// What write, edit, and apply_patch change, for any path.
// read(path) returns the file as it is on disk now, if it can be read.
export function changesFrom(tool: string, args: unknown, read: (path: string) => string | undefined): Change[] {
  if (!isRecord(args)) return [];
  const filePath = str(args, 'filePath') ?? '';
  if (tool === 'edit') {
    const newText = str(args, 'newString');
    if (filePath === '' || newText === undefined) return [];
    return [{ path: filePath, old: str(args, 'oldString') ?? '', new: newText }];
  }
  if (tool === 'write') {
    const content = str(args, 'content');
    if (filePath === '' || content === undefined) return [];
    const onDisk = read(filePath);
    return [{ path: filePath, ...(onDisk === undefined ? {} : { old: onDisk }), new: content }];
  }
  if (tool !== 'apply_patch') return [];
  const changes: Change[] = [];
  for (const file of patchFiles(str(args, 'patchText') ?? '')) {
    if (file.path === '') continue;
    // A move is checked where the file ends up.
    const path = file.moveTo ?? file.path;
    if (file.op === 'delete') {
      changes.push({ path, old: read(file.path) ?? '', new: '' });
      continue;
    }
    const rows = file.rows.filter(row => !row.startsWith('@@'));
    const newText = rows.filter(row => !row.startsWith('-')).map(row => row.slice(1)).join('\n');
    if (file.op === 'add') {
      changes.push({ path, new: newText });
      continue;
    }
    changes.push({ path, old: rows.filter(row => !row.startsWith('+')).map(row => row.slice(1)).join('\n'), new: newText });
  }
  return changes;
}

// Files that set what CI, the tests, lint, type checks, and git hooks enforce.
const GATE_FILES = new Set([
  'package.json', 'bunfig.toml', 'deno.json', 'deno.jsonc', 'biome.json', 'biome.jsonc', '.eslintignore', '.nycrc', '.c8rc', 'codecov.yml',
  '.gitlab-ci.yml', 'azure-pipelines.yml', 'bitbucket-pipelines.yml', 'Jenkinsfile', 'Makefile',
  '.pre-commit-config.yaml', 'lefthook.yml', 'lefthook.yaml',
  'pyproject.toml', 'setup.cfg', 'pytest.ini', 'tox.ini', '.coveragerc', 'mypy.ini', 'ruff.toml', '.ruff.toml', '.flake8',
  '.golangci.yml', '.golangci.yaml', 'Cargo.toml', 'clippy.toml',
]);
const GATE_NAMES = [
  /^tsconfig(?:\.[\w-]+)?\.json$/,
  /^jsconfig\.json$/,
  /^\.eslintrc(?:\.\w+)?$/,
  /^eslint\.config\.[cm]?[jt]s$/,
  /^(?:jest|vitest|vite|playwright|cypress)\.config\.[cm]?[jt]s$/,
  /^vitest\.workspace\.[cm]?[jt]s$/,
  /^\.mocharc(?:\.\w+)?$/,
  /^karma\.conf\.[cm]?js$/,
  /^\.nycrc\.\w+$/,
  /^\.c8rc\.\w+$/,
];
const GATE_DIRS = /(?:^|\/)(?:\.github\/workflows|\.circleci|\.buildkite|\.husky)(?:\/|$)/;

export function isGatePath(filePath: string): boolean {
  const normalized = filePath.replaceAll('\\', '/');
  const base = normalized.slice(normalized.lastIndexOf('/') + 1);
  if (GATE_DIRS.test(normalized)) return true;
  return GATE_FILES.has(base) || GATE_NAMES.some(name => name.test(base));
}

export interface Command {
  command: string;
  workdir?: string;
}

export function commandFrom(tool: string, args: unknown): Command | undefined {
  if (tool !== 'bash' || !isRecord(args)) return;
  const command = str(args, 'command') ?? '';
  if (command.trim() === '') return;
  const workdir = str(args, 'workdir');
  return { command, ...(workdir ? { workdir } : {}) };
}

const TEST_DIRS = new Set(['tests', '__tests__', 'spec', 'e2e']);
const GATE_WORDS = new Set(['git', 'pkg', 'set-script', 'HUSKY']);

// Scope only, like isTestPath. Jev decides whether the command weakens a check.
// A command that names none of those words, a test, or a check file is not asked about, so `ls` or `bun test` costs no call.
export function touchesGates(command: string): boolean {
  return command.split(/[\s'"`;&|<>()=]+/).some(word => {
    const path = word.replace(/\/+$/, '');
    if (path === '') return false;
    const base = path.slice(path.lastIndexOf('/') + 1);
    // `test` alone is a subcommand, as in `bun test`. As a folder it needs a slash.
    const testDir = TEST_DIRS.has(base) || (base === 'test' && word.includes('/'));
    return GATE_WORDS.has(path) || testDir || isGatePath(path) || isTestPath(path);
  });
}

// line is 1-based in the text it came from.
export interface Definition {
  name: string;
  line: number;
  code: string;
}

const DEFINITION_FILE = /\.(?:[cm]?[jt]sx?|py|go|rs|kt)$/;
// ponytail: line starts only, not a parser. A definition split over several lines before its name is missed.
const DEFINITIONS = [
  /^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)/,
  /^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]*)?=\s*(?:async\s+)?(?:function\b|\([^)]*\)\s*(?::[^=]*)?=>|[A-Za-z_$][\w$]*\s*=>)/,
  /^\s*(?:(?:public|private|protected|static|async|override)\s+)*(?!(?:if|for|while|switch|catch|return|function|constructor)\b)([A-Za-z_$][\w$]*)\s*(?:<[^>]*>)?\([^)]*\)\s*(?::\s*[^{]+)?\{\s*$/,
  /^\s*(?:async\s+)?def\s+([A-Za-z_]\w*)/,
  /^func\s+(?:\([^)]*\)\s*)?([A-Za-z_]\w*)/,
  /^\s*(?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?(?:unsafe\s+)?fn\s+([A-Za-z_]\w*)/,
  /^\s*(?:(?:private|public|internal|protected|override|suspend|inline)\s+)*fun\s+(?:<[^>]*>\s*)?(?:[\w.]+\.)?([A-Za-z_]\w*)/,
];
const MAX_DEFINITION_LINES = 80;

export function isDefinitionFile(filePath: string): boolean {
  return isCodeFile(filePath) && !isTestPath(filePath);
}

// Source or test, in a language definitionsIn reads.
export function isCodeFile(filePath: string): boolean {
  return DEFINITION_FILE.test(filePath);
}

// Each definition runs to the first later line indented no deeper, and includes a closing brace there.
export function definitionsIn(text: string, filePath: string): Definition[] {
  if (!isDefinitionFile(filePath)) return [];
  const lines = text.split('\n');
  const found: Definition[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? '';
    let name: string | undefined;
    for (const pattern of DEFINITIONS) {
      name = line.match(pattern)?.[1];
      if (name) break;
    }
    if (!name) continue;
    const indent = line.length - line.trimStart().length;
    let end = i + 1;
    while (end < lines.length && end - i < MAX_DEFINITION_LINES) {
      const next = lines[end] ?? '';
      if (next.trim() !== '' && next.length - next.trimStart().length <= indent) {
        if (/^\s*(?:[}\])]|end\b)/.test(next)) end += 1;
        break;
      }
      end += 1;
    }
    found.push({ name, line: i + 1, code: lines.slice(i, end).join('\n').trimEnd() });
  }
  return found;
}

// Helpers, fixtures, and mocks that tests use. Canned values belong there, so the special-case check skips them.
// Takes a path relative to the project, so a project inside a folder named test is not skipped.
const SUPPORT_DIRS = new Set([...TEST_DIRS, 'test', 'testing', 'fixtures', '__fixtures__', '__mocks__', 'mocks', 'testdata', 'testutil', 'testutils']);

export function isTestSupport(filePath: string): boolean {
  const parts = filePath.replaceAll('\\', '/').split('/');
  const base = (parts.pop() ?? '').toLowerCase();
  if (isTestPath(filePath) || parts.some(part => SUPPORT_DIRS.has(part))) return true;
  if (base === 'conftest.py' || ['fixture', 'mock', 'stub', 'fake'].some(word => base.includes(word))) return true;
  return /test[-_]?(?:utils?|helpers?|support)/.test(base);
}

export interface Literal {
  // A string's text without quotes, or a number as written. '42' and 42 match.
  value: string;
  line: number;
}

const QUOTED = /(['"`])((?:\\.|(?!\1)[^\\\n])*)\1/g;
const NUMBER = /(?<![\w.$])-?\d+(?:\.\d+)?(?![\w.])/g;
// import, from, require, package, use, and a quoted path alone on a line (a Go import block).
const IMPORT_LINE = [
  /^\s*import\b/,
  /^\s*from\s+\S+\s+import\b/,
  /^\s*export\b.*\bfrom\s/,
  /^\s*(?:const|let|var)\b.*\brequire\s*\(/,
  /^\s*package\s/,
  /^\s*use\s/,
  /^\s*(?:[\w.]+\s+)?"[\w./-]+"\s*$/,
];
const COMMENT_LINE = /^\s*(?:\/\/|\/\*|\*|#)/;

// A Rust attribute or a shebang starts with # but is code.
export function isCommentLine(line: string): boolean {
  return COMMENT_LINE.test(line) && !/^\s*#[[!]/.test(line);
}

// Loop bounds and indexes more often than test data.
const COMMON_NUMBERS = new Set(['0', '1', '2', '-1', '10', '100']);

// ponytail: quotes and digits per line, not a lexer. A string over several lines, or a comment after code, is read roughly.
export function literalsIn(text: string): Literal[] {
  const found: Literal[] = [];
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? '';
    if (IMPORT_LINE.some(pattern => pattern.test(line)) || COMMENT_LINE.test(line)) continue;
    for (const match of line.matchAll(QUOTED)) {
      const value = match[2] ?? '';
      if (value.trim().length >= 2 && !value.includes('${')) found.push({ value, line: i + 1 });
    }
    for (const match of line.replace(QUOTED, '""').matchAll(NUMBER)) {
      if (!COMMON_NUMBERS.has(match[0])) found.push({ value: match[0], line: i + 1 });
    }
  }
  return found;
}
