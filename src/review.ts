import { type Settings } from './settings.ts';
import { contextFor, type Disk, type FileContext, headTail } from './context.ts';
import { type TestFile, testFilesFrom, titleOf } from './subjects.ts';

// Jev allows 32k tokens for state plus the longest question, and 64k for state plus all questions.
// A token is at least 3 characters of code, so these stay well inside both.
const MAX_CASE_CHARS = 12_000;
const MAX_STATE_CHARS = 72_000;
const MAX_QUESTIONS = 100;

interface Ref {
  test: string;
  setup: string;
  code: string;
}

interface Claim {
  id: string;
  fail: string;
  // Needs the code under test. Skipped when none was found, not asked blind.
  needsCode: boolean;
  ask: (ref: Ref) => string;
  criteria?: { true: string; false: string };
}

// One condition per question. Yes always means a problem.
const CLAIMS: readonly Claim[] = [
  {
    id: 'title_mismatch',
    fail: 'Its title promises a behavior that none of its assertions check.',
    needsCode: false,
    ask: ref => `Does the title of the test in ${ref.test} promise a behavior that none of its assertions check? Helpers it calls may be in ${ref.setup}.`,
  },
  {
    id: 'passes_on_empty',
    fail: 'It would still pass if the code returned null, an empty value, or zero.',
    needsCode: false,
    ask: ref => `Would the test in ${ref.test} still pass if the code it tests returned null, an empty value, or zero instead of the correct result? Helpers it calls may be in ${ref.setup}.`,
    criteria: {
      true: 'No assertion would notice. For example it only checks that a value is defined, that a mock was called, that nothing was thrown, or that a list is not empty.',
      false: 'An assertion compares the result with a specific expected value that null, empty, or zero would not match, or the correct result is itself null, empty, or zero and the test checks it exactly.',
    },
  },
  {
    id: 'copied_expectation',
    fail: 'The expected value is computed with the same logic as the code under test.',
    needsCode: true,
    ask: ref => `Is the expected value in the test in ${ref.test} computed with the same logic as the code in ${ref.code}?`,
    criteria: {
      true: 'The test repeats the formula, loop, or rule of the code under test to build its expected value, so it cannot fail when that rule is wrong.',
      false: 'The expected value is a literal, a worked example, or comes from a different method.',
    },
  },
  {
    id: 'mocks_code_under_test',
    fail: 'It replaces the code it tests with a mock or stub.',
    needsCode: true,
    ask: ref => `Does the test in ${ref.test} replace the function it is testing, shown in ${ref.code}, with a mock or stub?`,
    criteria: {
      true: 'The function the test calls and asserts on is itself mocked, stubbed, or spied with a fake result.',
      false: 'Only things that function depends on are mocked, or nothing is mocked.',
    },
  },
  {
    id: 'trivial_code',
    fail: 'The code it tests is only a getter, a setter, or a constructor that stores fields.',
    needsCode: true,
    ask: ref => `Is the code in ${ref.code} that the test in ${ref.test} exercises only a getter, a setter, or a constructor that stores fields?`,
  },
];

export interface ReviewDeps {
  load: () => Settings;
  fetch: (url: string, init: RequestInit) => Promise<Response>;
  log?: (message: string) => void;
  // Where to read the code under test. Without it, only the new text is sent.
  disk?: Disk;
}

interface Case {
  id: string;
  title?: string;
  test: string;
  truncated: boolean;
}

interface SentCase {
  id: string;
  title?: string;
  test: string;
  truncated?: true;
}

interface SentFile {
  path: string;
  setup: string;
  setup_truncated?: true;
  code_under_test: FileContext['code'];
  cases: SentCase[];
}

interface Prepared {
  file: TestFile;
  context: FileContext;
  cases: Case[];
}

interface Question {
  type: 'noul';
  instructions: string;
  criteria: { true: string; false: string };
}

interface Batch {
  state: { purpose: string; files: SentFile[] };
  questions: Record<string, Question>;
}

export async function review(tool: string, args: unknown, deps: ReviewDeps): Promise<string | undefined> {
  const files = testFilesFrom(tool, args);
  if (files.length === 0) return;

  const names = [...new Set(files.map(file => file.path))].join(', ');
  const settings = deps.load();
  if (settings.error) return `${settings.error} Jevy blocked the test write for ${names}.`;
  if (settings.key.trim() === '') return `TYPESAFE_API_KEY is not set. Jevy blocked the test write for ${names}. Add it to ${settings.path}.`;

  const prepared = prepare(files, deps.disk);
  const results = await Promise.all(batches(prepared).map(batch => callTypeSafe(deps, settings, batch)));
  const answers: Record<string, unknown> = {};
  for (const result of results) if (result) Object.assign(answers, result);
  return blockMessage(prepared, answers);
}

function prepare(files: TestFile[], disk: Disk | undefined): Prepared[] {
  let index = 0;
  return files.map(file => ({
    file,
    context: contextFor(file, disk),
    cases: file.cases.map(text => {
      const cut = headTail(text, MAX_CASE_CHARS);
      return { id: `t${index++}`, title: titleOf(text), test: cut.text, truncated: cut.truncated };
    }),
  }));
}

