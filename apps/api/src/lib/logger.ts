export type LogLevel = 'debug' | 'info' | 'warn' | 'error' | 'silent';
const order: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40, silent: 100 };

export type Logger = Readonly<
  Record<
    'debug' | 'info' | 'warn' | 'error',
    (msg: string, fields?: Record<string, unknown>) => void
  >
>;

/** One JSON object per line on stdout/stderr. Never pass cookies, passwords or request bodies here. */
export const createLogger = (level: LogLevel): Logger => {
  const emit =
    (lvl: Exclude<LogLevel, 'silent'>) =>
    (msg: string, fields: Record<string, unknown> = {}) => {
      if (order[lvl] < order[level]) return;
      const line = JSON.stringify({ t: new Date().toISOString(), level: lvl, msg, ...fields });
      (lvl === 'error' || lvl === 'warn' ? process.stderr : process.stdout).write(`${line}\n`);
    };
  return { debug: emit('debug'), info: emit('info'), warn: emit('warn'), error: emit('error') };
};
