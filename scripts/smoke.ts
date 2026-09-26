import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { isRecord } from '../src/jev.ts';

const REPO = join(import.meta.dir, '..');
const RUN_MS = 180_000;
const SERVE_MS = 60_000;
const IDLE_MS = 30_000;

interface Turn {
  tool?: string;
  args?: Record<string, unknown>;
  text?: string;
}

interface JudgeHit {
  questions: Record<string, unknown>;
  state: Record<string, unknown>;
}

interface Run {
  code: number;
  stdout: string;
  stderr: string;
}

interface Scenario {
  name: string;
  ok: boolean;
  detail: string;
}

const SURE_NOUL = ['_mocks_code_under_test', '_passes_on_empty', '_hides_error', '_stale'];

const ADD_SOURCE = `export function add(a: number, b: number) {
  return a + b;
}
`;

const WEAK_TEST = `import { add } from './add';
test('adds one and two', () => {
  expect(add(1, 2)).toBeDefined();
});
`;

const LOAD_SOURCE = `export function load() {
  return read();
}
`;

const HIDDEN_LINE = 'try { return read(); } catch (error) { return null; }';

const SAVE_PATCH = `*** Begin Patch
*** Add File: src/save.ts
+export function save() {
+  try {
+    return write();
+  } catch (error) {
+    return null;
+  }
+}
*** End Patch
`;

const opencodeBin = process.env.OPENCODE_BIN || Bun.which('opencode') || '';
if (opencodeBin === '') {
  process.stdout.write('opencode was not found. Smoke test skipped.\n');
  process.exit(0);
}

const turns: Turn[] = [];
const modelHits: string[] = [];
const judgeHits: JudgeHit[] = [];
const oddPaths: string[] = [];

const model = Bun.serve({
  port: 0,
  hostname: '127.0.0.1',
  fetch(request) {
    const url = new URL(request.url);
    if (request.method === 'POST' && url.pathname.endsWith('/chat/completions')) return chat(request);
    oddPaths.push(`${request.method} ${url.pathname}`);
    return new Response('not found', { status: 404 });
  },
});

const judge = Bun.serve({
  port: 0,
  hostname: '127.0.0.1',
  fetch(request) {
    const url = new URL(request.url);
    if (request.method === 'POST' && url.pathname === '/v1/systemone') return systemone(request);
    oddPaths.push(`${request.method} ${url.pathname}`);
    return new Response('not found', { status: 404 });
  },
});

const root = mkdtempSync(join(tmpdir(), 'jevy-smoke-'));
const home = join(root, 'home');
mkdirSync(join(home, '.config', 'opencode'), { recursive: true });
writeFileSync(join(home, '.config', 'opencode', 'jevy-vet.jsonc'), `{
  // Dummy key read from this file, never the environment.
  "TYPESAFE_API_KEY": "smoke-key",
  "TYPESAFE_BASE_URL": "http://127.0.0.1:${judge.port}"
}
`);

const env = isolated(home, configJson(`http://127.0.0.1:${model.port}/v1`));
const results: Scenario[] = [];
let lastMessages = '';

try {
  results.push(await blockedWrite());
  results.push(await sourceNote('note on source edit', 'test-model', 'edit', editArgs));
  results.push(await sourceNote('note on apply_patch', 'gpt-5-smoke', 'apply_patch', () => ({ patchText: SAVE_PATCH })));
  results.push(await gitBash());
  results.push(await failedBash());
  results.push(await idleClaim());
} catch (error) {
  results.push({ name: 'smoke', ok: false, detail: error instanceof Error ? error.message : String(error) });
} finally {
  await model.stop(true);
  await judge.stop(true);
  rmSync(root, { recursive: true, force: true });
}

let failed = 0;
for (const result of results) {
  if (result.ok) {
    process.stdout.write(`pass  ${result.name}\n`);
    continue;
  }
  failed += 1;
  process.stdout.write(`fail  ${result.name}: ${result.detail}\n`);
}
process.exit(failed === 0 ? 0 : 1);

