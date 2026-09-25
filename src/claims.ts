import { headTail, sentencesOf } from './context.ts';
import { askedFor, callTypeSafe, choiceLevel, cut, type Finding, isRecord, listed, logOnce, MAX_LISTED, oneLine, type Question, type ReviewDeps, userAsked } from './jev.ts';

// The claim check. It runs when the session goes idle, so the turn is over and nothing can be blocked.
const MAX_CLAIMS = 8;
const MAX_FINAL_MESSAGE_CHARS = 6000;
// Scope only, like touchesGates. A final message with none of these words makes no claim worth a call.
const CLAIM_WORDS = /\b(?:pass\w*|fail\w*|green|fix\w*|resolv\w*|works?|working|clean|lint\w*|type-?check\w*|types?|tests?|build\w*|compil\w*|verif\w*|done|complete\w*|updat\w*|add\w*|chang\w*|remov\w*|renam\w*|creat\w*|implement\w*)\b/i;
const CLAIM_CHOICES = {
  supported: 'The steps show it, or the sentence is not a claim about work done since the user\'s last message, for example a plan, a question, a caveat, or advice.',
  failed_run: 'It says a test, lint, type-check, or build passes, but the last such run after the last edit failed.',
  partial_run: 'It says all tests or checks pass, but the last such run after the last edit covered only some of them, for example one file or a name filter.',
  no_run: 'It says a test, lint, type-check, or build passes or is clean, but no such command ran after the last edit.',
  no_change: 'It says something was fixed, changed, added, or removed, but no edit in `steps` touches the files or code it names.',
};
const RERUN = 'Run the whole check now and report what it prints. If it fails, fix it or say that it fails.';
const REDO = 'Make the change, or correct the message to say what was really changed.';
// Findings only. supported is not a finding.
const BAD_CLAIMS: Record<string, { fail: string; next: string }> = {
  failed_run: { fail: 'Claim contradicted: The last run of that check failed.', next: RERUN },
  partial_run: { fail: 'Claim too broad: The last run covered only some of the tests or checks.', next: RERUN },
  no_run: { fail: 'Claim not checked: No such command ran after the last edit.', next: RERUN },
  no_change: { fail: 'Claim not backed: No edit touched what it says was changed.', next: REDO },
};
const CLAIM_PATH = 'final message';

interface RanCommand {
  command: string;
  exit: number;
  // Head and tail of what it printed.
  output: string;
}

interface Edited {
  edited: string[];
}

// What the plugin saw since the user's last message, oldest first.
export type Step = RanCommand | Edited;

interface ClaimDeps extends ReviewDeps {
  steps: Step[];
}

interface ClaimRequest {
  state: {
    purpose: string;
    user_messages?: string[];
    final_message: string;
    claims: string[];
    steps: Step[];
  };
  questions: Record<string, Question>;
}

