import { readdir, readFile, stat as statFile } from 'node:fs/promises';
import { basename, dirname, extname, join, resolve } from 'node:path';
import { candidatePaths, type Disk, DOC_FILE, GENERATED_MARK, GENERATED_NAME, gitignorePatterns, headTail, MAX_DOC_SECTION_CHARS, MAX_DOC_SECTIONS, MAX_LISTED_ENTRIES, MAX_RELATED_TESTS, MAX_SOURCE_FILE_CHARS, MAX_SOURCE_FILES, NOT_DOCS, SKIP_DIRS } from './context.ts';
import { isCodeFile, isTestPath } from './subjects.ts';

// One shared walk for the reuse, special-case, and stale-comment checks. Listing is cached; text is lazy.
export interface AsyncDisk {
  root: string;
  read: (path: string) => Promise<string | undefined>;
  list: (dir: string) => Promise<{ name: string; dir: boolean }[]>;
  stat: (path: string) => Promise<{ mtimeMs: number; size: number } | undefined>;
}

export interface SourceFile {
  path: string;
  text: string;
}

export interface DocSection {
  path: string;
  // The first line in the section that names it.
  line: number;
  name: string;
  text: string;
}

// How long the blocking check waits for the first walk.
export const INDEX_WAIT_MS = 1000;
// A listing older than this is read again.
const INDEX_TTL_MS = 60_000;
const INDEX_CONCURRENCY = 16;
// Chars, close enough to bytes for cache eviction.
const MAX_CACHED_TEXT_BYTES = 64 * 1024 * 1024;

interface CachedText {
  text: string;
  mtimeMs: number;
  size: number;
}

export class ProjectIndex {
  readonly root: string;
  private disk: AsyncDisk;
  // Absolute paths in walk order. Undefined until the first walk, or after a bash call.
  private paths: string[] | undefined;
  private listedAt = 0;
  private building: Promise<void> | undefined;
  private ignored: RegExp[] | undefined;
  private texts = new Map<string, CachedText>();
  private textBytes = 0;

  constructor(disk: AsyncDisk) {
    this.root = disk.root;
    this.disk = disk;
  }

  async ensure(): Promise<void> {
    if (this.paths !== undefined && Date.now() - this.listedAt <= INDEX_TTL_MS) return;
    if (this.building !== undefined) {
      await this.building;
      return;
    }
    this.building = this.walk();
    try {
      await this.building;
    } finally {
      this.building = undefined;
    }
  }

  // Source files, skipping tests and the given paths.
  async sourceFiles(skip: Set<string>): Promise<SourceFile[]> {
    await this.ensure();
    const out: SourceFile[] = [];
    for (const path of this.paths ?? []) {
      if (out.length >= MAX_SOURCE_FILES) break;
      if (!isCodeFile(path) || isTestPath(path) || skip.has(path)) continue;
      const text = await this.readText(path);
      if (text === undefined || text.length > MAX_SOURCE_FILE_CHARS || GENERATED_MARK.test(text.slice(0, 500))) continue;
      out.push({ path, text });
    }
    return out;
  }

  // Tests whose code under test includes this file.
  async relatedTests(sourcePath: string): Promise<SourceFile[]> {
    await this.ensure();
    const target = resolve(this.root, sourcePath);
    const found: SourceFile[] = [];
    for (const path of this.paths ?? []) {
      if (found.length >= MAX_RELATED_TESTS) break;
      if (!isCodeFile(path) || !isTestPath(path)) continue;
      const text = await this.readText(path);
      if (text === undefined || text.length > MAX_SOURCE_FILE_CHARS || GENERATED_MARK.test(text.slice(0, 500))) continue;
      if (!candidatePaths(path, text, this.root, this.dirNames(path)).includes(target)) continue;
      found.push({ path, text });
    }
    return found;
  }

