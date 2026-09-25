import { type ReviewDeps } from './jev.ts';
import { type Settings } from './settings.ts';

export function deps(fetchImpl: ReviewDeps['fetch'], settings: Partial<Settings> = { key: 'ts_secret' }, disk?: ReviewDeps['disk']): ReviewDeps & { logs: string[]; loads: number } {
  const logs: string[] = [];
  let loads = 0;
  return {
    load() {
      loads += 1;
      return {
        key: settings.key ?? '',
        baseUrl: settings.baseUrl ?? '',
        path: settings.path ?? '/cfg/opencode/jevy-vet.jsonc',
        error: settings.error,
      };
    },
    fetch: fetchImpl,
    disk,
    log: message => {
      logs.push(message);
    },
    logs,
    get loads() {
      return loads;
    },
  };
}

export function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

export function memoryDisk(files: Record<string, string>, root = '/repo') {
  const reads: string[] = [];
  return {
    reads,
    disk: {
      root,
      read(path: string) {
        reads.push(path);
        return files[path];
      },
      list(dir: string) {
        return Object.keys(files).filter(path => path.startsWith(`${dir}/`) && !path.slice(dir.length + 1).includes('/')).map(path => path.slice(dir.length + 1));
      },
    },
  };
}

// Lists folders as well as files, the way readdir does.
export function treeDisk(files: Record<string, string>) {
  const reads: string[] = [];
  return {
    reads,
    disk: {
      root: '/repo',
      read(path: string) {
        reads.push(path);
        return files[path];
      },
      list(dir: string) {
        const names = new Set<string>();
        for (const path of Object.keys(files)) {
          if (path.startsWith(`${dir}/`)) names.add(path.slice(dir.length + 1).split('/')[0] ?? '');
        }
        return [...names];
      },
    },
  };
}
