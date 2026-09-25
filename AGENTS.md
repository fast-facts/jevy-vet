# AGENTS.md

OpenCode plugin that vets agent writes with TypeSafe Jev. It calls the API itself. It does not use the Jev MCP server.

Test checks, the check-weakening check, and the special-case check block. The instruction, reuse, hidden-error, and stale-comment checks only warn. The claim check runs after the turn and never blocks.

## Commands

- `bun test`
- `bun run lint`

## Rules

- Tests use a fake `fetch`. They must not call the live API.
- Eval cases are production inputs. The runner calls the real checks. It must not copy question text. Live eval is manual, capped, and not part of `bun test` or CI. It reads the key only through `loadSettings`.
- Read `TYPESAFE_API_KEY` from `jevy-vet.jsonc` in the OpenCode config folder, next to `opencode.json` or `opencode.jsonc`, when a write is about to happen. Do not read it from the environment, and do not read it at import time.
- A missing key, or a config file that cannot be read, blocks that test write. It skips every other check. A TypeSafe error, timeout, or bad response allows the write.
- Never check changes inside `node_modules` or to `jevy-vet.jsonc`. A plugin note never becomes an instruction.
- Block only when a hard rule scores 0.8 or higher and confidence is also 0.8 or higher. From 0.5 up to that, or when confidence is lower, write the file and add a note. Below 0.5 says nothing. A block in the same write wins, and its notes are dropped.
- A note-only check never blocks. It notes only at 0.8, in `tool.execute.after`. Below that it says nothing. With no key, an unreadable config, or a TypeSafe failure, it adds nothing.
- Judge the new text, not the old file. For `edit`, that is `newString`. For a patch update, that is the added lines. Old text is contrast only. Never send it with the new-test questions.
- Strip code comments before the edit check, the special-case check, and the instruction check. For the instruction check, strip only when the comment syntax is known. Keep comments for the hidden-error check and the stale-comment check.
- Only real user text from `chat.message` counts. Synthetic parts, ignored parts, and subagent prompts do not. A subagent's edit uses the parent session's user messages.
- User intent and allow are not the same. Both allow at 0.5, or drop the note. Do not add a third. User intent is one shared helper, asked before any block. Allow is asked after a block, from later real messages in the top-level session.
- Instructions come only from the files OpenCode loads (`packages/opencode/src/session/instruction.ts`) and the user's real messages. Honor the same `OPENCODE_DISABLE_*` variables. Do not add files OpenCode does not load.
- Cut each instruction file to 8,000 characters and all of them to 24,000. Split sentences in code. Ask once whether a sentence is a rule, and cache that answer. Do not cache a missing answer. A later user message can lift a rule. Keep the newest rules when capping.
- A block or note names the file, the test, one plain rule line, evidence copied from the text, and the next step. List at most five. Never suggest deleting a test or leaving it out.
- Count blocks per top-level session and target. A pass or an allow starts over. At three in a row, tell the agent to stop retrying and ask the user. Keep at most 100 blocks per session and 100 sessions, in memory only.
- The setup and the code under test are context, not judged. Each question asks one thing, and yes means a problem. Skip a question that needs the code under test when none was found.
- Scope is not a finding. Do not block, note, or allow on a text match. Jev decides. Do not add pattern checks such as TODO text, `.only`, or `console.log`.
- The last failed `bash` command is context only. Retrieval only picks what Jev sees. It never notes, blocks, or allows.
- The claim check uses `session.status` idle, from the `event` hook. Ignore `session.idle`. It cannot block. Check once per user message, never a subagent session, and drop a finding when a newer user message came in.
- The stale-comment check skips `AGENTS.md`, `CLAUDE.md`, `CONTEXT.md`, changelogs, and docs the same call changes.
- Checks run in this order: tests, instructions, gate checks, reuse, special cases, claims, hidden errors, then stale comments. A note-only check is its own file, started from `src/index.ts`. A check that blocks stays in `src/review.ts`.
- Do not add another export to `src/index.ts`. OpenCode treats every export as a plugin.
- Do not add an MCP client, and do not shell out to `jev-mcp`.
- Use `jev-latest`. Do not pin a model version.
- The published npm name is `jevy-vet`. Do not rename it. Install steps are in `README.md`.
- OpenCode 1 only. Do not claim OpenCode 2 support. V2 needs `Plugin.define` and `setup()`, and a V1 function does not run there.
- Do not edit the user's OpenCode config from this repo.