  // Retrieval only, at most five. Instruction files and changelogs are skipped.
  async docSections(names: string[]): Promise<DocSection[]> {
    if (names.length === 0) return [];
    await this.ensure();
    // `$` is a word in a function name, so a plain `\b` would split it.
    const words = names.map(name => {
      const escaped = name.replaceAll('$', '\\$');
      return { name, pattern: new RegExp(`(?<![\\w$])${escaped}(?![\\w$])`) };
    });
    const found: DocSection[] = [];
    for (const path of this.paths ?? []) {
      if (!DOC_FILE.test(path) || NOT_DOCS.has(basename(path).toLowerCase())) continue;
      const text = await this.readText(path);
      if (text === undefined || text.length > MAX_SOURCE_FILE_CHARS || GENERATED_MARK.test(text.slice(0, 500))) continue;
      const lines = text.split('\n');
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
          found.push({ path, line: start + at + 1, name, text: headTail(section.join('\n').trim(), MAX_DOC_SECTION_CHARS).text });
          if (found.length >= MAX_DOC_SECTIONS) return found;
        }
      }
    }
    return found;
  }

  // Forget cached text for paths a call changed.
  markStale(paths: string[]): void {
    for (const path of paths) this.drop(resolve(this.root, path));
  }

  // Forget the listing. Called after any bash command.
  markListingStale(): void {
    this.paths = undefined;
  }

  private async readText(path: string): Promise<string | undefined> {
    const cached = this.texts.get(path);
    const info = await this.disk.stat(path).catch(() => undefined);
    if (cached !== undefined && (info === undefined || (cached.mtimeMs === info.mtimeMs && cached.size === info.size))) {
      // Move to the end, so eviction drops the oldest first.
      this.texts.delete(path);
      this.texts.set(path, cached);
      return cached.text;
    }
    const text = await this.disk.read(path).catch(() => undefined);
    if (text === undefined) {
      this.drop(path);
      return;
    }
    this.store(path, text, info);
    return text;
  }

  private store(path: string, text: string, info: { mtimeMs: number; size: number } | undefined): void {
    this.drop(path);
    while (this.textBytes + text.length > MAX_CACHED_TEXT_BYTES && this.texts.size > 0) {
      const oldest = this.texts.keys().next().value;
      if (oldest === undefined) break;
      this.drop(oldest);
    }
    this.texts.set(path, { text, ...(info ?? { mtimeMs: 0, size: text.length }) });
    this.textBytes += text.length;
  }

  private drop(path: string): void {
    const cached = this.texts.get(path);
    if (cached === undefined) return;
    this.texts.delete(path);
    this.textBytes -= cached.text.length;
  }

  // File names next to a Go test.
  private dirNames(testPath: string): string[] {
    if (extname(testPath) !== '.go') return [];
    const dir = dirname(testPath);
    const names: string[] = [];
    for (const path of this.paths ?? []) {
      if (dirname(path) !== dir) continue;
      names.push(basename(path));
    }
    return names;
  }

  private async walk(): Promise<void> {
    const root = this.disk.root;
    if (this.ignored === undefined) {
      const text = await this.disk.read(join(root, '.gitignore')).catch(() => undefined);
      this.ignored = gitignorePatterns(text ?? '');
    }
    const ignored = this.ignored;
    const found: string[] = [];
    const queue: string[] = [''];
    let listed = 0;
    let stopped = false;
    const take = async (): Promise<void> => {
      while (queue.length > 0 && !stopped) {
        if (found.length >= MAX_SOURCE_FILES || listed >= MAX_LISTED_ENTRIES) {
          stopped = true;
          return;
        }
        const dir = queue.shift() ?? '';
        const entries = await this.disk.list(dir === '' ? root : join(root, dir)).catch(() => []);
        for (const entry of entries) {
          listed += 1;
          if (listed > MAX_LISTED_ENTRIES || found.length >= MAX_SOURCE_FILES) {
            stopped = true;
            break;
          }
          const relative = dir === '' ? entry.name : `${dir}/${entry.name}`;
          if (entry.name.startsWith('.') || SKIP_DIRS.has(entry.name) || ignored.some(pattern => pattern.test(relative))) continue;
          if (isCodeFile(entry.name) || DOC_FILE.test(entry.name)) {
            if (GENERATED_NAME.test(entry.name)) continue;
            found.push(join(root, relative));
            continue;
          }
          if (entry.dir) queue.push(relative);
        }
      }
    };
    await Promise.all(Array.from({ length: INDEX_CONCURRENCY }, () => take()));
    this.paths = found;
    this.listedAt = Date.now();
  }
}

// Missing, unreadable, or huge files count as absent.
export function productionAsyncDisk(root: string): AsyncDisk {
  return {
    root,
    read: async path => {
      try {
        if ((await statFile(path)).size > MAX_SOURCE_FILE_CHARS) return;
        return await readFile(path, 'utf8');
      } catch {
        return;
      }
    },
    list: async dir => {
      try {
        return (await readdir(dir, { withFileTypes: true })).map(entry => ({ name: entry.name, dir: entry.isDirectory() }));
      } catch {
        return [];
      }
    },
    stat: async path => {
      try {
        const info = await statFile(path);
        return { mtimeMs: info.mtimeMs, size: info.size };
      } catch {
        return;
      }
    },
  };
}

// A throwaway index over a sync disk, used when no shared index was passed.
export function indexFromDisk(disk: Disk): ProjectIndex {
  return new ProjectIndex({
    root: disk.root,
    read: path => Promise.resolve(disk.read(path)),
    // No stat on Disk. A name that is not code or markdown is a folder. list() on a file is empty.
    list: dir => Promise.resolve(disk.list(dir).map(name => ({ name, dir: !isCodeFile(name) && !DOC_FILE.test(name) }))),
    stat: () => Promise.resolve(undefined),
  });
}
