# AGENTS.md

OpenCode plugin that vets agent writes with TypeSafe Jev. Test checks and the check-weakening check block. The instruction check and the reuse check only warn. It calls the API itself. It does not use the Jev MCP server.

## Commands

- `bun test`
- `bun run lint`

## Layout

- `src/index.ts` — plugin entry. The only export must be the default function. It also keeps the user's latest messages per session from `chat.message`, skips subagent sessions, keeps blocks per top-level session, starts the instruction and reuse checks in `tool.execute.before`, and adds the notes in `tool.execute.after`, matched by `callID`. `tool.execute.after` also keeps the last failed `bash` command per top-level session, from `metadata.exit`.
- `src/index.test.ts` — plugin hook tests.
- `src/settings.ts` — read `jevy-vet.jsonc` when a write is about to happen. Do not read it at import time.
- `src/settings.test.ts` — config read tests.
- `src/subjects.ts` — the new test text from `write`, `edit`, and `apply_patch`, split into setup and one case per test. Also the old and new text of each changed test, for the edit check, and of each changed file of any kind, for the instruction check. Which files set a check, the `bash` command, and which commands are in scope for the check-weakening check. The function-like definitions in a source file, for the reuse check.
- `src/subjects.test.ts` — splitting, title, check file, command scope, and definition tests.
- `src/context.ts` — the setup and the code under test read from the project folder, the instruction files OpenCode loads, split into sentences, and the project's source files for the reuse check. Context only.
- `src/context.test.ts` — code-under-test lookup, instruction file, sentence, and source file tests.
- `src/review.ts` — what to judge, the TypeSafe call, the block or note decision, the user's allow, the check-weakening check, the instruction check, and the reuse check.
- `src/review.test.ts` — block decision, check-weakening, instruction check, and reuse check tests.

## Rules

