import { isGenerated } from './context.ts';
import { afterChange, askedFor, callTypeSafe, cut, type Failure, type Finding, ignoredPath, listed, logOnce, noulIsSure, type Question, reader, type ReviewDeps, shownPath, sides, userAsked } from './jev.ts';
import { type Change, changesFrom, definitionsIn, isDefinitionFile, isTestSupport } from './subjects.ts';

// The hidden-error check. It notes and never blocks: code that keeps going after a failure is sometimes the design.
// It notes only when Jev is sure, like the reuse check.
const MAX_HIDDEN_CHANGES = 5;
const MAX_HIDDEN_LINES = 3;
const HIDDEN_RULE = 'Hidden error: The change lets a failure pass silently instead of handling it or reporting it.';
const LET_IT_FAIL = 'Let the error fail loudly or reach the caller, or handle it for real. If hiding it is meant, ask the user.';
const HIDDEN_CRITERIA = {
  true: 'It swallows an exception with an empty or log-only catch and goes on as if it worked, catches broadly and returns a default or a fake success, adds `?.`, `??`, or `|| []` to silence a crash that `last_failure` or a test showed, removes a throw or an error return, ignores a returned error (for example Go `_ = err`, or Rust `let _ =` or `unwrap_or_default()`), or turns an error into a warning.',
  false: 'The error is rethrown or wrapped with context, handled by a real recovery the caller expects, part of documented best-effort code such as cleanup, telemetry, or an optional feature, or logged and still reported to the caller.',
};
// Scope only, like touchesGates. Not a finding.
// Added: a handler, an error word, an ignored result or binding, an optional or empty default, or a warning.
// Removed: a throw, or an error return.
const ADDED_ERROR_LINE = [
  /\b(?:catch|except|rescue|recover|finally)\b/,
  /\berr(?:or)?s?\b/i,
  /\bunwrap_or\w*/,
  /\.ok\(\)/,
  /\blet\s+_\s*=/,
  /^\s*_\s*=/,
  /\?\?|\?\./,
  /\|\|\s*(?:\[\]|\{\}|''|""|0|null|undefined|false)/,
  /\bconsole\.warn\b|\bwarn(?:ing)?\(/,
];
const REMOVED_ERROR_LINE = [
  /\b(?:throw|raise|panic!?|reject)\b/,
  /\breturn\s+(?:nil,\s*)?err\b|\bErr\(/,
];

interface HiddenDeps extends ReviewDeps {
  // A guard added right after a crash is a strong sign.
  lastFailure?: Failure;
}

interface Hidden {
  path: string;
  name: string;
  change: Change;
  added: string[];
  removed: string[];
}

interface HiddenRequest {
  state: {
    purpose: string;
    user_messages?: string[];
    last_failure?: Failure;
    changes: { path: string; function: string; old?: string; new: string }[];
  };
  questions: Record<string, Question>;
}

// Reads the changed files before its first await, so they are read as they were before the tool ran. Comments stay: that is where best-effort code says so.
export async function checkHiddenErrors(tool: string, args: unknown, deps: HiddenDeps): Promise<string | undefined> {
  const disk = deps.disk;
  if (!disk) return;
  const read = reader(disk);
  const found: Hidden[] = [];
  for (const change of changesFrom(tool, args, read)) {
    const path = shownPath(disk.root, change.path);
    if (!isDefinitionFile(change.path) || ignoredPath(change.path) || isTestSupport(path)) continue;
    const onDisk = read(change.path);
    if (isGenerated(path, onDisk ?? change.new)) continue;
    const oldLines = (change.old ?? '').split('\n').map(line => line.trim());
    const newLines = change.new.split('\n').map(line => line.trim());
    const added = newLines.filter(line => line !== '' && !oldLines.includes(line) && ADDED_ERROR_LINE.some(pattern => pattern.test(line)));
    const removed = oldLines.filter(line => line !== '' && !newLines.includes(line) && REMOVED_ERROR_LINE.some(pattern => pattern.test(line)));
    const line = added[0] ?? removed[0];
    if (line === undefined) continue;
    // The file after the edit is tried first. A removed line is only in the file as it was.
    let name = 'top-level code';
    for (const text of [afterChange(change, onDisk) ?? change.new, onDisk ?? change.old ?? '']) {
      const inside = definitionsIn(text, change.path).filter(item => item.code.includes(line)).at(-1)?.name;
      if (inside) {
        name = `function "${inside}"`;
        break;
      }
    }
    found.push({ path, name, change, added, removed });
    if (found.length >= MAX_HIDDEN_CHANGES) break;
  }
  if (found.length === 0) return;
  const settings = deps.load();
  if (settings.error || settings.key.trim() === '') return;

  const once = logOnce(deps);
  const userMessages = deps.userMessages ?? [];
  const questions: Record<string, Question> = {};
  for (const n of found.keys()) {
    const at = `\`changes[${n}]\``;
    questions[`x${n}_hides_error`] = {
      type: 'noul',
      instructions: `Does the change in ${at} hide a failure instead of handling it, so an error that should stop the code or reach the caller now passes silently?`,
      criteria: HIDDEN_CRITERIA,
    };
    if (userMessages.length > 0) {
      questions[`x${n}_user_asked`] = userAsked(`the change in ${at}`, 'The user asks to ignore, suppress, or silence this error, or to make the code keep going when it fails.');
    }
  }
  const request: HiddenRequest = {
    state: {
      purpose: 'Decide whether each change in `changes` to source code hides a failure instead of handling it. `old` is the text before the change, missing for a new file, and `new` is after it. Comments are kept, because they may say the code is best effort. `last_failure`, when present, is the last command that failed. It may be unrelated.',
      ...(userMessages.length > 0 ? { user_messages: userMessages } : {}),
      ...(deps.lastFailure ? { last_failure: deps.lastFailure } : {}),
      changes: found.map(item => ({ path: item.path, function: item.name, ...sides(item.change) })),
    },
    questions,
  };
  const answers = await callTypeSafe(once, settings, request, 'No hidden-error note was added.');
  if (!answers) return;

  const findings: Finding[] = [];
  for (const [n, item] of found.entries()) {
    if (!noulIsSure(answers[`x${n}_hides_error`])) continue;
    if (askedFor(answers, `x${n}`, once, `${item.path}: the user asked to let this error pass. No hidden-error note was added.`)) continue;
    findings.push({
      kind: 'hidden',
      key: `${item.path}\n${item.name}`,
      path: item.path,
      test: item.name,
      block: false,
      fails: [HIDDEN_RULE],
      evidence: [
        ...item.removed.slice(0, MAX_HIDDEN_LINES).map(line => `  was: ${cut(line)}`),
        ...item.added.slice(0, MAX_HIDDEN_LINES).map(line => `  now: ${cut(line)}`),
      ],
      next: LET_IT_FAIL,
    });
  }
  if (findings.length === 0) return;
  return [
    'Jevy note: this change was made, but it may hide an error instead of handling it.',
    ...listed(findings, item => item.next),
    'Check it, and fix it if the note is right.',
  ].join('\n');
}
