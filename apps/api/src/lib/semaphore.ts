export class Busy extends Error {
  constructor() {
    super('server is busy');
  }
}

/**
 * Bounds concurrent expensive work (argon2). Beyond `queueMax` waiting callers, new ones are refused
 * immediately instead of piling up — a distributed login flood must not starve the libuv thread pool
 * that every other request also needs.
 */
export const createSemaphore = (max: number, queueMax: number) => {
  let active = 0;
  const waiting: Array<() => void> = [];
  const release = () => {
    const next = waiting.shift();
    if (next) next();
    else active -= 1;
  };
  return {
    run: async <T>(fn: () => Promise<T>): Promise<T> => {
      if (active < max) active += 1;
      else if (waiting.length >= queueMax) throw new Busy();
      else await new Promise<void>((resolve) => waiting.push(resolve));
      try {
        return await fn();
      } finally {
        release();
      }
    },
    stats: () => ({ active, waiting: waiting.length }),
  };
};
