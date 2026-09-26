import { resolve } from 'node:path';
import { headTail, isGenerated } from './context.ts';
import { afterChange, askedFor, callTypeSafe, cut, type Finding, ignoredPath, listed, logOnce, noulIsSure, type Question, reader, type ReviewDeps, shownPath, sides, userAsked } from './jev.ts';
import { indexFromDisk } from './project.ts';
import { type Change, changesFrom, type Definition, definitionsIn, isCommentLine, isDefinitionFile, isTestSupport } from './subjects.ts';

// The stale-comment check. It notes and never blocks: a wrong comment misleads the next reader, but the code runs as written.
// It notes only when Jev is sure, like the reuse and hidden-error checks.
const MAX_STALE_CHANGES = 5;
const MAX_COMMENTS_PER_CHANGE = 4;
const MAX_COMMENTS = 12;
const MAX_COMMENT_CHARS = 1500;
// Shorter names match too many unrelated words in prose.
const MIN_DOC_NAME = 4;
const STALE_RULE = 'Stale comment: A comment or doc says something the changed code no longer does.';
const UPDATE_DOC = 'Update the comment or doc to match the new code. If the code is what is wrong, fix it or ask the user.';
const STALE_CRITERIA = {
  true: 'It states a parameter, return value, error, default, or behavior that the changed code no longer has, or, when `edited` is true, it claims something the code does not do.',
  false: 'It is still true of the new code, is vague enough to stay true, was updated in the same change to match, or is about code the change did not touch.',
};

interface Comment {
  // Index into the changes it is checked against.
  change: number;
  name: string;
  path: string;
  line?: number;
  // The line shown in the note: a comment's first line, or the doc line that names the function.
  quote: string;
  text: string;
  // This change wrote or changed the comment, so it is checked the other way round: does the code do what it says.
  edited?: true;
  doc?: true;
}

interface Stale {
  path: string;
  name: string;
  change: Change;
  // The first changed code line, or the function's first line when only comments changed.
  code: string;
  line?: number;
  removed?: true;
  names: string[];
}

interface StaleRequest {
  state: {
    purpose: string;
    user_messages?: string[];
    changes: { path: string; function: string; old?: string; new: string }[];
    comments: Pick<Comment, 'change' | 'path' | 'line' | 'text' | 'edited' | 'doc'>[];
  };
  questions: Record<string, Question>;
}

