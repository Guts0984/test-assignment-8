import { randomUUID } from 'node:crypto';
import { mkdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

/** Files are stored under random names (never derived from user input) inside one directory. */
export const createStorage = (rootDir: string) => {
  const root = path.resolve(rootDir);
  const pathFor = (key: string): string => {
    if (!/^[0-9a-f-]{36}$/.test(key)) throw new Error('invalid storage key'); // defence in depth against path tricks
    return path.join(root, key);
  };
  return {
    root,
    ensure: () => mkdir(root, { recursive: true, mode: 0o750 }),
    /** Atomic: the final name only ever appears with complete content. */
    save: async (bytes: Buffer): Promise<string> => {
      const key = randomUUID();
      const tmp = path.join(root, `.tmp-${randomUUID()}`);
      try {
        await writeFile(tmp, bytes, { flag: 'wx', mode: 0o640 });
        await rename(tmp, pathFor(key));
      } catch (err) {
        await rm(tmp, { force: true });
        throw err;
      }
      return key;
    },
    remove: (key: string) => rm(pathFor(key), { force: true }),
    path: pathFor,
    size: async (key: string): Promise<number | null> => {
      try {
        return (await stat(pathFor(key))).size;
      } catch {
        return null;
      }
    },
  };
};
export type Storage = ReturnType<typeof createStorage>;
