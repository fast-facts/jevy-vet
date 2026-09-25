# jevy-vet

An OpenCode plugin that checks a new test before the file is written. It calls TypeSafe Jev itself. You do not add a Jev MCP server.

The first check is tests. The name is not limited to tests. Later checks can live in the same plugin.

## What it blocks

It watches `write`, `edit`, and `apply_patch`. It only looks at paths that look like tests, such as `*.test.ts`, `*.spec.tsx`, `*_test.go`, `test_*.py`, `*Test.java`, and files under `__tests__/`.

A file with more than one test is judged one test at a time. One bad test blocks the write.

It blocks the write when Jev is sure a test fails one of these rules:

- Its title promises a behavior that none of its assertions check.
- It would still pass if the code returned null, an empty value, or zero.
- The expected value is computed with the same logic as the code under test.
- It replaces the code it tests with a mock or stub.
- The code it tests is only a getter, a setter, or a constructor that stores fields.

Along with each test, Jev sees the rest of the test file's setup (imports and helpers) and the code under test. The plugin reads that code from the project folder. It follows relative imports in the test file and looks for the usual source file next to it: `foo.test.ts` → `foo.ts`, `__tests__/foo.ts` → `foo.ts`, `test_foo.py` → `foo.py`, a Go test's own package, and `src/test/…/FooTest.java` → `src/main/…/Foo.java`. It does not read outside the project folder, in `node_modules`, or other test files. A large file is cut to the imported definitions, or to its head and tail. If no code under test is found, the last three rules are not asked.

Only the new test text is judged.

A score below 0.8 is allowed. If Jev is unsure, the write is allowed. If TypeSafe is down, the write is allowed. If the config file is missing, unreadable, or has no `TYPESAFE_API_KEY`, the test write is blocked.

It does not prove the test would catch a real bug. That needs a run, and for a stronger check, mutation testing. This plugin only reads the new test text and the code around it.

## Add it to OpenCode

The published npm package is `jevy-vet`. You do not install it yourself. OpenCode installs it when it starts.

1. Put the TypeSafe key in `~/.config/opencode/jevy-vet.jsonc`, next to `opencode.json` or `opencode.jsonc`. If `$XDG_CONFIG_HOME` is set, use `$XDG_CONFIG_HOME/opencode/jevy-vet.jsonc` instead. `jevy-vet.json` is used only if the `.jsonc` file is missing.

```jsonc
{
  "TYPESAFE_API_KEY": "ts_..."
}
```

Comments and a trailing comma are fine. `TYPESAFE_BASE_URL` is optional. If you leave it out, the plugin uses `https://api.typesafe.ai`.

The plugin does not read the key from the environment. A project file cannot override this one, so the key stays out of the repo.

2. Add `jevy-vet` to the plugin list. Use the project file `opencode.json` or `opencode.jsonc`, or the global file `~/.config/opencode/opencode.jsonc`.

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["jevy-vet"]
}
```

To pin a version, use `"jevy-vet@1.2.3"`. Keep any plugins you already have. Add `jevy-vet` to that same list.

This package supports OpenCode 1 only. OpenCode 2 does not run an OpenCode 1 plugin. A config rename is not enough.

3. Quit OpenCode and start it again. A running session keeps the old config.

## Tests

```bash
bun test
```

The tests do not need an API key.