// Reads the changed files before its first await, so they are read as they were before the tool ran. Comments stay: they are what is judged.
export async function checkStaleDocs(tool: string, args: unknown, deps: ReviewDeps): Promise<string | undefined> {
  const disk = deps.disk;
  if (!disk) return;
  const read = reader(disk);
  const found: Stale[] = [];
  const comments: Comment[] = [];
  // A doc this same call changes is read after the tool may have written it, so it is left out.
  const changedDocs = new Set<string>();
  for (const change of changesFrom(tool, args, read)) {
    const path = shownPath(disk.root, change.path);
    if (/\.mdx?$/i.test(path)) changedDocs.add(resolve(disk.root, change.path));
    if (found.length >= MAX_STALE_CHANGES) continue;
    if (!isDefinitionFile(change.path) || ignoredPath(change.path) || isTestSupport(path)) continue;
    const onDisk = read(change.path);
    if (isGenerated(path, onDisk ?? change.new)) continue;
    const after = afterChange(change, onDisk);
    const text = after ?? change.new;
    const lines = text.split('\n');
    const oldLines = new Set((change.old ?? '').split('\n').map(line => line.trim()));
    const newLines = new Set(change.new.split('\n').map(line => line.trim()));
    const addedLines = [...newLines].filter(line => line !== '' && !oldLines.has(line));
    const prose = new Set([...proseLines(change.old ?? ''), ...proseLines(change.new)]);
    const addedCode = addedLines.filter(line => !prose.has(line));
    const removedCode = [...oldLines].filter(line => line !== '' && !newLines.has(line) && !prose.has(line));
    const codeChanged = addedCode.length > 0 || removedCode.length > 0;
    // A removed comment, with no code change, is not in scope. An added comment is.
    if (!codeChanged && addedLines.length === 0) continue;

    // A removed line is only in the file as it was.
    const removedIn = new Set(
      definitionsIn(onDisk ?? change.old ?? '', change.path)
        .filter(item => removedCode.some(line => item.code.includes(line)))
        .map(item => item.name),
    );
    const touched = definitionsIn(text, change.path).filter(item =>
      removedIn.has(item.name) || addedLines.some(line => item.code.includes(line)),
    );
    const fn = touched.at(-1);
    const name = fn ? `function "${fn.name}"` : 'top-level code';
    const codeAt = lines.findIndex(line => addedCode.includes(line.trim()));
    // A patch with several hunks cannot be placed, so it has no line numbers.
    const lineOf = (line: number) => (after === undefined ? {} : { line });
    let code: Pick<Stale, 'code' | 'line' | 'removed'> = { code: '' };
    if (codeAt >= 0) code = { code: lines[codeAt]?.trim() ?? '', ...lineOf(codeAt + 1) };
    else if (removedCode[0] !== undefined) code = { code: removedCode[0], removed: true };
    else if (fn) code = { code: fn.code.split('\n')[0]?.trim() ?? '', ...lineOf(fn.line) };
    const n = found.length;
    let kept = 0;
    for (const block of commentBlocks(lines, touched, codeAt)) {
      const edited = block.lines.some(line => addedLines.includes(line.trim()));
      // Unchanged code cannot make an unchanged comment wrong.
      if (!edited && !codeChanged) continue;
      // A bare /** or """ says nothing, so the first line with a word is shown.
      const wordAt = block.lines.findIndex(line => /\w/.test(line));
      const quoted = wordAt < 0 ? 0 : wordAt;
      comments.push({
        change: n,
        name: block.name ?? name,
        path,
        ...lineOf(block.line + quoted),
        quote: block.lines[quoted]?.trim() ?? '',
        text: headTail(block.lines.join('\n'), MAX_COMMENT_CHARS).text,
        ...(edited ? { edited: true as const } : {}),
      });
      kept += 1;
      if (kept >= MAX_COMMENTS_PER_CHANGE) break;
    }
    const names = codeChanged ? touched.map(item => item.name).filter(item => item.length >= MIN_DOC_NAME) : [];
    if (kept === 0 && names.length === 0) continue;
    found.push({ path, name, change, ...code, names });
  }
  if (found.length === 0) return;
  const settings = deps.load();
  if (settings.error || settings.key.trim() === '') return;

  // Let the tool start. The changed files were read above.
  await new Promise(resolve => setTimeout(resolve, 0));
  const project = deps.project ?? indexFromDisk(disk);
  const sections = await project.docSections([...new Set(found.flatMap(item => item.names))]).catch(() => undefined);
  if (!sections) return;
  for (const section of sections) {
    if (changedDocs.has(section.path)) continue;
    const n = found.findIndex(item => item.names.includes(section.name));
    comments.push({
      change: n,
      name: `function "${section.name}"`,
      path: shownPath(disk.root, section.path),
      line: section.line,
      quote: section.text.split('\n').find(line => line.includes(section.name))?.trim() ?? '',
      text: section.text,
      doc: true,
    });
  }
  const asked = comments.slice(0, MAX_COMMENTS);
  if (asked.length === 0) return;

  const once = logOnce(deps);
  const userMessages = deps.userMessages ?? [];
  const questions: Record<string, Question> = {};
  for (const [k, comment] of asked.entries()) {
    const at = `\`changes[${comment.change}]\``;
    questions[`c${k}_stale`] = {
      type: 'noul',
      instructions: `Is the comment or doc in \`comments[${k}]\` wrong about the code after the change in ${at}?`,
      criteria: STALE_CRITERIA,
    };
  }
  if (userMessages.length > 0) {
    for (const n of found.keys()) {
      questions[`x${n}_user_asked`] = userAsked(`the change in \`changes[${n}]\` without updating its comments or docs`, 'The user asks to change only the code and leave the comments or docs as they are, or asks for the comment as written.');
    }
  }
  const request: StaleRequest = {
    state: {
      purpose: 'Decide whether each comment or doc in `comments` is wrong about the code after the change it points to in `changes`. `old` is the text before the change, missing for a new file, and `new` is after it. Comments are kept. A comment with `edited` was written or changed by this change. A comment with `doc` is a markdown section that names the changed function. It may be about something else with the same name.',
      ...(userMessages.length > 0 ? { user_messages: userMessages } : {}),
      changes: found.map(item => ({ path: item.path, function: item.name, ...sides(item.change) })),
      comments: asked.map(item => ({
        change: item.change,
        path: item.path,
        ...(item.line === undefined ? {} : { line: item.line }),
        text: item.text,
        ...(item.edited ? { edited: item.edited } : {}),
        ...(item.doc ? { doc: item.doc } : {}),
      })),
    },
    questions,
  };
  const answers = await callTypeSafe(once, settings, request, 'No stale-comment note was added.');
  if (!answers) return;

  const findings: Finding[] = [];
  for (const [k, comment] of asked.entries()) {
    if (!noulIsSure(answers[`c${k}_stale`])) continue;
    const item = found[comment.change];
    if (!item) continue;
    if (askedFor(answers, `x${comment.change}`, once, `${item.path}: the user asked to leave the comments as they are. No stale-comment note was added.`)) continue;
    const at = comment.line === undefined ? comment.path : `${comment.path}:${comment.line}`;
    const codeAt = item.line === undefined ? item.path : `${item.path}:${item.line}`;
    findings.push({
      kind: 'stale',
      key: `${item.path}\n${comment.name}`,
      path: item.path,
      test: comment.name,
      block: false,
      fails: [STALE_RULE],
      evidence: [
        `  ${comment.doc ? 'doc' : 'comment'}: ${at} ${cut(comment.quote)}`,
        item.removed ? `  was: ${cut(item.code)}` : `  code: ${codeAt} ${cut(item.code)}`,
      ],
      next: UPDATE_DOC,
    });
  }
  if (findings.length === 0) return;
  return [
    'Jevy note: this change was made, but a comment or doc may no longer match it.',
    ...listed(findings, item => item.next),
    'Check it, and fix it if the note is right.',
  ].join('\n');
}

