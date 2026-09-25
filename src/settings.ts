import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const CONFIG_NAME = 'jevy-vet.jsonc';

export interface Settings {
  key: string;
  baseUrl: string;
  path: string;
  error?: string;
}

export function loadSettings(
  env: Record<string, string | undefined> = process.env,
  home = homedir(),
  read: (path: string) => string | undefined = readText,
): Settings {
  const xdg = env.XDG_CONFIG_HOME?.trim();
  const dir = join(xdg ? xdg : join(home, '.config'), 'opencode');
  const file = readConfig(read, dir);
  if (file.error) return { key: '', baseUrl: '', path: file.path, error: file.error };
  if (file.text === undefined) return { key: '', baseUrl: '', path: file.path };
  return parseConfig(file.path, file.text);
}

function readConfig(read: (path: string) => string | undefined, dir: string): { path: string; text?: string; error?: string } {
  const jsonc = join(dir, CONFIG_NAME);
  let path = jsonc;
  try {
    let text = read(jsonc);
    if (text === undefined) {
      path = join(dir, 'jevy-vet.json');
      text = read(path);
    }
    if (text === undefined) return { path: jsonc };
    return { path, text };
  } catch {
    return { path, error: `Could not read ${path}.` };
  }
}

function parseConfig(path: string, text: string): Settings {
  try {
    const parsed = JSON.parse(stripTrailingCommas(stripComments(text)));
    if (!isRecord(parsed)) return { key: '', baseUrl: '', path, error: `${path} is not valid.` };
    return {
      key: typeof parsed.TYPESAFE_API_KEY === 'string' ? parsed.TYPESAFE_API_KEY : '',
      baseUrl: typeof parsed.TYPESAFE_BASE_URL === 'string' ? parsed.TYPESAFE_BASE_URL : '',
      path,
    };
  } catch {
    return { key: '', baseUrl: '', path, error: `${path} is not valid.` };
  }
}

function readText(path: string): string | undefined {
  try {
    return readFileSync(path, 'utf8');
  } catch (error) {
    if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT') return undefined;
    throw error;
  }
}

function stripComments(text: string): string {
  let out = '';
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i] ?? '';
    const next = text[i + 1];
    if (char === '"') {
      const end = endOfString(text, i);
      out += text.slice(i, end + 1);
      i = end;
      continue;
    }
    if (char === '/' && next === '/') {
      out += ' ';
      while (i < text.length && text[i] !== '\n') i += 1;
      continue;
    }
    if (char === '/' && next === '*') {
      out += ' ';
      i += 2;
      while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) i += 1;
      i += 1;
      continue;
    }
    out += char;
  }
  return out;
}

function stripTrailingCommas(text: string): string {
  let out = '';
  for (let i = 0; i < text.length; i += 1) {
    if (text[i] === '"') {
      const end = endOfString(text, i);
      out += text.slice(i, end + 1);
      i = end;
      continue;
    }
    if (text[i] === ',') {
      let j = i + 1;
      while (j < text.length && /\s/.test(text[j] ?? '')) j += 1;
      if (text[j] === '}' || text[j] === ']') continue;
    }
    out += text[i] ?? '';
  }
  return out;
}

function endOfString(text: string, start: number): number {
  for (let i = start + 1; i < text.length; i += 1) {
    if (text[i] === '\\') {
      i += 1;
      continue;
    }
    if (text[i] === '"') return i;
  }
  return text.length - 1;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
