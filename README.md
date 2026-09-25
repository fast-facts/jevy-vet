# jevy-vet

An OpenCode plugin that stops a weak test before the file is written, and tells the agent when an edit may break your instructions.

When an agent adds or changes a test, the plugin asks TypeSafe Jev if a new test is useless, or if a changed test no longer checks the same thing. If Jev is sure, the write is blocked. You do not set up Jev yourself. The plugin calls TypeSafe.

For every file an agent changes, it also asks Jev if the change breaks one of your instructions. That only adds a note for the agent. It never blocks.

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

It watches `write`, `edit`, and `apply_patch`. The test checks only look at paths that look like tests, such as `*.test.ts`, `*.spec.tsx`, `*_test.go`, `test_*.py`, `*Test.java`, and files under `__tests__/`.

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

### When you asked for the change

Your own words allow the edit. The plugin keeps your last three messages for that session, in memory only, and sends them with the edit so Jev can tell.

Asking to fix a failure, or to make the tests pass, does not count. A prompt written by another agent does not count. With no message from you, nothing is treated as asked for.

## What the agent sees

A block message lists each test: the file, the test, the rule it broke in one plain line, the lines that show it, and what to do next. Only lines that are really in the test are shown. At most five tests are listed. It never tells the agent to delete a test or to leave it out.

It also tells the agent it can ask you. If you allow the change in a later message, the next try goes through. Only your messages after the block count, and a subagent's block is answered in the session you talk to.

After three blocks in a row on the same test, the message tells the agent to stop retrying and ask you. A test that passes starts the count over.

When Jev leans toward a problem but is not sure, the test is written and the same list is added to what the tool returns, as a note.

## Your instructions

The plugin reads the same instruction files OpenCode gives the agent:

- The global `AGENTS.md` (`$XDG_CONFIG_HOME/opencode`, or `~/.config/opencode`), or `~/.claude/CLAUDE.md` if that one is missing.
- The project `AGENTS.md`. If there is none, `CLAUDE.md`, then `CONTEXT.md`.
- The files in the `instructions` list of your OpenCode config. Web links are skipped.
- The `AGENTS.md`, `CLAUDE.md`, or `CONTEXT.md` in each folder above the changed file, inside the project.

It also uses your last three messages in that session. A subagent's edit is checked against your messages to the agent that started it. The subagent's prompt does not count. A later message from you can take a rule back.

`.cursor/rules` and `.github/copilot-instructions.md` are read only if you add them to `instructions`, the same as OpenCode.

Rules that are only about formatting are left out. With no key, or when TypeSafe fails, there is no note. Changes to `node_modules` and to `jevy-vet.jsonc` are not checked.

## If Jev cannot decide

The write goes through unless Jev is sure. Sure means a score of 0.8 or higher, and confidence of 0.8 or higher when confidence is present. It also goes through when TypeSafe is down, times out, or sends a bad response.

For the test checks, a score from 0.5 up to sure adds a note instead. The instruction check adds a note only when Jev is sure.

A test write is blocked when the config file is missing, cannot be read, or has no `TYPESAFE_API_KEY`. Other writes are not.

## What this does not do

It does not run the test. It does not prove the test would catch a real bug. You still need to run the tests for that.

It can be wrong about your instructions, either way. It does not undo the edit.

## Tests

```bash
bun test
```

The tests do not need an API key.