async function blockedWrite(): Promise<Scenario> {
  const name = 'blocked test write';
  const project = projectDir('blocked');
  mkdirSync(join(project, 'src'), { recursive: true });
  writeFileSync(join(project, 'src', 'add.ts'), ADD_SOURCE);
  const file = join(project, 'src', 'add.test.ts');
  reset([{ tool: 'write', args: { filePath: file, content: WEAK_TEST } }, { text: 'done' }]);
  const run = await opencode(['run', '--format', 'json', '--auto', '--model', 'test/test-model', 'Write the test.'], project);
  const seen = modelHits.some(hit => hit.includes('Jevy blocked this test write'));
  const left = existsSync(file);
  if (seen && !left) return { name, ok: true, detail: '' };
  return { name, ok: false, detail: explain(run, seen ? 'the file was written' : 'the model did not see the block') };
}

async function sourceNote(name: string, modelId: string, tool: string, args: (project: string) => Record<string, unknown>): Promise<Scenario> {
  const project = projectDir(name);
  mkdirSync(join(project, 'src'), { recursive: true });
  writeFileSync(join(project, 'src', 'load.ts'), LOAD_SOURCE);
  reset([{ tool, args: args(project) }, { text: 'done' }]);
  const run = await opencode(['run', '--format', 'json', '--auto', '--model', `test/${modelId}`, 'Edit the source.'], project);
  const seen = modelHits.some(hit => hit.includes('Jevy note:'));
  if (seen) return { name, ok: true, detail: '' };
  return { name, ok: false, detail: explain(run, 'the model did not see a Jevy note') };
}

function editArgs(project: string): Record<string, unknown> {
  return { filePath: join(project, 'src', 'load.ts'), oldString: 'return read();', newString: HIDDEN_LINE };
}

async function gitBash(): Promise<Scenario> {
  const name = 'bash weakens gate';
  const project = projectDir('git');
  reset([{ tool: 'bash', args: { command: 'git status --short' } }, { text: 'done' }]);
  const run = await opencode(['run', '--format', 'json', '--auto', '--model', 'test/test-model', 'Check git.'], project);
  const seen = judgeHits.some(hit => Object.keys(hit.questions).some(id => id.endsWith('_weakens_gate')));
  if (seen) return { name, ok: true, detail: '' };
  return { name, ok: false, detail: explain(run, 'TypeSafe saw no _weakens_gate question') };
}

async function failedBash(): Promise<Scenario> {
  const name = 'bash failure then edit';
  const project = projectDir('failed');
  mkdirSync(join(project, 'src'), { recursive: true });
  writeFileSync(join(project, 'src', 'load.ts'), LOAD_SOURCE);
  reset([
    { tool: 'bash', args: { command: 'exit 1' } },
    { tool: 'edit', args: editArgs(project) },
    { text: 'done' },
  ]);
  const run = await opencode(['run', '--format', 'json', '--auto', '--model', 'test/test-model', 'Run the command, then edit.'], project);
  const hit = judgeHits.find(item => Object.keys(item.questions).some(id => id.endsWith('_hides_error')));
  const failure = hit?.state.last_failure;
  const command = isRecord(failure) && failure.command === 'exit 1';
  if (command) return { name, ok: true, detail: '' };
  return { name, ok: false, detail: explain(run, 'hidden-error request had no last_failure for exit 1') };
}

