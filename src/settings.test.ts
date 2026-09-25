import { describe, expect, test } from 'bun:test';
import { loadSettings } from './settings.ts';

describe('loadSettings', () => {
  test('reads comments and a trailing comma from jevy-vet.jsonc', () => {
    const settings = loadSettings({ XDG_CONFIG_HOME: '/cfg' }, '/home/me', path => {
      expect(path).toBe('/cfg/opencode/jevy-vet.jsonc');
      return `{
        // kept out of the request
        "TYPESAFE_API_KEY": "ts_secret, }",
        "TYPESAFE_BASE_URL": "https://jev.example/",
      }`;
    });
    expect(settings).toEqual({
      key: 'ts_secret, }',
      baseUrl: 'https://jev.example/',
      path: '/cfg/opencode/jevy-vet.jsonc',
    });
  });

  test('uses jevy-vet.json when the jsonc file is missing', () => {
    const settings = loadSettings({}, '/home/me', path => {
      if (path.endsWith('jevy-vet.jsonc')) return undefined;
      expect(path).toBe('/home/me/.config/opencode/jevy-vet.json');
      return '{ "TYPESAFE_API_KEY": "ts_json" }';
    });
    expect(settings.key).toBe('ts_json');
    expect(settings.path).toBe('/home/me/.config/opencode/jevy-vet.json');
  });

  test('reports a missing file as no key, and a bad file as an error', () => {
    const missing = loadSettings({ XDG_CONFIG_HOME: '/cfg' }, '/home/me', () => undefined);
    expect(missing).toEqual({ key: '', baseUrl: '', path: '/cfg/opencode/jevy-vet.jsonc' });
    const invalid = loadSettings({ XDG_CONFIG_HOME: '/cfg' }, '/home/me', () => '{');
    expect(invalid.error).toBe('/cfg/opencode/jevy-vet.jsonc is not valid.');
    const unreadable = loadSettings({ XDG_CONFIG_HOME: '/cfg' }, '/home/me', () => {
      throw new Error('denied');
    });
    expect(unreadable.error).toBe('Could not read /cfg/opencode/jevy-vet.jsonc.');
  });
});
