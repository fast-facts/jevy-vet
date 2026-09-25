import { readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { splitCases, type TestFile } from './subjects.ts';

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