async function idleClaim(): Promise<Scenario> {
  const name = 'idle claim';
  const project = projectDir('idle');
  reset([{ text: 'All tests pass.' }]);
  const child = Bun.spawn([opencodeBin, 'serve', '--port', '0', '--hostname', '127.0.0.1'], {
    cwd: project,
    env,
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
  });
  let stderr = '';
  const errTask = new Response(child.stderr).text().then(text => {
    stderr = text;
  });
  try {
    const url = await listening(child.stdout);
    const session = await postJson(`${url}/session?directory=${encodeURIComponent(project)}`, {});
    const id = isRecord(session) && typeof session.id === 'string' ? session.id : '';
    if (id === '') return { name, ok: false, detail: `no session id\n${stderr.slice(-800)}` };
    const sent = await fetch(`${url}/session/${id}/prompt_async?directory=${encodeURIComponent(project)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: { providerID: 'test', modelID: 'test-model' },
        parts: [{ type: 'text', text: 'Reply when ready.' }],
      }),
    });
    if (!sent.ok) return { name, ok: false, detail: `prompt_async ${String(sent.status)}\n${stderr.slice(-800)}` };
    const ready = await waitFor(IDLE_MS, () => judgeHits.some(hit => Object.keys(hit.questions).some(qid => qid.endsWith('_support'))));
    if (!ready) return { name, ok: false, detail: explain({ code: 0, stdout: '', stderr }, 'TypeSafe saw no claims request') };
    const follow = await waitFor(IDLE_MS, async () => syntheticFollowUp(url, id, project));
    if (follow) return { name, ok: true, detail: '' };
    return { name, ok: false, detail: explain({ code: 0, stdout: '', stderr }, `no synthetic prompt_async follow-up; messages ${lastMessages.slice(0, 500)}`) };
  } catch (error) {
    return { name, ok: false, detail: error instanceof Error ? error.message : String(error) };
  } finally {
    child.kill();
    await child.exited;
    await errTask;
  }
}

async function syntheticFollowUp(url: string, id: string, project: string): Promise<boolean> {
  const response = await fetch(`${url}/session/${id}/message?directory=${encodeURIComponent(project)}&limit=20`);
  if (!response.ok) return false;
  const messages: unknown = await response.json();
  lastMessages = JSON.stringify(messages);
  if (!Array.isArray(messages)) return false;
  for (const message of messages) {
    if (!isRecord(message) || !Array.isArray(message.parts)) continue;
    for (const part of message.parts) {
      if (!isRecord(part) || part.synthetic !== true || typeof part.text !== 'string') continue;
      if (part.text.includes('Jevy check:')) return true;
    }
  }
  return false;
}

async function chat(request: Request): Promise<Response> {
  const body: unknown = await request.json();
  const text = JSON.stringify(body);
  if (text.includes('Generate a title')) return new Response(sse({ text: 'Smoke title' }), { headers: sseHeaders() });
  modelHits.push(text);
  const turn = turns.shift() ?? { text: 'ok' };
  return new Response(sse(turn), { headers: sseHeaders() });
}

async function systemone(request: Request): Promise<Response> {
  const body: unknown = await request.json();
  const parsed = isRecord(body) ? body : {};
  const questions = isRecord(parsed.questions) ? parsed.questions : {};
  const state = isRecord(parsed.state) ? parsed.state : {};
  const answers: Record<string, unknown> = {};
  for (const [id, question] of Object.entries(questions)) answers[id] = answerFor(id, question);
  judgeHits.push({ questions, state });
  return Response.json({
    model: 'jev-1.13.0',
    answers,
    usage: { input_tokens: 20, output_tokens: 8 },
  });
}

function answerFor(id: string, question: unknown): unknown {
  const asked = isRecord(question) ? question : {};
  if (SURE_NOUL.some(suffix => id.endsWith(suffix))) return { type: 'noul', noul: 0.95 };
  if (id.endsWith('_change')) {
    return { type: 'choice', choice: 'weaker', probabilities: { weaker: 0.95 }, confidence: 0.9 };
  }
  if (id.endsWith('_support')) {
    return { type: 'choice', choice: 'no_run', probabilities: { no_run: 0.95 }, confidence: 0.9 };
  }
  if (asked.type === 'choice') {
    const keys = isRecord(asked.criteria) ? Object.keys(asked.criteria) : ['supported'];
    const choice = keys[0] ?? 'supported';
    const probabilities: Record<string, number> = {};
    for (const key of keys) probabilities[key] = key === choice ? 0.1 : 0;
    return { type: 'choice', choice, probabilities, confidence: 0.9 };
  }
  return { type: 'noul', noul: 0 };
}

function sse(turn: Turn): string {
  const lines = [chunk({ role: 'assistant' })];
  if (turn.tool) {
    lines.push(chunk({
      tool_calls: [{ index: 0, id: 'call_smoke', type: 'function', function: { name: turn.tool, arguments: '' } }],
    }));
    lines.push(chunk({
      tool_calls: [{ index: 0, function: { arguments: JSON.stringify(turn.args ?? {}) } }],
    }));
    lines.push(chunk({}, 'tool_calls'));
  } else {
    lines.push(chunk({ content: turn.text ?? 'ok' }));
    lines.push(chunk({}, 'stop'));
  }
  return `${lines.map(line => `data: ${JSON.stringify(line)}\n\n`).join('')}data: [DONE]\n\n`;
}

function chunk(delta: Record<string, unknown>, finish?: string): unknown {
  return {
    id: 'chatcmpl-smoke',
    object: 'chat.completion.chunk',
    created: 0,
    model: 'smoke',
    choices: [{ index: 0, delta, ...(finish ? { finish_reason: finish } : {}) }],
    ...(finish ? { usage: { prompt_tokens: 8, completion_tokens: 4, total_tokens: 12 } } : {}),
  };
}

function sseHeaders(): HeadersInit {
  return { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' };
}

function reset(next: Turn[]): void {
  turns.length = 0;
  modelHits.length = 0;
  judgeHits.length = 0;
  oddPaths.length = 0;
  for (const turn of next) turns.push(turn);
}

function projectDir(name: string): string {
  const dir = join(root, name.replaceAll(' ', '-'));
  mkdirSync(dir, { recursive: true });
  return dir;
}

function configJson(baseURL: string): string {
  const one = {
    id: 'test-model',
    name: 'Test Model',
    attachment: false,
    reasoning: false,
    temperature: false,
    tool_call: true,
    release_date: '2025-01-01',
    limit: { context: 100_000, output: 10_000 },
    cost: { input: 0, output: 0 },
    options: {},
  };
  return JSON.stringify({
    formatter: false,
    lsp: false,
    share: 'disabled',
    permission: 'allow',
    model: 'test/test-model',
    small_model: 'test/test-model',
    plugin: [pathToFileURL(REPO).href],
    provider: {
      test: {
        name: 'Test',
        id: 'test',
        env: [],
        npm: '@ai-sdk/openai-compatible',
        models: {
          'test-model': one,
          'gpt-5-smoke': { ...one, id: 'gpt-5-smoke', name: 'GPT 5 smoke' },
        },
        options: { apiKey: 'test-key', baseURL },
      },
    },
  });
}

function isolated(dir: string, content: string): Record<string, string> {
  return {
    PATH: process.env.PATH ?? '',
    HOME: dir,
    OPENCODE_TEST_HOME: dir,
    XDG_CONFIG_HOME: join(dir, '.config'),
    XDG_DATA_HOME: join(dir, '.local/share'),
    XDG_STATE_HOME: join(dir, '.local/state'),
    XDG_CACHE_HOME: join(dir, '.cache'),
    OPENCODE_CONFIG_CONTENT: content,
    OPENCODE_DISABLE_PROJECT_CONFIG: '1',
    OPENCODE_DISABLE_AUTOUPDATE: '1',
    OPENCODE_DISABLE_AUTOCOMPACT: '1',
    OPENCODE_DISABLE_MODELS_FETCH: '1',
    OPENCODE_AUTH_CONTENT: '{}',
    LANG: 'C.UTF-8',
  };
}

async function opencode(args: string[], project: string): Promise<Run> {
  const child = Bun.spawn([opencodeBin, ...args], {
    cwd: project,
    env,
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const timer = setTimeout(() => child.kill(), RUN_MS);
  const stdout = await new Response(child.stdout).text();
  const stderr = await new Response(child.stderr).text();
  const code = await child.exited;
  clearTimeout(timer);
  return { code, stdout, stderr };
}

async function listening(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let text = '';
  const deadline = Date.now() + SERVE_MS;
  while (Date.now() < deadline) {
    const next = await Promise.race([
      reader.read(),
      Bun.sleep(Math.max(1, deadline - Date.now())).then(() => ({ done: true as const, value: undefined })),
    ]);
    if (next.done) break;
    text += decoder.decode(next.value, { stream: true });
    const match = /listening on (http:\/\/\S+)/.exec(text);
    if (match?.[1]) {
      void drain(reader);
      return match[1];
    }
  }
  throw new Error(`opencode serve did not listen\n${text.slice(-800)}`);
}

async function drain(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<void> {
  while (true) {
    const next = await reader.read();
    if (next.done) return;
  }
}

async function postJson(url: string, body: unknown): Promise<unknown> {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!response.ok) return { status: response.status, text: await response.text() };
  return response.json();
}

async function waitFor(ms: number, ready: () => boolean | Promise<boolean>): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await ready()) return true;
    await Bun.sleep(200);
  }
  return false;
}

function explain(run: Run, why: string): string {
  const ids = judgeHits.flatMap(hit => Object.keys(hit.questions)).slice(0, 12);
  const tail = run.stderr.slice(-800);
  const last = modelHits.at(-1)?.slice(0, 240) ?? '';
  return `${why}; exit ${String(run.code)}; questions ${ids.join(',') || 'none'}; odd ${oddPaths.slice(0, 4).join(',') || 'none'}; stderr ${tail || 'none'}; last model ${last || 'none'}`;
}