// Comment lines and the lines of a Python docstring, trimmed. Other triple-quoted strings count too.
function proseLines(text: string): string[] {
  const found: string[] = [];
  let quote = '';
  for (const line of text.split('\n').map(item => item.trim())) {
    if (quote !== '') {
      found.push(line);
      if (line.includes(quote)) quote = '';
      continue;
    }
    const opens = /^("""|''')/.exec(line)?.[1] ?? '';
    if (opens !== '') {
      found.push(line);
      const closedHere = line.endsWith(opens) && line.length >= opens.length * 2;
      if (!closedHere) quote = opens;
      continue;
    }
    if (isCommentLine(line)) found.push(line);
  }
  return found;
}

// The doc comment above each touched function and the comments inside it, or above the first changed line when no function is touched.
// Rough: only line comments and Python docstrings. A trailing comment after code is not seen.
function commentBlocks(lines: string[], touched: Definition[], codeAt: number): { line: number; lines: string[]; name?: string }[] {
  const blocks: { line: number; lines: string[]; name?: string }[] = [];
  const seen = new Set<number>();
  const add = (start: number, end: number, name?: string) => {
    if (start > end || seen.has(start)) return;
    seen.add(start);
    blocks.push({ line: start + 1, lines: lines.slice(start, end + 1), ...(name ? { name: `function "${name}"` } : {}) });
  };
  // Decorators may sit between a doc comment and its function.
  const above = (from: number, name?: string) => {
    let end = from - 1;
    while (end >= 0 && /^\s*@/.test(lines[end] ?? '')) end -= 1;
    let start = end;
    while (start >= 0 && isCommentLine(lines[start] ?? '')) start -= 1;
    add(start + 1, end, name);
  };
  if (touched.length === 0) {
    if (codeAt >= 0) above(codeAt);
    return blocks;
  }
  for (const item of touched) {
    above(item.line - 1, item.name);
    // The last index is the line after the function. It closes a comment run. A docstring may end there, but that line is not a comment inside the function.
    const past = item.line - 1 + item.code.split('\n').length;
    let start = -1;
    let quote = '';
    for (let i = item.line; i <= past; i += 1) {
      const line = lines[i] ?? '';
      const opens = /^\s*("""|''')/.exec(line)?.[1] ?? '';
      if (quote !== '') {
        if (line.includes(quote)) {
          add(start, i, item.name);
          quote = '';
          start = -1;
        }
        continue;
      }
      if (opens !== '' && i === item.line) {
        start = i;
        const trimmed = line.trim();
        if (trimmed.length > opens.length && trimmed.endsWith(opens)) {
          add(start, i, item.name);
          start = -1;
        } else quote = opens;
        continue;
      }
      if (isCommentLine(line) && i < past) {
        if (start < 0) start = i;
        continue;
      }
      if (start >= 0) add(start, i - 1, item.name);
      start = -1;
    }
  }
  return blocks;
}
