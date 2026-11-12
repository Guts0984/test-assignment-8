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
 *  - soft limits only throttle WRONG guesses: someone behind the same NAT as an attacker still signs in with the
 *    right password. Hard caps (much higher) refuse everything unchecked, which bounds the guessing on one address;
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

  // hard caps are never below the soft limits (an operator may raise only the soft ones)
  const ipHard = Math.max(env.LOGIN_IP_HARD_MAX_FAILURES, env.LOGIN_IP_MAX_FAILURES);
  const pairHard = Math.max(env.LOGIN_PAIR_HARD_MAX_FAILURES, env.LOGIN_PAIR_MAX_FAILURES);
  const [ip, pair] = await Promise.all([
    limiter.hit(ipKey, ipHard, w),
    limiter.hit(pairKey, pairHard, w),
  ]);
  if (!ip.allowed || !pair.allowed) {
    throw tooManyRequests(
      Math.max(ip.allowed ? 0 : ip.retryAfterSeconds, pair.allowed ? 0 : pair.retryAfterSeconds),
      'Too many failed login attempts',
    );
  }
  // past the soft limit the attempt is still CHECKED: a wrong password is throttled (429), the right one gets in
  const throttled =
    ip.count > env.LOGIN_IP_MAX_FAILURES || pair.count > env.LOGIN_PAIR_MAX_FAILURES;

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

  if (!ok || !user) {
    if (throttled) {
      throw tooManyRequests(
        Math.max(ip.retryAfterSeconds, pair.retryAfterSeconds),
        'Too many failed login attempts',
      );
    }
    throw appError(401, 'unauthenticated', 'Invalid email or password');
  }

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
