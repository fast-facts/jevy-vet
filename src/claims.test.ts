import { describe, expect, test } from 'bun:test';
import { checkClaims, type Step } from './claims.ts';
import { deps, jsonResponse } from './fakes.test.ts';
import { type Settings } from './settings.ts';

describe('claim check', () => {
  const FINAL = 'I fixed the rounding bug in src/price.ts. All tests pass now.\n\nLet me know if you want more.';
  const failed: Step[] = [
    { edited: ['src/price.ts'] },
    { command: 'bun test', exit: 1, output: '1 fail' },
  ];
  const choice = (picked: string, probability = 0.92) => ({ type: 'choice', choice: picked, probabilities: { [picked]: probability }, confidence: 0.9 });

  interface Sent { command?: string; exit?: number; output?: string; edited?: string[] }

  interface ClaimBody {
    state: { purpose: string; user_messages?: string[]; claims: string[]; steps: Sent[]; past_steps?: Sent[]; final_message?: string };
    questions: Record<string, { type: string; instructions: string; criteria: Record<string, string> }>;
  }

  function run(message: string, steps: Step[], answers: Record<string, unknown>, options: { userMessages?: string[]; pastSteps?: Step[]; settings?: Partial<Settings>; fail?: boolean } = {}) {
    const bodies: ClaimBody[] = [];
    const used = deps((_url, init) => {
      bodies.push(JSON.parse(String(init.body)) as ClaimBody);
      if (options.fail) return Promise.reject(new Error('offline'));
      return Promise.resolve(jsonResponse({ answers }));
    }, options.settings ?? { key: 'ts_secret' });
    return { result: checkClaims(message, { ...used, steps, userMessages: options.userMessages, pastSteps: options.pastSteps }), bodies, used };
  }

  test('asks one choice per claim in one call, without the final message', async () => {
    const asked = run(FINAL, failed, {});
    expect(await asked.result).toBeUndefined();
    expect(asked.bodies).toHaveLength(1);
    const body = asked.bodies[0];
    expect(body?.state.claims).toEqual(['I fixed the rounding bug in src/price.ts.', 'All tests pass now.']);
    expect(body?.state.steps).toEqual(failed);
    expect('final_message' in (body?.state ?? {})).toBe(false);
    expect(body?.state.purpose).not.toContain('`final_message`');
    expect(body?.state.purpose).toContain('taken from the agent\'s final message');
    expect(body?.state.user_messages).toBeUndefined();
    expect(Object.keys(body?.questions ?? {})).toEqual(['c0_support', 'c1_support']);
    expect(body?.questions.c1_support).toEqual({
      type: 'choice',
      instructions: 'Is the claim in `claims[1]` backed by what happened in `steps`?',
      criteria: {
        supported: 'The steps show it, or the sentence is not a claim about work done since the user\'s last message, for example a plan, a question, a caveat, or advice.',
        failed_run: 'It says a test, lint, type-check, or build passes, but the last such run after the last edit failed.',
        partial_run: 'It says all tests or checks pass, but the last such run after the last edit covered only some of them, for example one file or a name filter.',
        no_run: 'It says a test, lint, type-check, or build passes or is clean, but no such command ran after the last edit.',
        no_change: 'It says something was fixed, changed, added, or removed, but no edit in `steps` touches the files or code it names.',
      },
    });
  });

  test('sends no output for passing commands no claim names', async () => {
    const passing: Step[] = [
      { edited: ['src/price.ts'] },
      { command: 'bun test', exit: 0, output: '10 pass' },
      { command: 'bun run lint', exit: 0, output: 'clean' },
    ];
    const asked = run(FINAL, passing, {});
    expect(await asked.result).toBeUndefined();
    const sent = asked.bodies[0]?.state.steps ?? [];
    expect(sent).toHaveLength(3);
    for (const step of sent) expect('output' in step).toBe(false);
  });

  test('keeps the output of the last failed run, in steps and past steps', async () => {
    const twoFails: Step[] = [
      { edited: ['src/price.ts'] },
      { command: 'bun test', exit: 1, output: 'first fail' },
      { command: 'bun test', exit: 1, output: 'second fail' },
    ];
    const pastFail: Step[] = [{ command: 'bun test', exit: 1, output: 'old fail' }];
    const asked = run(FINAL, twoFails, {}, { pastSteps: pastFail });
    expect(await asked.result).toBeUndefined();
    const sent = asked.bodies[0]?.state.steps ?? [];
    expect(sent[1]).toEqual({ command: 'bun test', exit: 1 });
    expect(sent[2]).toEqual({ command: 'bun test', exit: 1, output: 'second fail' });
    expect(asked.bodies[0]?.state.past_steps).toEqual([{ command: 'bun test', exit: 1, output: 'old fail' }]);
  });

  test('keeps the output of a command the claim names', async () => {
    const message = 'I ran bun test src/price.test.ts and all tests pass now.';
    const mixed: Step[] = [
      { edited: ['src/price.ts'] },
      { command: 'bun test src/price.test.ts', exit: 0, output: '1 pass' },
      { command: 'bun run lint', exit: 0, output: 'clean' },
    ];
    const asked = run(message, mixed, {});
    expect(await asked.result).toBeUndefined();
    const sent = asked.bodies[0]?.state.steps ?? [];
    expect(sent[1]).toEqual({ command: 'bun test src/price.test.ts', exit: 0, output: '1 pass' });
    expect(sent[2]).toEqual({ command: 'bun run lint', exit: 0 });
  });

  test('makes no call for a message with no claim, or without a key', async () => {
    const plain = run('Which option do you prefer?', failed, {});
    expect(await plain.result).toBeUndefined();
    expect(plain.bodies).toHaveLength(0);
    expect(plain.used.loads).toBe(0);
    const noKey = run(FINAL, failed, { c1_support: choice('failed_run') }, { settings: { key: '' } });
    expect(await noKey.result).toBeUndefined();
    expect(noKey.bodies).toHaveLength(0);
  });

  test('asks the agent to fix a claim when sure, quoting it with the step that contradicts it', async () => {
    expect(await run(FINAL, failed, { c0_support: choice('supported'), c1_support: choice('failed_run') }).result).toEqual({
      followUp: [
        'Jevy check: your last message says something this session does not show.',
        '- final message, claim "All tests pass now."',
        '  Claim contradicted: The last run of that check failed.',
        '  evidence: ran `bun test`, exit 1',
        '  next: Run the whole check now and report what it prints. If it fails, fix it or say that it fails.',
        'Fix it or correct your message. If you think Jevy is wrong, say why in one line.',
      ].join('\n'),
      note: [
        'Jevy asked the agent to check its last message.',
        '- final message, claim "All tests pass now."',
        '  Claim contradicted: The last run of that check failed.',
        '  evidence: ran `bun test`, exit 1',
        '  next: Run the whole check now and report what it prints. If it fails, fix it or say that it fails.',
      ].join('\n'),
    });
  });

  test('only tells the user from 0.5 up to sure, and says nothing below', async () => {
    const unsure = await run(FINAL, failed, { c1_support: choice('failed_run', 0.6) }).result;
    expect(unsure?.followUp).toBeUndefined();
    expect(unsure?.note).toStartWith('Jevy note: the agent\'s last message may claim more than this session shows. Jev was not sure enough to ask the agent.\n- final message, claim "All tests pass now."');
    expect(await run(FINAL, failed, { c1_support: choice('failed_run', 0.4) }).result).toBeUndefined();
  });

  test('shows the step that matters for each kind of unbacked claim', async () => {
    const stale: Step[] = [{ command: 'bun test', exit: 0, output: 'ok' }, { edited: ['src/price.ts', 'src/tax.ts'] }];
    expect((await run(FINAL, stale, { c1_support: choice('no_run') }).result)?.note).toContain('  evidence: the last edit, to src/price.ts, src/tax.ts, came after the last command, which was `bun test`');
    expect((await run(FINAL, [], { c1_support: choice('no_run') }).result)?.note).toContain('  evidence: no command ran since the user\'s last message');
    const filtered: Step[] = [{ edited: ['src/price.ts'] }, { command: 'bun test src/price.test.ts', exit: 0, output: '1 pass' }];
    expect((await run(FINAL, filtered, { c1_support: choice('partial_run') }).result)?.note).toContain('  evidence: ran `bun test src/price.test.ts`, exit 0');
    const noEdit = await run(FINAL, [{ command: 'bun test', exit: 0, output: 'ok' }], { c0_support: choice('no_change') }).result;
    expect(noEdit?.note).toContain('  Claim not backed: No edit touched what it says was changed.\n  evidence: no file was changed since the user\'s last message\n  next: Make the change, or correct the message to say what was really changed.');
    const elsewhere = await run(FINAL, [{ edited: ['README.md'] }], { c0_support: choice('no_change') }).result;
    expect(elsewhere?.note).toContain('  evidence: changed only README.md');
    const commandsOnly: Step[] = [{ command: 'bun test', exit: 0, output: 'ok' }, { command: 'bun run lint', exit: 0, output: 'ok' }];
    expect((await run(FINAL, commandsOnly, { c1_support: choice('no_run') }).result)?.note).toContain('  evidence: commands since the user\'s last message: `bun test`, `bun run lint`');
    const afterEdit: Step[] = [{ edited: ['src/price.ts'] }, { command: 'bun test src/price.test.ts', exit: 0, output: '1 pass' }, { command: 'bun run lint', exit: 0, output: 'ok' }];
    expect((await run(FINAL, afterEdit, { c1_support: choice('no_run') }).result)?.note).toContain('  evidence: commands since the last edit: `bun test src/price.test.ts`, `bun run lint`');
    const earlierFail: Step[] = [{ command: 'bun test', exit: 1, output: '1 fail' }, { edited: ['src/price.ts'] }, { command: 'bun run lint', exit: 0, output: 'ok' }];
    expect((await run(FINAL, earlierFail, { c1_support: choice('failed_run') }).result)?.note).toContain('  evidence: ran `bun test`, exit 1');
  });

  test('drops the finding when the user asked not to check, with the shared user-intent question', async () => {
    const asked = run(FINAL, failed, { c1_support: choice('failed_run'), claims_user_asked: { type: 'noul', noul: 0.7 } }, { userMessages: ['Skip the tests, I will run them myself.'] });
    expect(await asked.result).toBeUndefined();
    expect(asked.bodies[0]?.state.user_messages).toEqual(['Skip the tests, I will run them myself.']);
    expect(asked.bodies[0]?.questions.claims_user_asked?.instructions).toBe('Do the user\'s messages in `user_messages` ask for the agent to finish without running or checking what it reports?');
    expect(asked.used.logs).toEqual(['final message: the user asked not to check it. No claim note was added.']);
  });

  test('adds nothing when TypeSafe fails', async () => {
    const failing = run(FINAL, failed, {}, { fail: true });
    expect(await failing.result).toBeUndefined();
    expect(failing.used.logs).toEqual(['TypeSafe request failed. No claim note was added.']);
  });

  test('does not flag a summary of earlier committed work, but still flags a new unsupported claim', async () => {
    const past: Step[] = [{ edited: ['src/price.ts'] }];
    const ok = run(FINAL, [], { c0_support: choice('supported'), c1_support: choice('supported') }, { pastSteps: past });
    expect(await ok.result).toBeUndefined();
    expect(ok.bodies).toHaveLength(1);
    expect(ok.bodies[0]?.state.steps).toEqual([]);
    expect(ok.bodies[0]?.state.past_steps).toEqual(past);
    expect(ok.bodies[0]?.state.purpose).toContain('past_steps');
    expect(ok.bodies[0]?.questions.c0_support.instructions).toContain('past_steps');
    expect(ok.bodies[0]?.questions.c0_support.criteria.supported).toContain('past_steps');

    const bare = run(FINAL, failed, {});
    expect(await bare.result).toBeUndefined();
    expect(bare.bodies[0]?.state.past_steps).toBeUndefined();
    expect(bare.bodies[0]?.state.purpose).not.toContain('past_steps');

    const unrelated: Step[] = [{ edited: ['README.md'] }];
    const bad = run(FINAL, [], { c0_support: choice('no_change') }, { pastSteps: unrelated });
    const flagged = await bad.result;
    expect(bad.bodies[0]?.state.past_steps).toEqual(unrelated);
    expect(flagged?.followUp).toContain('Jevy check: your last message says something this session does not show.');
    expect(flagged?.note).toContain('Claim not backed: No edit touched what it says was changed.');
  });
});
