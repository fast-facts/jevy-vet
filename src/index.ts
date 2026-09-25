import { homedir } from 'node:os';
import { headTail, listDir, readSource } from './context.ts';
import { review } from './review.ts';
import { loadSettings } from './settings.ts';

interface Input {
  // The project folder. OpenCode passes it. The code under test is only read from inside it.
  directory?: string;
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

// Blocks useless test writes by calling TypeSafe directly.
// Reads TYPESAFE_API_KEY from jevy-vet.jsonc next to opencode.json(c).
// TYPESAFE_BASE_URL in that file is optional.
export default async function jevyVet(input: Input) {
  const root = input.directory ?? process.cwd();
  // The user's latest messages per session, so a test change the user asked for is allowed.
  const messages = new Map<string, string[]>();
  // A subagent's prompt is written by the parent agent, not the user. It never counts as the user asking.
  const subagents = new Set<string>();
  return {
    event: ({ event }: { event: PluginEvent }) => {
      const info = event.properties?.info;
      if (event.type === 'session.created' && info?.id && info.parentID) subagents.add(info.id);
      // Ids only, so keep more of these than message sessions.
      if (subagents.size > KEEP_SESSIONS * 10) {
        const oldest = subagents.values().next().value;
        if (oldest !== undefined) subagents.delete(oldest);
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
      if (messages.size > KEEP_SESSIONS) {
        const oldest = messages.keys().next().value;
        if (oldest !== undefined) messages.delete(oldest);
      }
      return Promise.resolve();
    },
    'tool.execute.before': async (hook: { tool: string; sessionID?: string }, output: { args: unknown }) => {
      const session = hook.sessionID ?? '';
      const reason = await review(hook.tool, output.args, {
        userMessages: subagents.has(session) ? [] : messages.get(session) ?? [],
        load: () => loadSettings(process.env, homedir()),
        fetch: globalThis.fetch,
        disk: { root, read: readSource, list: listDir },
        log(message) {
          try {
            void input.client.app
              .log({ body: { service: 'jevy-vet', level: 'warn', message } })
              .catch(() => undefined);
          } catch {
            return;
          }
        },
      });
      if (reason) throw new Error(reason);
    },
  };
}
