# AGENTS.md

OpenCode plugin that vets agent writes with TypeSafe Jev. It calls the API itself. It does not use the Jev MCP server.

## Commands

- `bun test`
- `bun run lint`

## Layout

- `src/index.ts` — plugin entry. The only export must be the default function.
- `src/index.test.ts` — plugin hook tests.
- `src/settings.ts` — read `jevy-vet.jsonc` when a test write is about to happen. Do not read it at import time.
- `src/settings.test.ts` — config read tests.
- `src/subjects.ts` — the new test text from `write`, `edit`, and `apply_patch`, split into setup and one case per test.
- `src/subjects.test.ts` — splitting and title tests.
- `src/context.ts` — the setup and the code under test read from the project folder. Context only.
- `src/context.test.ts` — code-under-test lookup tests.
- `src/review.ts` — what to judge, the TypeSafe call, and the block decision.
- `src/review.test.ts` — block decision tests.

## Rules

- Tests use a fake `fetch`. They must not call the live API.
- Do not add another export to `src/index.ts`. OpenCode treats every export as a plugin.
- Do not add an MCP client, and do not shell out to `jev-mcp`.
- Read `TYPESAFE_API_KEY` from `jevy-vet.jsonc` in the OpenCode config folder, next to `opencode.json` or `opencode.jsonc`, when a test write is about to happen. Do not read it from the environment, and do not read it at import time.
- A missing key, or a config file that cannot be read, blocks that test write. A TypeSafe error, timeout, or bad response allows the write.
- Block only when a hard rule scores 0.8 or higher. If confidence is present and below 0.8, allow the write.
- Judge the new text, not the old file. For `edit`, that is `newString`. For a patch update, that is the added lines.
- The setup and the code under test are context, not judged. Read them only from inside the project folder, never from `node_modules` or other test files. Tests use a fake disk.
- Each question asks one thing, and yes means a problem. A question that needs the code under test is skipped when none was found.
- Use `jev-latest`. Do not pin a model version.
- The first check is tests. Add later checks in `src/review.ts`. Do not rename the package for a new check.
- The published npm name is `jevy-vet`. Do not rename it. Install steps are in `README.md`.
- OpenCode 1 only. Do not claim OpenCode 2 support. V2 needs `Plugin.define` and `setup()`, and a V1 function does not run there.
- Do not edit the user's OpenCode config from this repo.
