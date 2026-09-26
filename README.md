# jevy-vet

[![version](https://img.shields.io/npm/v/jevy-vet?style=for-the-badge&logo=npm&logoColor=white&label=version)](https://www.npmjs.com/package/jevy-vet)
[![downloads](https://img.shields.io/npm/dm/jevy-vet?style=for-the-badge&logo=npm&logoColor=white)](https://www.npmjs.com/package/jevy-vet)
[![CI](https://img.shields.io/github/actions/workflow/status/fast-facts/jevy-vet/master.cron.publish.yml?branch=master&style=for-the-badge&logo=github&logoColor=white&label=CI)](https://github.com/fast-facts/jevy-vet/actions/workflows/master.cron.publish.yml)
[![CodeQL](https://img.shields.io/github/actions/workflow/status/fast-facts/jevy-vet/master.cron.code-analyze.yml?branch=master&style=for-the-badge&logo=github&logoColor=white&label=CodeQL)](https://github.com/fast-facts/jevy-vet/actions/workflows/master.cron.code-analyze.yml)
[![license](https://img.shields.io/github/license/fast-facts/jevy-vet?style=for-the-badge)](./LICENSE)

An OpenCode plugin that stops a weak test before the file is written. It also stops a change that turns a check off, or that fakes a test's answer. It tells the agent when an edit may break your instructions, repeat code you already have, hide an error, or leave a comment or doc wrong. It also tells the agent when its last message claims more than it did.

When an agent adds or changes a test, the plugin asks TypeSafe Jev if a new test is useless, or if a changed test no longer checks the same thing. If Jev is sure, the write is blocked. You do not set up Jev yourself. The plugin calls TypeSafe.

## Install

OpenCode installs the npm package `jevy-vet` when it starts. You do not install it yourself.

### 1. Save your TypeSafe key

Put the key in `~/.config/opencode/jevy-vet.jsonc`, next to `opencode.json` or `opencode.jsonc`.

If `XDG_CONFIG_HOME` is set, use `$XDG_CONFIG_HOME/opencode/jevy-vet.jsonc` instead.

```jsonc
{
  "TYPESAFE_API_KEY": "ts_..."
}
```

Comments and a trailing comma are fine. If the `.jsonc` file is missing, `jevy-vet.json` is used instead.

`TYPESAFE_BASE_URL` is optional. Leave it out to use `https://api.typesafe.ai`.

The plugin does not read the key from the environment. A file in the project cannot replace this one, so the key stays out of the repo.

### 2. Turn the plugin on

Add `jevy-vet` to the plugin list. Use the project file `opencode.json` or `opencode.jsonc`, or the global file `~/.config/opencode/opencode.jsonc`.

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["jevy-vet"]
}
```

Keep plugins you already have. Add `jevy-vet` to that same list. To lock a version, use `"jevy-vet@1.2.3"`.

This works with OpenCode 1 only. OpenCode 2 does not run an OpenCode 1 plugin. Changing the config will not make it run there.

### 3. Restart OpenCode

Quit OpenCode and start it again. A session that is already open keeps the old config.

## Which files

It watches `write`, `edit`, and `apply_patch`, and some `bash` commands. The test checks only look at paths that look like tests, such as `*.test.ts`, `*.spec.tsx`, `*_test.go`, `test_*.py`, `*Test.java`, and files under `__tests__/`.

A file with more than one test is judged one test at a time. One bad test blocks the write.

## New tests

The write is blocked when Jev is sure a test fails one of these rules:

- Its title promises a behavior that none of its assertions check.
- It would still pass if the code returned null, an empty value, or zero.
- The expected value is computed with the same logic as the code under test.
- It replaces the code it tests with a mock or stub.
- The code it tests is only a getter, a setter, or a constructor that stores fields.

Only the new test text is judged. Jev also sees that file's setup and the code under test, as context. They are not judged.

The plugin reads the code under test from the project folder. It follows relative imports and looks for the usual source file for that test. It does not read outside the project, inside `node_modules`, or other test files. A large file is cut to the imported definitions, or to its start and end. If none is found, the last three rules are skipped.

## Changed tests

This runs when an agent changes a test that is already on disk. That includes an `edit`, a patch that updates or deletes lines, or a `write` over an existing test file.

Comments are removed first. Then the old check is compared with the new one.

The edit is blocked when Jev is sure of any of these:

- The check got weaker.
- A check now expects the opposite, or was removed or turned off.
- The expected value changed.
- A test was removed and nothing replaced it.

These are allowed:

- A stronger check.
- The same check, written a different way.
- A change that does not touch the check.

The message shows the lines that changed. It tells the agent to fix the code, or to stop and ask you if the old test is wrong.

## When you asked for the change

Your own words allow the edit. This covers every check on this page. The plugin keeps your last three messages for that session, in memory only, and sends the latest one with the edit so Jev can tell.

Asking to fix a failure, or to make the tests pass, does not count. A prompt written by another agent does not count. With no message from you, nothing is treated as asked for.

## Changes to checks

This runs when an agent changes a file that sets what CI, the tests, lint, type checks, or git hooks enforce. That includes `.github/workflows/`, `package.json`, `bunfig.toml`, `tsconfig.json`, ESLint, Jest, and Vitest config, `.husky/`, and `pyproject.toml`. Jev is asked whether the change weakens or bypasses a check, for example by removing or skipping a step, adding `continue-on-error` or `|| true`, loosening a threshold, excluding files, or turning a rule off.

It also runs before a `bash` command that names `git`, `pkg`, `set-script`, `HUSKY`, a test, or one of those files, such as `git commit --no-verify` or a `sed` edit to `tsconfig.json`. Other commands are not sent.

When Jev is sure, the change or command is blocked. When it is not sure, it goes through with a note. Jev also sees the last command that failed, as context.

## Code that fakes a test's answer

When an agent changes a source file, the plugin looks for the tests of that file: tests that import it or are named after it. If a new line in the change uses a value that is also in one of those tests, such as `if (qty === 42) return 210`, or checks whether a test is running, Jev is asked whether the code hard-codes that test's answer instead of doing the real work. Other changes are not sent.

When Jev is sure, the change is blocked. When it is not sure, it goes through with a note. Real constants and documented values are fine. Tests, fixtures, mocks, and test helpers are not checked. If you asked for a stub or a hard-coded value, it is allowed.

## What the agent says it did

When the agent finishes and the session goes idle, the plugin reads its last message and asks Jev whether the claims in it are backed by what happened since your last message. For example, "all tests pass" when the last test run failed, ran only one file, or came before the last edit, "fixed" when nothing was changed, or "lint is clean" when lint never ran. Jev sees the commands the agent ran, with their exit codes and output, and the files it changed, in order.

The turn is already over, so nothing is blocked. When Jev is sure, the plugin sends the agent one follow-up to fix it or correct its message, and shows you a toast. From 0.5 up to sure, you only get the toast. Below that, it says nothing. It checks once per message from you, never checks its own follow-up, and skips subagents. If you told the agent not to run the checks, there is no follow-up.

## What the agent sees

A block message lists each test: the file, the test, the rule it broke in one plain line, the lines that show it, and what to do next. Only lines that are really in the test are shown. At most five tests are listed. It never tells the agent to delete a test or to leave it out.

It also tells the agent it can ask you. If you allow the change in a later message, the next try goes through. Only your messages after the block count, and a subagent's block is answered in the session you talk to.

After three blocks in a row on the same test, file, or command, the message tells the agent to stop retrying and ask you. One that passes starts the count over.

When Jev leans toward a problem but is not sure, the test is written and the same list is added to what the tool returns, as a note. When TypeSafe is slow, a note may arrive with the next tool result instead, marked as a note on an earlier change.

## Your instructions

The plugin reads the same instruction files OpenCode gives the agent:

- The global `AGENTS.md` (`$XDG_CONFIG_HOME/opencode`, or `~/.config/opencode`), or `~/.claude/CLAUDE.md` if that one is missing.
- The project `AGENTS.md`. If there is none, `CLAUDE.md`, then `CONTEXT.md`.
- The files in the `instructions` list of your OpenCode config. Web links are skipped.
- The `AGENTS.md`, `CLAUDE.md`, or `CONTEXT.md` in each folder above the changed file, inside the project.

It also uses your last three messages in that session. A subagent's edit is checked against your messages to the agent that started it. The subagent's prompt does not count. A later message from you can take a rule back.

`.cursor/rules` and `.github/copilot-instructions.md` are read only if you add them to `instructions`, the same as OpenCode.

Rules that are only about formatting are left out. Changes to `node_modules` and to `jevy-vet.jsonc` are not checked.

## Code you already have

When an agent adds a new function to a source file, the plugin looks for the closest existing functions in your project. It skips tests, `node_modules`, vendored, built, and generated code, and what your `.gitignore` lists. It then asks Jev whether the new function does the same job as one of them.

If Jev is sure, a note tells the agent which function to reuse and where it is. It never blocks. A move, or a rename that keeps half the old body, is not flagged. If you asked for a separate copy, there is no note.

## Errors that are hidden

When an agent changes a source file and adds a `catch`, an error default such as `??` or `|| []`, or an ignored error, or removes a `throw` or an error return, the plugin asks Jev whether the change hides a failure instead of handling it. Jev also sees the last command that failed. Errors that are rethrown, wrapped, really recovered from, or part of code a comment calls best effort are fine.

If Jev is sure, a note tells the agent to let the error fail loudly or handle it for real. It never blocks. Tests, fixtures, mocks, test helpers, and generated code are skipped. If you asked to ignore the error, there is no note.

## Comments and docs that go stale

When an agent changes code in a source file, the plugin sends Jev the comments on the changed function, and the sections of your markdown docs that name it. Jev decides if one of them is now wrong about the code. A comment the agent writes is checked too: does the code do what it says.

If Jev is sure, a note tells the agent to update the comment or doc, or to ask you if the code is what is wrong. It never blocks. `AGENTS.md`, `CLAUDE.md`, `CONTEXT.md`, and changelogs are left out. Tests, test helpers, and generated code are skipped. If you asked to change only the code, there is no note.

## If Jev cannot decide

The write goes through unless Jev is sure. Sure means a score of 0.8 or higher, and confidence of 0.8 or higher when confidence is present. It also goes through when TypeSafe is down, times out, or sends a bad response.

For the test checks, changes to checks, and faked answers, a score from 0.5 up to sure adds a note instead. The instruction, reuse, hidden-error, and stale-comment checks add a note only when Jev is sure. The claim check asks the agent only when Jev is sure. From 0.5 it only shows you a toast.

A test write is blocked when the config file is missing, cannot be read, or has no `TYPESAFE_API_KEY`. Other writes and commands are not. With no key, an unreadable config, or a TypeSafe failure, those other checks add nothing.

## What this does not do

It does not run the test. It does not prove the test would catch a real bug. You still need to run the tests for that.

It can be wrong about your instructions, either way. It does not undo the edit.

## Tests

```bash
bun test
bun run smoke
```

The tests do not need an API key. `bun run smoke` runs the plugin inside OpenCode, against fake servers only. It skips if `opencode` is not installed. GitHub Actions installs OpenCode 1.x and runs it.

`bun run eval` calls the real checks on the cases in `eval/cases` and does not need a key.
`bun run eval -- --live` sends one capped run to TypeSafe. It reads the key only through `loadSettings`.
