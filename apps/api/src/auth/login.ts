import type { Db } from '@helpdesk/db';
import { users } from '@helpdesk/db';
import { eq } from 'drizzle-orm';
import type { Env } from '../env';
import { appError, tooManyRequests } from '../lib/errors';
import type { Limiter } from '../lib/limiter';
import { dummyHash, verifyPassword } from '../lib/passwords';
import { Busy, type createSemaphore } from '../lib/semaphore';
import { createSession, deleteSessionByToken } from '../lib/sessions';

export type LoginDeps = {
  db: Db;
  limiter: Limiter;
  env: Env;
  gate: ReturnType<typeof createSemaphore>;
};
export type LoginInput = {
  email: string;
  password: string;
  clientKey: string;
  ip: string;
  userAgent: string | undefined;
  presentedToken: string | undefined;
};

/**
 * Login with brute-force protection that an attacker cannot turn into a lock-out of someone else:
 *  - counters are keyed by (client address) and by (client address + account), never by account alone;
 *    so hammering `victim@x` from address A never blocks the victim logging in from address B;
 *  - an attempt is RESERVED (counted) before the password is checked, so N parallel guesses cannot
 *    overshoot the limit; a successful login gives the reservation back;
 *  - unknown accounts cost the same as known ones (verify against a dummy hash);
 *  - expensive hashing runs behind a bounded semaphore (distributed floods get a fast refusal).
 */
export const login = async (
  deps: LoginDeps,
  input: LoginInput,
): Promise<{ token: string; userId: string }> => {
  const { env, limiter } = deps;
  const ipKey = `login:ip:${input.clientKey}`;
  const pairKey = `login:pair:${input.clientKey}:${input.email}`;
  const w = env.LOGIN_WINDOW_SECONDS;

  const [ip, pair] = await Promise.all([
    limiter.hit(ipKey, env.LOGIN_IP_MAX_FAILURES, w),
    limiter.hit(pairKey, env.LOGIN_PAIR_MAX_FAILURES, w),
  ]);
  if (!ip.allowed || !pair.allowed) {
    throw tooManyRequests(
      Math.max(ip.allowed ? 0 : ip.retryAfterSeconds, pair.allowed ? 0 : pair.retryAfterSeconds),
      'Too many failed login attempts',
    );
  }

  const found = await deps.db.select().from(users).where(eq(users.email, input.email)).limit(1);
  const user = found[0];
  let ok: boolean;
  try {
    ok = await deps.gate.run(async () =>
      user && !user.disabled
        ? verifyPassword(user.passwordHash, input.password)
        : verifyPassword(await dummyHash(), input.password).then(() => false),
    );
  } catch (err) {
    if (err instanceof Busy) {
      await Promise.all([limiter.refund(ipKey), limiter.refund(pairKey)]);
      throw tooManyRequests(1, 'Server is busy, retry shortly');
    }
    throw err;
  }

  if (!ok || !user) throw appError(401, 'unauthenticated', 'Invalid email or password');

  // success: hand the reservation back and start a fresh session (never reuse a presented one)
  await Promise.all([limiter.refund(ipKey), limiter.reset(pairKey)]);
  if (input.presentedToken) await deleteSessionByToken(deps.db, input.presentedToken);
  const token = await createSession(deps.db, {
    userId: user.id,
    ip: input.ip,
    userAgent: input.userAgent,
    ttlHours: env.SESSION_TTL_HOURS,
    maxPerUser: env.SESSION_MAX_PER_USER,
  });
  return { token, userId: user.id };
};
