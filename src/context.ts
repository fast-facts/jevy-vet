import { readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { isCodeFile, isTestPath, splitCases, type TestFile } from './subjects.ts';

// Context read from disk for one test file. None of it is judged.
interface Source {
  path: string;
  text: string;
  truncated: boolean;
}

export interface FileContext {
  setup: string;
  setupTruncated: boolean;
  code: Source[];
}

export interface Disk {
  root: string;
  read: (path: string) => string | undefined;
  list: (dir: string) => string[];
}

const MAX_SETUP_CHARS = 6000;
export const MAX_CODE_FILE_CHARS = 16_000;
export const MAX_CODE_CHARS = 32_000;
const MAX_FILE_BYTES = 1_000_000;
const MAX_CODE_FILES = 6;

const JS_EXTS = ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs'];

export function contextFor(file: TestFile, disk: Disk | undefined): FileContext {
  const newSetup = file.setup;
  if (!disk) return withSetup(newSetup, []);

  const testPath = isAbsolute(file.path) ? resolve(file.path) : resolve(disk.root, file.path);
  // An edit, or a fragment with no setup, may leave the imports only on disk.
  const onDisk = file.edited || newSetup === '' ? disk.read(testPath) : undefined;
  const setup = newSetup === '' && onDisk !== undefined ? splitCases(onDisk).setup : newSetup;
  const source = `${file.source}\n${onDisk ?? ''}`;

  const code: Source[] = [];
  let used = 0;
  const seen = new Set<string>([testPath]);
  for (const candidate of candidates(testPath, source, disk)) {
    if (code.length >= MAX_CODE_FILES || used >= MAX_CODE_CHARS) break;
    if (seen.has(candidate) || !inside(disk.root, candidate) || isTestFile(candidate)) continue;
    seen.add(candidate);
    const text = disk.read(candidate);
    if (text === undefined || text.trim() === '') continue;
    const budget = Math.min(MAX_CODE_FILE_CHARS, MAX_CODE_CHARS - used);
    const cut = fit(text, budget, importedNames(source));
    code.push({ path: relative(disk.root, candidate).split(sep).join('/'), text: cut.text, truncated: cut.truncated });
    used += cut.text.length;
  }
  return withSetup(setup, code);
}

function withSetup(setup: string, code: Source[]): FileContext {
  const cut = headTail(setup, MAX_SETUP_CHARS);
  return { setup: cut.text, setupTruncated: cut.truncated, code };
}

// Files that likely hold the code under test, best first.
function candidates(testPath: string, source: string, disk: Disk): string[] {
  const dir = dirname(testPath);
  const ext = extname(testPath);
  const out: string[] = [];
  if (JS_EXTS.includes(ext)) {
    for (const spec of jsImports(source)) out.push(...jsFiles(resolve(dir, spec)));
    const bare = basename(testPath).replace(/\.(?:test|spec)(\.[cm]?[jt]sx?)$/, '$1');
    const stem = bare.slice(0, bare.length - extname(bare).length);
    const dirs = basename(dir) === '__tests__' ? [dirname(dir), dir] : [dir];
    for (const base of dirs) out.push(...jsFiles(join(base, stem)));
  } else if (ext === '.py') {
    for (const mod of pyImports(source)) out.push(...pyFiles(mod, dir, disk.root));
    const stem = basename(testPath, '.py').replace(/^test_/, '').replace(/_test$/, '');
    for (const base of [dir, dirname(dir), join(dirname(dir), 'src')]) out.push(join(base, `${stem}.py`));
  } else if (ext === '.go') {
    out.push(testPath.replace(/_test\.go$/, '.go'));
    let names: string[];
    try {
      names = disk.list(dir);
    } catch {
      names = [];
    }
    for (const name of names.sort()) {
      if (name.endsWith('.go') && !name.endsWith('_test.go')) out.push(join(dir, name));
    }
  } else if (ext === '.java' || ext === '.kt') {
    const main = testPath.replace(`${sep}src${sep}test${sep}`, `${sep}src${sep}main${sep}`);
    out.push(join(dirname(main), basename(testPath).replace(/Test(\.(?:java|kt))$/, '$1')));
  } else if (ext === '.rs') {
    out.push(testPath.replace(/_test\.rs$/, '.rs'));
  }
  return out;
}

function jsImports(source: string): string[] {
  const specs: string[] = [];
  const pattern = /(?:\bfrom\s*|\bimport\s*\(?\s*|\brequire\s*\(\s*)(['"])(\.{1,2}\/[^'"]+)\1/g;
  for (const match of source.matchAll(pattern)) if (match[2]) specs.push(match[2]);
  return specs;
}

function jsFiles(target: string): string[] {
  const ext = extname(target);
  // `from './b.js'` in TypeScript is the same file as b.ts. Drop that extension before trying the others.
  const jsSpecifier = ext === '.js' || ext === '.mjs' || ext === '.cjs' || ext === '.jsx';
  const stem = jsSpecifier ? target.slice(0, -ext.length) : target;
  const files = JS_EXTS.includes(ext) ? [target] : [];
  for (const e of JS_EXTS) files.push(`${stem}${e}`);
  for (const e of JS_EXTS) files.push(join(target, `index${e}`));
  return files;
}

function pyImports(source: string): string[] {
  const mods: string[] = [];
  for (const match of source.matchAll(/^[ \t]*from\s+(\.*[\w.]*)\s+import\s+/gm)) if (match[1]) mods.push(match[1]);
  for (const match of source.matchAll(/^[ \t]*import\s+([\w.]+)/gm)) if (match[1]) mods.push(match[1]);
  return mods;
}

function pyFiles(mod: string, dir: string, root: string): string[] {
  const dots = mod.match(/^\.*/)?.[0].length ?? 0;
  const parts = mod.slice(dots).split('.').filter(Boolean);
  const bases: string[] = [];
  if (dots > 0) {
    let base = dir;
    for (let i = 1; i < dots; i += 1) base = dirname(base);
    bases.push(base);
  } else {
    // No leading dots: try each folder from the test up to the project root, then root/src.
    for (let base = dir; inside(root, base); base = dirname(base)) {
      bases.push(base);
      if (base === root || dirname(base) === base) break;
    }
    bases.push(join(root, 'src'));
  }
  const files: string[] = [];
  for (const base of bases) {
    if (parts.length === 0) continue;
    files.push(`${join(base, ...parts)}.py`, join(base, ...parts, '__init__.py'));
  }
  return files;
}

function importedNames(source: string): string[] {
  const names = new Set<string>();
  const add = (item: string | undefined) => {
    const name = item?.trim().replace(/^type\s+/, '').split(/\s+as\s+/)[0]?.trim();
    if (name) names.add(name);
  };
  for (const match of source.matchAll(/\bimport\s+(?:type\s+)?(\w+)?\s*,?\s*(?:\{([^}]*)\})?\s*from\s*['"]\.{1,2}\//g)) {
    add(match[1]);
    for (const item of (match[2] ?? '').split(',')) add(item);
  }
  for (const match of source.matchAll(/^[ \t]*from\s+\S+\s+import\s+\(?([\w\s,]+)\)?/gm)) {
    for (const item of (match[1] ?? '').split(',')) add(item);
  }
  return [...names];
}

function fit(text: string, budget: number, names: string[]): { text: string; truncated: boolean } {
  if (text.length <= budget) return { text, truncated: false };
  const parts: string[] = [];
  let used = 0;
  for (const name of names) {
    const block = definition(text, name);
    if (!block || used + block.length > budget) continue;
    parts.push(block);
    used += block.length + 5;
  }
  if (parts.length > 0) return { text: parts.join('\n...\n'), truncated: true };
  return headTail(text, budget);
}

function definition(text: string, name: string): string | undefined {
  const escaped = name.replace(/[$]/g, '\\$');
  const start = new RegExp(`^([ \\t]*)(?:export\\s+)?(?:default\\s+)?(?:async\\s+)?(?:function\\*?|class|const|let|var|def|func|interface|type|enum)\\s+${escaped}\\b`, 'm').exec(text);
  if (!start) return;
  const lines = text.slice(start.index).split('\n');
  const indent = start[1]?.length ?? 0;
  const kept: string[] = [lines[0] ?? ''];
  for (let i = 1; i < lines.length && i < 150; i += 1) {
    const line = lines[i] ?? '';
    const lead = line.length - line.trimStart().length;
    if (line.trim() !== '' && lead <= indent && /^(?:export\s|function\s|class\s|const\s|let\s|var\s|def\s|func\s|@)/.test(line.trimStart())) break;
    kept.push(line);
  }
  return kept.join('\n').trimEnd();
}

export function headTail(text: string, budget: number): { text: string; truncated: boolean } {
  if (text.length <= budget) return { text, truncated: false };
  const marker = `\n...[${text.length - budget} characters cut]...\n`;
  const room = Math.max(0, budget - marker.length);
  const head = Math.ceil(room * 2 / 3);
  return { text: `${text.slice(0, head)}${marker}${text.slice(text.length - (room - head))}`, truncated: true };
}

function isTestFile(path: string): boolean {
  const base = basename(path);
  return /\.(?:test|spec)\.[cm]?[jt]sx?$/.test(base) || /_test\.\w+$/.test(base) || /^test_.+\.py$/.test(base) || /Test\.(?:java|kt)$/.test(base);
}

function inside(root: string, path: string): boolean {
  const rel = relative(resolve(root), resolve(path));
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel) && !rel.split(sep).includes('node_modules'));
}

// Default disk access. Missing, unreadable, or huge files count as absent.
export function readSource(path: string): string | undefined {
  try {
    if (statSync(path).size > MAX_FILE_BYTES) return;
    return readFileSync(path, 'utf8');
  } catch {
    return;
  }
}

export function listDir(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

// Instruction files, found the way OpenCode 1 finds them (packages/opencode/src/session/instruction.ts).
// Read as the rules an edit is checked against. Never judged themselves.
export interface InstructionFile {
  path: string;
  text: string;
}

export interface InstructionPlaces {
  // OpenCode's worktree. The project search stops there.
  worktree: string;
  home: string;
  env: Record<string, string | undefined>;
  // The `instructions` list from the user's OpenCode config.
  configured: string[];
  glob: (pattern: string, cwd: string) => string[];
}

const INSTRUCTION_NAMES = ['AGENTS.md', 'CLAUDE.md', 'CONTEXT.md'];
const MAX_INSTRUCTION_FILE_CHARS = 8000;
const MAX_INSTRUCTION_CHARS = 24_000;
const MAX_GLOB_MATCHES = 20;

// Order: global, project, configured, then the files nearest each changed file. Later is more specific.
export function instructionFilesFor(changedPaths: string[], places: InstructionPlaces, disk: Disk): InstructionFile[] {
  const flag = (name: string) => ['true', '1'].includes((places.env[name] ?? '').toLowerCase());
  const claude = !flag('OPENCODE_DISABLE_CLAUDE_CODE') && !flag('OPENCODE_DISABLE_CLAUDE_CODE_PROMPT');
  const project = !flag('OPENCODE_DISABLE_PROJECT_CONFIG');
  const root = resolve(disk.root);
  const worktree = resolve(places.worktree);
  const paths: string[] = [];

  const xdg = places.env.XDG_CONFIG_HOME?.trim();
  const globalPaths = [join(xdg ? xdg : join(places.home, '.config'), 'opencode', 'AGENTS.md')];
  if (claude) globalPaths.push(join(places.home, '.claude', 'CLAUDE.md'));
  const firstGlobal = globalPaths.find(path => disk.read(path) !== undefined);
  if (firstGlobal) paths.push(firstGlobal);

  const names = INSTRUCTION_NAMES.filter(name => claude || name !== 'CLAUDE.md');
  if (project) {
    // The first name found anywhere between the project folder and the worktree wins, and every copy of it counts.
    for (const name of names) {
      const found: string[] = [];
      for (let dir = root; ; dir = dirname(dir)) {
        const path = join(dir, name);
        if (disk.read(path) !== undefined) found.push(path);
        if (dir === worktree || dir === dirname(dir) || !inside(worktree, dir)) break;
      }
      if (found.length === 0) continue;
      paths.push(...found.reverse());
      break;
    }
  }

  for (const entry of places.configured) {
    if (/^https?:\/\//.test(entry)) continue; // OpenCode fetches these. This plugin reads no URLs.
    const expanded = entry.startsWith('~/') ? join(places.home, entry.slice(2)) : entry;
    const matches = isAbsolute(expanded) ? places.glob(basename(expanded), dirname(expanded)) : places.glob(expanded, root);
    paths.push(...matches.slice(0, MAX_GLOB_MATCHES));
  }

  if (project) {
    for (const changed of changedPaths) {
      const nearest: string[] = [];
      const target = isAbsolute(changed) ? resolve(changed) : resolve(root, changed);
      for (let dir = dirname(target); dir !== root && inside(root, dir); dir = dirname(dir)) {
        const name = names.find(n => disk.read(join(dir, n)) !== undefined);
        if (name) nearest.push(join(dir, name));
      }
      paths.push(...nearest.reverse());
    }
  }

  const files: InstructionFile[] = [];
  let left = MAX_INSTRUCTION_CHARS;
  for (const path of [...new Set(paths)]) {
    const text = disk.read(path);
    if (text === undefined || text.trim() === '' || left <= 0) continue;
    const cut = headTail(text, Math.min(MAX_INSTRUCTION_FILE_CHARS, left)).text;
    left -= cut.length;
    files.push({ path, text: cut });
  }
  return files;
}

export function globFiles(pattern: string, cwd: string): string[] {
  try {
    return [...new Bun.Glob(pattern).scanSync({ cwd, absolute: true, onlyFiles: true })];
  } catch {
    return [];
  }
}

// Sentences and list items, one rule each. Headings, tables, and code blocks are skipped.
// ponytail: a period before a capital, as in "Mr. Smith", splits a sentence early.
export function sentencesOf(text: string): string[] {
  const out: string[] = [];
  let fenced = false;
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (line.startsWith('```')) {
      fenced = !fenced;
      continue;
    }
    if (fenced || line === '' || line.startsWith('#') || line.startsWith('|') || /^[-*_=]{3,}$/.test(line)) continue;
    const body = line.replace(/^(?:[-*+]|\d+[.)])\s+(?:\[[ xX]\]\s+)?/, '');
    for (const part of body.split(/(?<=[.!?])\s+(?=[A-Z`"'(*])/)) {
      const sentence = part.trim();
      if (sentence.length >= 8) out.push(sentence.slice(0, 400));
    }
  }
  return out;
}

// ponytail: only the root .gitignore, and no `!` patterns.
const SKIP_DIRS = new Set(['node_modules', 'vendor', 'third_party', 'dist', 'build', 'out', 'coverage', 'target', 'generated', '__generated__']);
const GENERATED_NAME = /(?:\.min\.js|\.d\.[cm]?ts|\.pb\.go|_pb2\.py|\.(?:generated|gen)\.\w+)$/;
const GENERATED_MARK = /@generated|DO NOT EDIT/;
const MAX_SOURCE_FILES = 2000;
const MAX_LISTED_ENTRIES = 20_000;
const MAX_SOURCE_FILE_CHARS = 200_000;
const MAX_RELATED_TESTS = 10;
const DOC_FILE = /\.mdx?$/i;
const NOT_DOCS = new Set(['agents.md', 'claude.md', 'context.md', 'changelog.md', 'history.md']);
const MAX_DOC_SECTIONS = 5;
const MAX_DOC_SECTION_CHARS = 1500;

export function isGenerated(path: string, text: string): boolean {
  return GENERATED_NAME.test(path) || GENERATED_MARK.test(text.slice(0, 500));
}

export interface SourceFile {
  path: string;
  text: string;
}

export function sourceFiles(disk: Disk, skip: Set<string>): SourceFile[] {
  return projectFiles(disk, path => isCodeFile(path) && !isTestPath(path) && !skip.has(join(disk.root, path)));
}

// Tests whose code under test, found the way contextFor finds it, includes this file.
export function relatedTests(disk: Disk, sourcePath: string): SourceFile[] {
  const target = resolve(disk.root, sourcePath);
  const found: SourceFile[] = [];
  for (const file of projectFiles(disk, path => isCodeFile(path) && isTestPath(path))) {
    if (!candidates(file.path, file.text, disk).includes(target)) continue;
    found.push(file);
    if (found.length >= MAX_RELATED_TESTS) break;
  }
  return found;
}

export interface DocSection {
  path: string;
  // The first line in the section that names it.
  line: number;
  name: string;
  text: string;
}

// Retrieval only, at most five. Instruction files and changelogs are skipped: they are the user's rules, or they are right to describe old behavior.
export function docSections(disk: Disk, names: string[]): DocSection[] {
  if (names.length === 0) return [];
  const found: DocSection[] = [];
  // `$` is a word in a function name, so a plain `\b` would split it.
  const words = names.map(name => {
    const escaped = name.replaceAll('$', '\\$');
    return { name, pattern: new RegExp(`(?<![\\w$])${escaped}(?![\\w$])`) };
  });
  const docs = projectFiles(disk, path => DOC_FILE.test(path) && !NOT_DOCS.has(basename(path).toLowerCase()));
  for (const doc of docs) {
    const lines = doc.text.split('\n');
    const starts = [0];
    for (let i = 1; i < lines.length; i += 1) {
      if (/^#{1,6}\s/.test(lines[i] ?? '')) starts.push(i);
    }
    starts.push(lines.length);
    for (let n = 0; n < starts.length - 1; n += 1) {
      const start = starts[n] ?? 0;
      const section = lines.slice(start, starts[n + 1]);
      for (const { name, pattern } of words) {
        const at = section.findIndex(line => pattern.test(line));
        if (at < 0) continue;
        found.push({ path: doc.path, line: start + at + 1, name, text: headTail(section.join('\n').trim(), MAX_DOC_SECTION_CHARS).text });
        if (found.length >= MAX_DOC_SECTIONS) return found;
      }
    }
  }
  return found;
}

// keep() gets the path relative to the root, so a test folder like __tests__ is seen.
function projectFiles(disk: Disk, keep: (path: string) => boolean): SourceFile[] {
  const ignored = gitignored(disk);
  const found: SourceFile[] = [];
  const dirs = [''];
  let listed = 0;
  while (dirs.length > 0 && found.length < MAX_SOURCE_FILES && listed < MAX_LISTED_ENTRIES) {
    const dir = dirs.shift() ?? '';
    for (const name of disk.list(dir === '' ? disk.root : join(disk.root, dir))) {
      listed += 1;
      const path = dir === '' ? name : `${dir}/${name}`;
      if (name.startsWith('.') || SKIP_DIRS.has(name) || ignored.some(pattern => pattern.test(path))) continue;
      if (isCodeFile(name) || DOC_FILE.test(name)) {
        if (!keep(path) || GENERATED_NAME.test(name)) continue;
        const full = join(disk.root, path);
        const text = disk.read(full);
        if (text === undefined || text.length > MAX_SOURCE_FILE_CHARS || GENERATED_MARK.test(text.slice(0, 500))) continue;
        found.push({ path: full, text });
        if (found.length >= MAX_SOURCE_FILES) break;
        continue;
      }
      // No stat on Disk. A name that is not code or markdown is a folder. list() on a file is empty.
      dirs.push(path);
    }
  }
  return found;
}

// A folder pattern also matches what is under it.
function gitignored(disk: Disk): RegExp[] {
  const patterns: RegExp[] = [];
  for (const raw of (disk.read(join(disk.root, '.gitignore')) ?? '').split('\n')) {
    const line = raw.trim().replace(/\/+$/, '');
    if (line === '' || line.startsWith('#') || line.startsWith('!')) continue;
    // Trailing slashes are already gone, so any slash left roots the pattern.
    const anchored = line.includes('/');
    let body = '';
    const glob = line.replace(/^\//, '');
    for (let i = 0; i < glob.length; i += 1) {
      const rest = glob.slice(i);
      if (rest.startsWith('**/')) {
        body += '(?:.*/)?';
        i += 2;
      } else if (rest.startsWith('**')) {
        body += '.*';
        i += 1;
      } else if (rest.startsWith('*')) body += '[^/]*';
      else if (rest.startsWith('?')) body += '[^/]';
      else body += (rest[0] ?? '').replace(/[.+^${}()|[\]\\]/g, '\\$&');
    }
    patterns.push(new RegExp(anchored ? `^${body}(?:/|$)` : `(?:^|/)${body}(?:/|$)`));
  }
  return patterns;
}