// As few requests as the size limits allow. A file split across requests carries its context in each.
function batches(prepared: Prepared[]): Batch[] {
  const out: Batch[] = [];
  let current = emptyBatch();
  let size = 0;
  for (const item of prepared) {
    let entry: SentFile | undefined;
    for (const test of item.cases) {
      const claims = CLAIMS.filter(claim => !claim.needsCode || item.context.code.length > 0);
      const caseEntry: SentCase = {
        id: test.id,
        ...(test.title ? { title: test.title } : {}),
        test: test.test,
        ...(test.truncated ? { truncated: true } : {}),
      };
      const fileBytes = entry ? 0 : JSON.stringify(fileEntry(item)).length;
      const caseBytes = JSON.stringify(caseEntry).length;
      const overQuestions = Object.keys(current.questions).length + claims.length > MAX_QUESTIONS;
      const overBytes = size + caseBytes + fileBytes > MAX_STATE_CHARS;
      if (current.state.files.length > 0 && (overQuestions || overBytes)) {
        out.push(current);
        current = emptyBatch();
        size = 0;
        entry = undefined;
      }
      if (!entry) {
        entry = fileEntry(item);
        current.state.files.push(entry);
        size += JSON.stringify(entry).length;
      }
      const fileAt = current.state.files.length - 1;
      const caseAt = entry.cases.length;
      const ref: Ref = {
        test: `\`files[${fileAt}].cases[${caseAt}].test\``,
        setup: `\`files[${fileAt}].setup\``,
        code: `\`files[${fileAt}].code_under_test\``,
      };
      entry.cases.push(caseEntry);
      size += caseBytes;
      const cut = test.truncated ? ' Part of this test is cut. Answer no if you cannot tell.' : '';
      for (const claim of claims) {
        current.questions[`${test.id}_${claim.id}`] = {
          type: 'noul',
          instructions: `${claim.ask(ref)}${cut}`,
          criteria: claim.criteria ?? { true: 'yes', false: 'no' },
        };
      }
    }
  }
  if (current.state.files.length > 0) out.push(current);
  return out;
}

function emptyBatch(): Batch {
  return {
    state: {
      purpose: 'Decide whether each new test in `files[].cases` is useless and should be blocked before it is written. Only the tests in `cases` are judged. `setup` and `code_under_test` are context read from the project.',
      files: [],
    },
    questions: {},
  };
}

function fileEntry(item: Prepared): SentFile {
  return {
    path: item.file.path,
    setup: item.context.setup,
    ...(item.context.setupTruncated ? { setup_truncated: true } : {}),
    code_under_test: item.context.code,
    cases: [],
  };
}

async function callTypeSafe(deps: ReviewDeps, settings: Settings, batch: Batch): Promise<Record<string, unknown> | undefined> {
  const key = settings.key.trim();
  const base = (settings.baseUrl.trim() || 'https://api.typesafe.ai').replace(/\/+$/, '');
  const allow = (message: string): undefined => {
    deps.log?.(message);
    return;
  };

  let response: Response;
  try {
    response = await deps.fetch(`${base}/v1/systemone`, {
      method: 'POST',
      redirect: 'error',
      signal: AbortSignal.timeout(20_000),
      headers: {
        Authorization: `Bearer ${key}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'jev-latest',
        state: batch.state,
        questions: batch.questions,
      }),
    });
  } catch {
    return allow('TypeSafe request failed. The test write was allowed.');
  }
  if (!response.ok) return allow(`TypeSafe returned ${response.status}. The test write was allowed.`);

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return allow('TypeSafe returned an unreadable response. The test write was allowed.');
  }
  if (!isRecord(body) || !isRecord(body.answers)) {
    return allow('TypeSafe returned no answers. The test write was allowed.');
  }
  return body.answers;
}

function blockMessage(prepared: Prepared[], answers: Record<string, unknown>): string | undefined {
  const blocked: string[] = [];
  for (const item of prepared) {
    for (const [n, test] of item.cases.entries()) {
      const fails = CLAIMS.filter(claim => shouldBlock(answers[`${test.id}_${claim.id}`])).map(claim => claim.fail);
      if (fails.length === 0) continue;
      const name = test.title ? `test "${test.title}"` : `test ${n + 1}`;
      blocked.push(`${item.file.path} (${name}): ${fails.join(' ')}`);
    }
  }
  if (blocked.length === 0) return;
  return ['Jevy blocked this test write.', ...blocked, 'Rewrite the test so a wrong result would fail it, or do not add it.'].join('\n');
}

function shouldBlock(value: unknown): boolean {
  const blockAt = 0.8;
  if (!isRecord(value)) return false;
  if (typeof value.noul !== 'number' || value.noul < blockAt) return false;
  if (typeof value.confidence === 'number' && value.confidence < blockAt) return false;
  return true;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
