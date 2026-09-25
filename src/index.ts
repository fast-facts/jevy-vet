import { homedir } from 'node:os';
import { review } from './review.ts';
import { loadSettings } from './settings.ts';

interface Input {
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

// Blocks useless test writes by calling TypeSafe directly.
// Reads TYPESAFE_API_KEY from jevy-vet.jsonc next to opencode.json(c).
// TYPESAFE_BASE_URL in that file is optional.
export default async function jevyVet(input: Input) {
  return {
    'tool.execute.before': async (hook: { tool: string }, output: { args: unknown }) => {
      const reason = await review(hook.tool, output.args, {
        load: () => loadSettings(process.env, homedir()),
        fetch: globalThis.fetch,
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
