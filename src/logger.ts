const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 } as const;
export type LogLevel = keyof typeof LEVELS;

let current: LogLevel = 'info';

export function setLogLevel(level: LogLevel): void {
  current = level;
}

function emit(level: LogLevel, msg: string, extra?: Record<string, unknown>): void {
  if (LEVELS[level] < LEVELS[current]) return;
  const ts = new Date().toISOString();
  const tail = extra && Object.keys(extra).length ? ' ' + JSON.stringify(extra) : '';
  const line = `${ts} [${level.toUpperCase()}] ${msg}${tail}\n`;
  process.stderr.write(line);
}

export const log = {
  debug: (m: string, e?: Record<string, unknown>) => emit('debug', m, e),
  info: (m: string, e?: Record<string, unknown>) => emit('info', m, e),
  warn: (m: string, e?: Record<string, unknown>) => emit('warn', m, e),
  error: (m: string, e?: Record<string, unknown>) => emit('error', m, e),
};
