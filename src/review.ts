import { type Settings } from './settings.ts';
import { type Subject, subjectsFrom } from './subjects.ts';

const MODEL = 'jev-latest';
const DEFAULT_BASE = 'https://api.typesafe.ai';
const BLOCK_AT = 0.8;
const MAX_TEXT = 2000;

const CLAIMS = [
  {
    id: 'no_visible_result',
    fail: 'It does not check a result a caller could see.',
    ask: 'Does this test fail to check a result a caller could see? Answer true only if the only checks are that a mock was called, that a value is defined, that nothing was thrown, or that a value is non-empty, and that is not the whole rule. Answer false if it checks a return value, an error, or state after the call, or if this text is not a test, or if you cannot tell.',
  },
  {
    id: 'copied_expectation',
    fail: 'The expected value is computed the same way as the code under test.',
    ask: 'Is the expected value computed by the same expression as the code under test, so the test cannot fail when that rule is wrong? Answer false if the expected value is a literal, comes from a separate example, or if you cannot tell.',
  },
  {
    id: 'trivial',
    fail: 'It only tests a getter, setter, or a constructor that stores fields.',
    ask: 'Is this a test of a getter, setter, or a constructor that only stores fields, with no rule, boundary, or failure mode? Answer false if the code under test has a rule, or if you cannot tell.',
  },
  {
    id: 'no_behavior',
    fail: 'It does not check a rule, a boundary, or a failure mode.',
    ask: 'Does this test exist only to run a line, with no rule, boundary, or failure mode being checked? Answer false if it checks a real outcome, or if you cannot tell.',
  },
] as const;

export interface ReviewDeps {
  load: () => Settings;
  fetch: typeof fetch;
  log?: (message: string) => void;
}

type Prepared = Subject & {
  id: string;
  truncated: boolean;
};

interface Question {
  type: 'noul';
  instructions: string;
  criteria: { true: string; false: string };
}

export async function review(tool: string, args: unknown, deps: ReviewDeps): Promise<string | undefined> {
  const subjects = subjectsFrom(tool, args);
  if (subjects.length === 0) return;

  const names = subjects.map(subject => subject.path).join(', ');
  const settings = deps.load();
  const blocked = blockedBySettings(settings, names);
  if (blocked) return blocked;

  const tests = subjects.map(prepare);
  const answers = await callTypeSafe(deps, settings, tests);
  if (!answers) return;
  return blockMessage(tests, answers);
}

function blockedBySettings(settings: Settings, names: string): string | undefined {
  if (settings.error) return `${settings.error} Jevy blocked the test write for ${names}.`;
  if (settings.key.trim() === '') {
    return `TYPESAFE_API_KEY is not set. Jevy blocked the test write for ${names}. Add it to ${settings.path}.`;
  }
}

async function callTypeSafe(deps: ReviewDeps, settings: Settings, tests: Prepared[]): Promise<Record<string, unknown> | undefined> {
  const key = settings.key.trim();
  const base = (settings.baseUrl.trim() || DEFAULT_BASE).replace(/\/+$/, '');
  const allow = (message: string): undefined => {
    deps.log?.(message);
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
        model: MODEL,
        state: {
          purpose: 'Decide whether a new test is useless and should be blocked before it is written.',
          tests,
        },
        questions: questionsFor(tests),
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

function questionsFor(tests: Prepared[]): Record<string, Question> {
  const questions: Record<string, Question> = {};
  for (const test of tests) {
    const cut = test.truncated ? ' The text may be cut off. Answer false if you cannot tell.' : '';
    for (const claim of CLAIMS) {
      questions[`${test.id}_${claim.id}`] = {
        type: 'noul',
        instructions: `Look at test ${test.id} (${test.path}) in state.tests. ${claim.ask}${cut}`,
        criteria: { true: 'yes', false: 'no' },
      };
    }
  }
  return questions;
}

function blockMessage(tests: Prepared[], answers: Record<string, unknown>): string | undefined {
  const blocked: string[] = [];
  for (const test of tests) {
    const fails = CLAIMS.filter(claim => shouldBlock(answers[`${test.id}_${claim.id}`])).map(claim => claim.fail);
    if (fails.length === 0) continue;
    blocked.push(`${test.path}: ${fails.join(' ')}`);
  }
  if (blocked.length === 0) return;
  return ['Jevy blocked this test write.', ...blocked, 'Rewrite the test so a wrong result would fail it, or do not add it.'].join('\n');
}

function prepare(subject: Subject, index: number): Prepared {
  return {
    id: `t${index}`,
    path: subject.path,
    text: subject.text.slice(0, MAX_TEXT),
    truncated: subject.text.length > MAX_TEXT,
  };
}

function shouldBlock(value: unknown): boolean {
  if (!isRecord(value)) return false;
  if (typeof value.noul !== 'number' || value.noul < BLOCK_AT) return false;
  if (typeof value.confidence === 'number' && value.confidence < BLOCK_AT) return false;
  return true;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
