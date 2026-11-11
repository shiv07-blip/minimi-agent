/* Minimal structured logger — one line per event, easy to grep. */

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 } as const;
type Level = keyof typeof LEVELS;

const minLevel: number = LEVELS[(process.env.LOG_LEVEL as Level) ?? 'info'] ?? LEVELS.info;

function log(level: Level, scope: string, msg: string, extra?: unknown) {
  if (LEVELS[level] < minLevel) return;
  const line = `${new Date().toISOString()} ${level.toUpperCase().padEnd(5)} [${scope}] ${msg}`;
  if (extra !== undefined) console.log(line, extra);
  else console.log(line);
}

export function logger(scope: string) {
  return {
    debug: (msg: string, extra?: unknown) => log('debug', scope, msg, extra),
    info: (msg: string, extra?: unknown) => log('info', scope, msg, extra),
    warn: (msg: string, extra?: unknown) => log('warn', scope, msg, extra),
    error: (msg: string, extra?: unknown) => log('error', scope, msg, extra),
  };
}

export function errorMessage(err: unknown): string {
  if (err instanceof Error) {
    const any = err as Error & { status?: number; code?: string };
    const bits = [any.message];
    if (any.status) bits.push(`(status ${any.status})`);
    if (any.code) bits.push(`(${any.code})`);
    return bits.join(' ');
  }
  return String(err);
}
