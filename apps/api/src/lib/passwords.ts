import { hash, verify } from '@node-rs/argon2';

export const hashPassword = (plain: string): Promise<string> => hash(plain);

export const verifyPassword = async (passwordHash: string, plain: string): Promise<boolean> => {
  try {
    return await verify(passwordHash, plain);
  } catch {
    return false; // malformed stored hash must never become a 500
  }
};

let dummy: Promise<string> | undefined;
/** A real argon2 hash to verify against when the account does not exist, so timing does not reveal it. */
export const dummyHash = (): Promise<string> => (dummy ??= hash('not-a-real-password'));
