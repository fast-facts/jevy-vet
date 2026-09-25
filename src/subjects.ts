export interface Subject {
  path: string;
  text: string;
}

export function subjectsFrom(tool: string, args: unknown): Subject[] {
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

function subjectsFromPatch(patchText: string): Subject[] {
  const cleaned = stripHeredoc(patchText.trim()).replaceAll('\r\n', '\n').replaceAll('\r', '\n');
  const lines = cleaned.split('\n');
  const begin = lines.findIndex(line => line.trim() === '*** Begin Patch');
  const end = lines.findIndex(line => line.trim() === '*** End Patch');
  if (begin === -1 || end === -1 || begin >= end) return [];

  const subjects: Subject[] = [];
  let i = begin + 1;
  while (i < end) {
    const line = lines[i];
    if (line.startsWith(ADD_FILE)) {
      const hunk = linesUntilHeader(lines, i + 1, end);
      addTest(subjects, line.slice(ADD_FILE.length).trim(), addedText(hunk.rows));
      i = hunk.next;
      continue;
    }
    if (line.startsWith(UPDATE_FILE)) {
      i = addUpdatedFile(subjects, lines, i, end);
      continue;
    }
    i += 1;
  }
  return subjects;
}

function addUpdatedFile(subjects: Subject[], lines: string[], start: number, end: number): number {
  let filePath = lines[start].slice(UPDATE_FILE.length).trim();
  let i = start + 1;
  if (i < end && lines[i].startsWith(MOVE_TO)) {
    const moved = lines[i].slice(MOVE_TO.length).trim();
    if (moved) filePath = moved;
    i += 1;
  }
  const hunk = linesUntilHeader(lines, i, end);
  const text = updatedText(hunk.rows);
  if (text !== undefined) addTest(subjects, filePath, text);
  return hunk.next;
}

function addedText(rows: string[]): string {
  return rows.filter(row => row.startsWith('+')).map(row => row.slice(1)).join('\n');
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
  for (const part of casesIn(text)) subjects.push({ path: filePath, text: part });
}

// Line-start markers: test(, it(, func Test, def test_, @Test.
// ponytail: not a parser. A marker inside a string can split a case wrong.
function casesIn(text: string): string[] {
  const marks = [...text.matchAll(/^[ \t]*(?:(?:test|it)(?:\.[A-Za-z]+)?\(|func Test|def test_|@Test\b)/gm)];
  if (marks.length < 2) return [text];
  const parts: string[] = [];
  for (let i = 0; i < marks.length; i += 1) {
    const start = marks[i]?.index ?? 0;
    const end = marks[i + 1]?.index ?? text.length;
    const part = text.slice(start, end).trim();
    if (part !== '') parts.push(part);
  }
  return parts;
}

function isTestPath(filePath: string): boolean {
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

function stripHeredoc(input: string): string {
  const match = input.match(/^(?:cat\s+)?<<['"]?(\w+)['"]?\s*\n([\s\S]*?)\n\1\s*$/);
  return match?.[2] ?? input;
}

function str(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === 'string' ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
