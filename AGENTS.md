# AGENTS.md

OpenCode plugin that vets agent writes with TypeSafe Jev. Test checks block. The instruction check only warns. It calls the API itself. It does not use the Jev MCP server.

## Commands

- `bun test`
- `bun run lint`

## Layout

- `src/index.ts` — plugin entry. The only export must be the default function. It also keeps the user's latest messages per session from `chat.message`, skips subagent sessions, starts the instruction check in `tool.execute.before`, and adds its note in `tool.execute.after`, matched by `callID`.
- `src/index.test.ts` — plugin hook tests.
- `src/settings.ts` — read `jevy-vet.jsonc` when a write is about to happen. Do not read it at import time.
- `src/settings.test.ts` — config read tests.
- `src/subjects.ts` — the new test text from `write`, `edit`, and `apply_patch`, split into setup and one case per test. Also the old and new text of each changed test, for the edit check, and of each changed file of any kind, for the instruction check.
- `src/subjects.test.ts` — splitting and title tests.
- `src/context.ts` — the setup and the code under test read from the project folder, and the instruction files OpenCode loads, split into sentences. Context only.
- `src/context.test.ts` — code-under-test lookup, instruction file, and sentence tests.
- `src/review.ts` — what to judge, the TypeSafe call, the block decision, and the instruction check.
- `src/review.test.ts` — block decision tests.

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
- Judge the new text, not the old file. For `edit`, that is `newString`. For a patch update, that is the added lines.
- Old text may be used only as contrast evidence for the edit check and the instruction check: `oldString`, the removed lines of a patch, a deleted test file, or the file on disk before a `write`. Never send it with the new-test questions.
- Strip code comments from old and new text before the edit check and the instruction check. Jev judges the code, not the explanation. For the instruction check, only strip files whose comment syntax is known. Prose like "don't" is not a quote.
- The edit check may be allowed by the user's own message. Only real user text from `chat.message` counts. Synthetic parts, ignored parts, and subagent prompts do not. With no user message, nothing is allowed by intent.
- Instructions come from the user's real messages and from the instruction files OpenCode itself loads (`packages/opencode/src/session/instruction.ts`): the global `AGENTS.md` or `~/.claude/CLAUDE.md`, the project `AGENTS.md`, `CLAUDE.md`, or `CONTEXT.md`, the config `instructions` list without URLs, and the nearest file in each folder above the changed file. Honor the same `OPENCODE_DISABLE_*` variables. Do not add files OpenCode does not load. A subagent's edit uses the parent session's user messages.
- Instruction files are the one thing read outside the project folder, and only at those paths. Cut each to 8,000 characters and all to 24,000.
- Split instructions into sentences in code. Ask Jev once per sentence whether it is a rule, and cache the answer in memory. Do not cache a missing answer.
- A later user message can lift an instruction. Order instructions oldest first, files before messages, and keep the newest when capping.
- An edit block message names the file, the test, and the old and new check. It tells the agent to fix the code, or to stop and ask the user. It never suggests deleting the test.
- The setup and the code under test are context, not judged. Read them only from inside the project folder, never from `node_modules` or other test files. Tests use a fake disk.
- Each question asks one thing, and yes means a problem. A question that needs the code under test is skipped when none was found. The exceptions are the user-intent question and the lifted-instruction question, where a score of 0.5 or higher allows the edit or drops the note, and the two sentence questions, where 0.5 or higher on "limits" and below 0.5 on "style" makes a rule.
- Use `jev-latest`. Do not pin a model version.
- The first checks are tests, then instructions. Add later checks in `src/review.ts`. Do not rename the package for a new check.
- The published npm name is `jevy-vet`. Do not rename it. Install steps are in `README.md`.
- OpenCode 1 only. Do not claim OpenCode 2 support. V2 needs `Plugin.define` and `setup()`, and a V1 function does not run there.
- Do not edit the user's OpenCode config from this repo.
