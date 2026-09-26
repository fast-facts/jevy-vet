import { homedir } from 'node:os';
import { checkClaims, type Step } from './claims.ts';
import { globFiles, headTail, instructionFilesFor, listDir, readSource } from './context.ts';
import { checkHiddenErrors } from './hidden.ts';
import { checkInstructions } from './instructions.ts';
import { type Block, type Failure, shownPath } from './jev.ts';
import { productionAsyncDisk, ProjectIndex } from './project.ts';
import { review } from './review.ts';
import { checkReuse } from './reuse.ts';
import { loadSettings } from './settings.ts';
import { checkStaleDocs } from './stale.ts';
import { changesFrom, commandFrom } from './subjects.ts';

interface Input {
  // The project folder. OpenCode passes it. The code under test is only read from inside it.
  directory?: string;
  // Where OpenCode stops looking for project instruction files.
  worktree?: string;
  client: {
    app: {
      log(input: {
        body: {
          service: string;
          level: 'debug' | 'info' | 'warn' | 'error';
          message: string;
        };
      }): Promise<unknown>;
    };
    // Optional. A host without these skips the claim check.
    session?: {
      messages(options: { path: { id: string }; query: { limit: number } }): Promise<{ data?: SessionMessage[] }>;
      promptAsync(options: { path: { id: string }; body: { agent: string; model?: { providerID: string; modelID: string }; parts: { type: 'text'; text: string; synthetic: boolean }[] } }): Promise<unknown>;
    };
    tui?: {
      showToast(options: { body: { title: string; message: string; variant: 'info' | 'warning' } }): Promise<unknown>;
    };
  };
}

// The parts of a session message from the SDK's session.messages that the claim check reads.
interface SessionMessage {
  info: { role: string; agent?: string; model?: { providerID: string; modelID: string }; error?: unknown };
  parts: { type: string; text?: string; synthetic?: boolean; ignored?: boolean }[];
}

// The parts of OpenCode's chat.message output this plugin reads.
interface ChatMessage {
  parts: { type: string; text?: string; synthetic?: boolean; ignored?: boolean }[];
}

interface PluginEvent {
  type: string;
  properties?: { info?: { id?: string; parentID?: string }; sessionID?: string; status?: { type?: string } };
}

const KEEP_MESSAGES = 3;
const MAX_MESSAGE_CHARS = 4000;
const MAX_FAILURE_CHARS = 4000;
const KEEP_SESSIONS = 100;
// Checks started before a tool runs and not yet collected after it. A failed tool never collects.
const KEEP_PENDING = 50;
const KEEP_STEPS = 30;
const MAX_STEP_OUTPUT_CHARS = 1000;
// Enough to find the last user message behind a long run of tool steps.
const READ_MESSAGES = 50;

