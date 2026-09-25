import { homedir } from 'node:os';
import { globFiles, headTail, instructionFilesFor, listDir, readSource } from './context.ts';
import { type Block, checkInstructions, review } from './review.ts';
import { loadSettings } from './settings.ts';

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
  };
}

// The parts of OpenCode's chat.message output this plugin reads.
interface ChatMessage {
  parts: { type: string; text?: string; synthetic?: boolean; ignored?: boolean }[];
}

interface PluginEvent {
  type: string;
  properties?: { info?: { id?: string; parentID?: string } };
}

const KEEP_MESSAGES = 3;
const MAX_MESSAGE_CHARS = 4000;
const KEEP_SESSIONS = 100;
// Checks started before a tool runs and not yet collected after it. A failed tool never collects.
const KEEP_PENDING = 50;

// Blocks useless test writes, notes unsure ones and edits that may break the user's instructions, by calling TypeSafe directly.
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
  // A subagent's prompt is written by the parent agent, not the user. It never counts as the user asking.
  // The parent is kept so a subagent's edits are still checked against the user's instructions.
  const parents = new Map<string, string>();
  // The `instructions` list from the user's OpenCode config. OpenCode loads those files too.
  let configured: string[] = [];
  const sentences = new Map<string, boolean>();
  const pending = new Map<string, Promise<string | undefined>>();
  const disk = { root, read: readSource, list: listDir };
  const log = (message: string) => {
    try {
      void input.client.app
        .log({ body: { service: 'jevy-vet', level: 'warn', message } })
        .catch(() => undefined);
    } catch {
      return;
    }
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
      const shared = {
        load: () => loadSettings(process.env, homedir()),
        fetch: globalThis.fetch,
        disk,
        log,
      };
      // The user of a subagent session is the user of the session that started it.
      let top = session;
      for (let hops = 0; hops < 10; hops += 1) {
        const parent = parents.get(top);
        if (parent === undefined) break;
        top = parent;
      }
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
        history: { blocks: sessionBlocks, messages: messages.get(top) ?? [], messageCount: counts.get(top) ?? 0 },
        warn: note => notes.push(note),
      });
      if (reason) throw new Error(reason);
      if (!hook.callID) return;
      // Started now so it runs while the tool does. The after hook adds the note.
      const check = checkInstructions(hook.tool, output.args, {
        ...shared,
        userMessages: messages.get(top) ?? [],
        cache: sentences,
        instructionFiles: paths => instructionFilesFor(paths, { worktree, home: homedir(), env: process.env, configured, glob: globFiles }, disk),
      }).catch(() => undefined);
      pending.set(hook.callID, check.then(instruction => {
        const parts = instruction ? [...notes, instruction] : notes;
        return parts.join('\n\n') || undefined;
      }));
      if (pending.size > KEEP_PENDING) {
        const oldest = pending.keys().next().value;
        if (oldest !== undefined) pending.delete(oldest);
      }
    },
    // OpenCode returns this same output object to the model, so an appended note reaches the agent.
    'tool.execute.after': async (hook: { tool: string; sessionID: string; callID: string; args: unknown }, output: { title: string; output: string; metadata: unknown }) => {
      const check = pending.get(hook.callID);
      if (!check) return;
      pending.delete(hook.callID);
      const note = await check;
      if (note) output.output = `${output.output}\n\n${note}`;
    },
  };
}