// followUp goes to the agent, only when Jev is sure. note goes to the user.
export async function checkClaims(message: string, deps: ClaimDeps): Promise<{ followUp?: string; note: string } | undefined> {
  const claims = sentencesOf(message).filter(sentence => CLAIM_WORDS.test(sentence)).slice(0, MAX_CLAIMS);
  if (claims.length === 0) return;
  const settings = deps.load();
  if (settings.error || settings.key.trim() === '') return;

  const once = logOnce(deps);
  const userMessages = deps.userMessages ?? [];
  const questions: Record<string, Question> = {};
  for (const n of claims.keys()) {
    questions[`c${n}_support`] = {
      type: 'choice',
      instructions: `Is the claim in \`claims[${n}]\` backed by what happened in \`steps\`?`,
      criteria: CLAIM_CHOICES,
    };
  }
  if (userMessages.length > 0) {
    questions.claims_user_asked = userAsked('the agent to finish without running or checking what it reports', 'The user tells the agent not to run the tests or checks, says they will check it themselves, or says they already ran them.');
  }
  const request: ClaimRequest = {
    state: {
      purpose: 'Decide whether each claim in `claims`, taken from the agent\'s final message in `final_message`, is backed by what happened since the user\'s last message. `steps` lists, oldest first, each shell command the agent ran with its exit code and the head and tail of its output, and each file it changed. The final message came after the last step. Work done outside these tools is not seen.',
      ...(userMessages.length > 0 ? { user_messages: userMessages } : {}),
      final_message: headTail(message, MAX_FINAL_MESSAGE_CHARS).text,
      claims,
      steps: deps.steps,
    },
    questions,
  };
  const answers = await callTypeSafe(once, settings, request, 'No claim note was added.');
  if (!answers) return;

  const findings: Finding[] = [];
  for (const [n, claim] of claims.entries()) {
    const answer = answers[`c${n}_support`];
    if (!isRecord(answer) || typeof answer.choice !== 'string' || !(answer.choice in BAD_CLAIMS)) continue;
    const level = choiceLevel(answer);
    const kind = BAD_CLAIMS[answer.choice];
    if (!level) continue;
    findings.push({
      kind: 'claim',
      key: `${CLAIM_PATH}\n${claim}`,
      path: CLAIM_PATH,
      test: `claim "${cut(claim)}"`,
      block: level === 'block',
      fails: [kind.fail],
      evidence: [`  evidence: ${claimEvidence(answer.choice, deps.steps)}`],
      next: kind.next,
    });
  }
  if (findings.length === 0) return;
  if (askedFor(answers, 'claims', once, `${CLAIM_PATH}: the user asked not to check it. No claim note was added.`)) return;
  const sure = findings.filter(item => item.block);
  if (sure.length === 0) {
    return {
      note: [
        'Jevy note: the agent\'s last message may claim more than this session shows. Jev was not sure enough to ask the agent.',
        ...listed(findings, item => item.next),
      ].join('\n'),
    };
  }
  return {
    followUp: [
      'Jevy check: your last message says something this session does not show.',
      ...listed(sure, item => item.next),
      'Fix it or correct your message. If you think Jevy is wrong, say why in one line.',
    ].join('\n'),
    note: ['Jevy asked the agent to check its last message.', ...listed(sure, item => item.next)].join('\n'),
  };
}

// Copied from the steps, so the agent sees what the plugin saw. Jev picked the kind.
function claimEvidence(choice: string, steps: Step[]): string {
  const edits = steps.filter((step): step is Edited => 'edited' in step);
  const commands = steps.filter((step): step is RanCommand => 'command' in step);
  const commandOf = (step: RanCommand) => cut(oneLine(step.command));
  const ran = (step: RanCommand) => `ran \`${commandOf(step)}\`, exit ${step.exit}`;
  const lastFailed = (list: RanCommand[]) => list.filter(step => step.exit !== 0).at(-1);
  const quoted = (list: RanCommand[]) => list.slice(-3).map(step => `\`${commandOf(step)}\``).join(', ');

  if (choice === 'no_change') {
    const paths = [...new Set(edits.flatMap(step => step.edited))];
    if (paths.length === 0) return 'no file was changed since the user\'s last message';
    return `changed only ${paths.slice(0, MAX_LISTED).join(', ')}`;
  }

  const last = commands.at(-1);
  if (!last) return 'no command ran since the user\'s last message';

  const lastEdit = edits.at(-1);
  // Commands after the last edit. Every command, when nothing was edited.
  const sinceEdit = lastEdit === undefined
    ? commands
    : steps.slice(steps.indexOf(lastEdit) + 1).filter((step): step is RanCommand => 'command' in step);

  if (choice === 'failed_run') return ran(lastFailed(sinceEdit) ?? lastFailed(commands) ?? last);
  if (choice === 'partial_run') return ran(sinceEdit.at(-1) ?? last);

  // no_run. Same text if Jev returns some other kind.
  if (lastEdit === undefined) return `commands since the user's last message: ${quoted(commands)}`;
  if (sinceEdit.length === 0) return `the last edit, to ${lastEdit.edited.slice(0, MAX_LISTED).join(', ')}, came after the last command, which was \`${commandOf(last)}\``;
  return `commands since the last edit: ${quoted(sinceEdit)}`;
}