// Blocks useless test writes, weakened checks, and special-cased tests. Notes unsure ones, broken instructions, repeated code, hidden errors, and stale comments.
// When the session goes idle, it checks the agent's last message against what it did. It calls TypeSafe directly.
// Reads TYPESAFE_API_KEY from jevy-vet.jsonc next to opencode.json(c).
// TYPESAFE_BASE_URL in that file is optional.
export default async function jevyVet(input: Input) {
  const root = input.directory ?? process.cwd();
  const worktree = input.worktree ?? root;
  // The user's latest messages per session, so a test change the user asked for is allowed.
  const messages = new Map<string, string[]>();
  // How many real messages each session has had, so a block knows which messages came after it.
  const counts = new Map<string, number>();
  // Earlier blocks per top-level session, so the user can allow one and retry loops are noticed.
  const blocks = new Map<string, Map<string, Block>>();
  // The last failed bash command per top-level session. Sent as context, not judged.
  const failures = new Map<string, Failure>();
  // A subagent's prompt is written by the parent agent, not the user. It never counts as the user asking.
  // The parent is kept so a subagent's edits are still checked against the user's instructions.
  const parents = new Map<string, string>();
  // The `instructions` list from the user's OpenCode config. OpenCode loads those files too.
  let configured: string[] = [];
  const sentences = new Map<string, boolean>();
  const pending = new Map<string, Promise<string | undefined>>();
  // Commands and edits per top-level session since the user's last message, for the claim check.
  const steps = new Map<string, Step[]>();
  // Earlier turns, so a summary of committed work still counts as backed.
  const past = new Map<string, Step[]>();
  // messageCount when each session was last checked. One check per user message.
  const checked = new Map<string, number>();
  const disk = { root, read: readSource, list: listDir };
  // One listing for the reuse, special-case, and stale-comment checks. Built once, then cached.
  const project = new ProjectIndex(productionAsyncDisk(root));
  // The user of a subagent session is the user of the session that started it.
  const topOf = (session: string) => {
    let top = session;
    for (let hops = 0; hops < 10; hops += 1) {
      const parent = parents.get(top);
      if (parent === undefined) break;
      top = parent;
    }
    return top;
  };
  const log = (message: string) => {
    try {
      void input.client.app
        .log({ body: { service: 'jevy-vet', level: 'warn', message } })
        .catch(() => undefined);
    } catch {
      return;
    }
  };
  const load = () => loadSettings(process.env, homedir());
  const remember = <T>(map: Map<string, T>, key: string, value: T) => {
    // Delete first so this session moves to the end.
    map.delete(key);
    map.set(key, value);
    if (map.size > KEEP_SESSIONS) {
      const oldest = map.keys().next().value;
      if (oldest !== undefined) map.delete(oldest);
    }
  };
  const append = (map: Map<string, Step[]>, session: string, added: Step[]) => remember(map, session, [...map.get(session) ?? [], ...added].slice(-KEEP_STEPS));
  const record = (session: string, step: Step) => append(steps, session, [step]);
  const checkTurn = async (session: string) => {
    // A subagent reports to its parent agent, not to the user.
    if (parents.has(session)) return;
    const count = counts.get(session) ?? 0;
    // The follow-up is synthetic, so it adds no user message, and the idle after it is skipped here.
    if (count === 0 || checked.get(session) === count) return;
    // Mark before the await. The follow-up can go idle while this check is still running.
    remember(checked, session, count);
    const history = (await input.client.session?.messages({ path: { id: session }, query: { limit: READ_MESSAGES } }))?.data ?? [];
    const last = history.at(-1);
    const user = history.filter(item => item.info.role === 'user').at(-1);
    // An aborted or failed turn has no final message to check.
    if (last?.info.role !== 'assistant' || last.info.error) return;
    // A user message that is all synthetic is a plugin's own prompt.
    if (!user || user.parts.every(part => part.synthetic)) return;
    const text = last.parts
      .filter(part => part.type === 'text' && !part.synthetic && !part.ignored)
      .map(part => part.text ?? '')
      .join('\n')
      .trim();
    if (text === '') return;
    const found = await checkClaims(text, { load, fetch: globalThis.fetch, log, userMessages: messages.get(session) ?? [], steps: steps.get(session) ?? [], pastSteps: past.get(session) });
    // A newer user message starts a new turn, and the finding is stale.
    if (!found || (counts.get(session) ?? 0) !== count) return;
    // Same agent and model as the user's turn, so a plan-only agent is not switched to one that edits.
    const agent = user.info.agent;
    if (found.followUp && agent) {
      await input.client.session?.promptAsync({
        path: { id: session },
        body: { agent, ...(user.info.model ? { model: user.info.model } : {}), parts: [{ type: 'text', text: found.followUp, synthetic: true }] },
      });
    }
    await input.client.tui?.showToast({ body: { title: 'Jevy', message: found.note, variant: found.followUp ? 'info' : 'warning' } });
  };
  return {
    config: (config: { instructions?: unknown }) => {
      configured = Array.isArray(config.instructions) ? config.instructions.filter((item: unknown): item is string => typeof item === 'string') : [];
      return Promise.resolve();
    },
    event: ({ event }: { event: PluginEvent }) => {
      const info = event.properties?.info;
      if (event.type === 'session.created' && info?.id && info.parentID) parents.set(info.id, info.parentID);
      // Ids only, so keep more of these than message sessions.
      if (parents.size > KEEP_SESSIONS * 10) {
        const oldest = parents.keys().next().value;
        if (oldest !== undefined) parents.delete(oldest);
      }
      // session.idle is deprecated in OpenCode. session.status with an idle status is sent at the same time.
      const session = event.properties?.sessionID;
      if (event.type === 'session.status' && event.properties?.status?.type === 'idle' && session) {
        // OpenCode does not await plugin events. A failed check must not reject.
        return checkTurn(session).catch(() => undefined);
      }
      return Promise.resolve();
    },
    'chat.message': (hook: { sessionID: string }, output: ChatMessage) => {
      const text = output.parts
        .filter(part => part.type === 'text' && !part.synthetic && !part.ignored && typeof part.text === 'string')
        .map(part => part.text)
        .join('\n')
        .trim();
      if (text === '') return Promise.resolve();
      const kept = [...messages.get(hook.sessionID) ?? [], headTail(text, MAX_MESSAGE_CHARS).text].slice(-KEEP_MESSAGES);
      // Delete first so this session moves to the end.
      messages.delete(hook.sessionID);
      messages.set(hook.sessionID, kept);
      counts.set(hook.sessionID, (counts.get(hook.sessionID) ?? 0) + 1);
      // A new turn. Recent steps move to past, so a summary of earlier work still counts as backed.
      if (!parents.has(hook.sessionID)) {
        const cur = steps.get(hook.sessionID);
        if (cur?.length) append(past, hook.sessionID, cur);
        steps.delete(hook.sessionID);
      }
      if (messages.size > KEEP_SESSIONS) {
        const oldest = messages.keys().next().value;
        if (oldest !== undefined) {
          messages.delete(oldest);
          counts.delete(oldest);
        }
      }
      return Promise.resolve();
    },
    'tool.execute.before': async (hook: { tool: string; sessionID?: string; callID?: string }, output: { args: unknown }) => {
      const session = hook.sessionID ?? '';
      // Start the walk on the first call, whatever the tool. Later calls reuse it.
      void project.ensure().catch(() => undefined);
      const shared = {
        load,
        fetch: globalThis.fetch,
        disk,
        log,
        project,
      };
      const top = topOf(session);
      // A block in a subagent is answered by the user in the top session, so blocks are kept there.
      let sessionBlocks = blocks.get(top);
      if (!sessionBlocks) {
        sessionBlocks = new Map<string, Block>();
        blocks.set(top, sessionBlocks);
        if (blocks.size > KEEP_SESSIONS) {
          const oldest = blocks.keys().next().value;
          if (oldest !== undefined) blocks.delete(oldest);
        }
      }
      const notes: string[] = [];
      const reason = await review(hook.tool, output.args, {
        ...shared,
        userMessages: parents.has(session) ? [] : messages.get(session) ?? [],
        history: { blocks: sessionBlocks, messages: messages.get(top) ?? [], messageCount: counts.get(top) ?? 0, lastFailure: failures.get(top) },
        warn: note => notes.push(note),
      });
      if (reason) throw new Error(reason);
      if (!hook.callID) return;
      // Started now so they run while the tool does. The after hook adds the notes.
      const instruction = checkInstructions(hook.tool, output.args, {
        ...shared,
        userMessages: messages.get(top) ?? [],
        cache: sentences,
        instructionFiles: paths => instructionFilesFor(paths, { worktree, home: homedir(), env: process.env, configured, glob: globFiles }, disk),
      }).catch(() => undefined);
      const reuse = checkReuse(hook.tool, output.args, { ...shared, userMessages: messages.get(top) ?? [] }).catch(() => undefined);
      const hidden = checkHiddenErrors(hook.tool, output.args, { ...shared, userMessages: messages.get(top) ?? [], lastFailure: failures.get(top) }).catch(() => undefined);
      const stale = checkStaleDocs(hook.tool, output.args, { ...shared, userMessages: messages.get(top) ?? [] }).catch(() => undefined);
      pending.set(hook.callID, Promise.all([instruction, reuse, hidden, stale]).then(found => {
        const parts = [...notes];
        for (const note of found) if (note) parts.push(note);
        return parts.join('\n\n') || undefined;
      }));
      if (pending.size > KEEP_PENDING) {
        const oldest = pending.keys().next().value;
        if (oldest !== undefined) pending.delete(oldest);
      }
    },
    // OpenCode returns this same output object to the model, so an appended note reaches the agent.
    'tool.execute.after': async (hook: { tool: string; sessionID: string; callID: string; args: unknown }, output: { title: string; output: string; metadata: unknown }) => {
      const top = topOf(hook.sessionID);
      const run = commandFrom(hook.tool, hook.args);
      // OpenCode's bash tool returns a failed command as output, with the exit code in metadata.
      const exit = typeof output.metadata === 'object' && output.metadata !== null && 'exit' in output.metadata ? output.metadata.exit : undefined;
      if (run && typeof exit === 'number') {
        if (exit !== 0) remember(failures, top, { command: run.command, output: headTail(output.output, MAX_FAILURE_CHARS).text });
        else if (failures.get(top)?.command === run.command) failures.delete(top);
        record(top, { command: run.command, exit, output: headTail(output.output, MAX_STEP_OUTPUT_CHARS).text });
      }
      // Paths only. Old file text is not part of a claim step, so do not read the disk.
      const edited = changesFrom(hook.tool, hook.args, () => undefined).map(change => shownPath(root, change.path));
      if (edited.length > 0) record(top, { edited });
      // The next view re-reads what this call changed. After a bash call the listing may be stale too.
      if (edited.length > 0) project.markStale(edited);
      if (commandFrom(hook.tool, hook.args)) project.markListingStale();
      const check = pending.get(hook.callID);
      if (!check) return;
      pending.delete(hook.callID);
      const note = await check;
      if (note) output.output = `${output.output}\n\n${note}`;
    },
  };
}