- Tests use a fake `fetch`. They must not call the live API.
- Do not add another export to `src/index.ts`. OpenCode treats every export as a plugin.
- Do not add an MCP client, and do not shell out to `jev-mcp`.
- Read `TYPESAFE_API_KEY` from `jevy-vet.jsonc` in the OpenCode config folder, next to `opencode.json` or `opencode.jsonc`, when a write is about to happen. Do not read it from the environment, and do not read it at import time.
- A missing key, or a config file that cannot be read, blocks that test write. A TypeSafe error, timeout, or bad response allows the write.
- The instruction check covers every file `write`, `edit`, and `apply_patch` change, not only tests. It never blocks. It warns only when Jev is sure, at the same 0.8 as a block. It appends a note to the tool output in `tool.execute.after`. With no key, an unreadable config, or a TypeSafe failure, it adds nothing.
- The note names the file and quotes the instruction. It says the change was made, and tells the agent to undo it or ask the user.
- Never check changes inside `node_modules` or to `jevy-vet.jsonc`. A plugin note never becomes an instruction.
- Block only when a hard rule scores 0.8 or higher. If confidence is present and below 0.8, allow the write. For a choice, that is the probability of the chosen option.
- For the test checks, a score from 0.5 up to a block, or a block score with confidence below 0.8, writes the file and adds a note in `tool.execute.after`. Below 0.5 says nothing. A block in the same write wins, and its notes are dropped.
- The instruction check notes only at a block score. Its rules are already a guess, so from 0.5 up to that it says nothing.
- Judge the new text, not the old file. For `edit`, that is `newString`. For a patch update, that is the added lines.
- Old text may be used only as contrast evidence for the edit check and the instruction check: `oldString`, the removed lines of a patch, a deleted test file, or the file on disk before a `write`. Never send it with the new-test questions. The reuse check uses it only to tell new functions from changed or moved ones, and never sends it.
- Strip code comments from old and new text before the edit check and the instruction check. Jev judges the code, not the explanation. For the instruction check, only strip files whose comment syntax is known. Prose like "don't" is not a quote.
- The edit check may be allowed by the user's own message. Only real user text from `chat.message` counts. Synthetic parts, ignored parts, and subagent prompts do not. With no user message, nothing is allowed by intent.
- Instructions come from the user's real messages and from the instruction files OpenCode itself loads (`packages/opencode/src/session/instruction.ts`): the global `AGENTS.md` or `~/.claude/CLAUDE.md`, the project `AGENTS.md`, `CLAUDE.md`, or `CONTEXT.md`, the config `instructions` list without URLs, and the nearest file in each folder above the changed file. Honor the same `OPENCODE_DISABLE_*` variables. Do not add files OpenCode does not load. A subagent's edit uses the parent session's user messages.
- Instruction files are the one thing read outside the project folder, and only at those paths. Cut each to 8,000 characters and all to 24,000.
- Split instructions into sentences in code. Ask Jev once per sentence whether it is a rule, and cache the answer in memory. Do not cache a missing answer.
- A later user message can lift an instruction. Order instructions oldest first, files before messages, and keep the newest when capping.
- A block or note names, per test: the file, the test, the rule with one plain line, the evidence, and the next step. Evidence is copied from the text, never made up: assertion or mock lines for a new test, the old and new lines for an edit or a check file, and the command for `bash`. List at most five.
- A block message never suggests deleting a test or not adding it. It tells the agent it can ask the user to allow the change. An edit's next step is to fix the code, or to stop and ask the user if the old test is wrong.
- The user can allow a block. Only real user messages in the top-level session, written after that block, count. One question per blocked test, and a score of 0.5 or higher allows it. If that request fails, the block stands, like any other missing answer.
- The user-intent question and the allow question are not the same. User intent asks if the user asked for this edit, from recent messages, before any block. It covers test edits, check files, commands, and new functions, built by one helper. Allow asks if the user allowed a block, from messages after it, for every kind of block. Both allow at 0.5 and log it. Do not add a third.
- Count blocks per top-level session, file, and test, per check file, and per command with its spaces collapsed. A pass or an allow starts over. At three in a row, the next step tells the agent to stop retrying and ask the user. Keep at most 100 blocks per session and 100 sessions, in memory only.
- The setup and the code under test are context, not judged. Read them only from inside the project folder, never from `node_modules` or other test files. Tests use a fake disk.
- Each question asks one thing, and yes means a problem. A question that needs the code under test is skipped when none was found. The exceptions are the user-intent, allow, and lifted-instruction questions, where a score of 0.5 or higher allows the edit or drops the note, and the two sentence questions, where 0.5 or higher on "limits" and below 0.5 on "style" makes a rule.
- Use `jev-latest`. Do not pin a model version.
- The check-weakening check covers files that set what CI, tests, lint, type checks, or git hooks enforce (`isGatePath` in `src/subjects.ts`), from `write`, `edit`, and `apply_patch`, and `bash` commands. It asks one question per file or command: does it weaken or bypass a check. Like the test checks, it blocks when sure and notes from 0.5. Its next step is to keep the check and fix the code, or to stop and ask the user.
- A missing key or an unreadable config skips the check-weakening check quietly. It never blocks a check file or a command. A TypeSafe failure allows it.
- Strip comments from a check file only when its comment syntax is known. For others, send the text as it is. A long file sends only the changed lines and five lines around them.
- `bash` is asked about only when the command names `git`, `pkg`, `set-script`, `HUSKY`, a test file or test folder, or a check file (`touchesGates` in `src/subjects.ts`). That is scope, like the test paths. Never block, note, or allow on a text match. Jev decides. Do not add pattern checks such as TODO text, `.only`, or `console.log`.
- The last failed `bash` command is context only, never judged. It comes from `tool.execute.after`, where OpenCode puts the exit code in `metadata.exit`. A later pass of the same command forgets it. Keep one per top-level session, in memory only.
- The reuse check runs only when `write`, `edit`, or `apply_patch` adds a new function-like definition (`definitionsIn` in `src/subjects.ts`) in a source file that is not a test. A name already in the old text or on disk is a change, not new. A name the same call removes, or a body sharing half its words with one it removes, is a move and is skipped. It never blocks. It notes only when Jev is sure, at 0.8, in `tool.execute.after`. With no key, an unreadable config, or a TypeSafe failure, it adds nothing.
- Retrieval (`sourceFiles` in `src/context.ts`) only picks what Jev sees. It never notes, blocks, or allows. It skips dot folders, installed, vendored, built, and generated code, tests, the root `.gitignore` (no `!` patterns), and the changed files, read as they were before the tool ran. One question per pair: does the new one do the same job. Up to five new functions, three closest by shared words. Below that minimum, Jev is not called. The note names the new file and function, the rule, the existing path, line, and first line, the new first line, and the next step: reuse that function, or keep the new one or ask the user if it must differ.
- The first checks are tests, then instructions, then checks that CI and tests enforce, then reuse. Add later checks in `src/review.ts`. Do not rename the package for a new check.
- The published npm name is `jevy-vet`. Do not rename it. Install steps are in `README.md`.
- OpenCode 1 only. Do not claim OpenCode 2 support. V2 needs `Plugin.define` and `setup()`, and a V1 function does not run there.
- Do not edit the user's OpenCode config from this repo.
