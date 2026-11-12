import { createHash, randomBytes } from 'node:crypto';
import { sessions, users, agentCategories, type Db } from '@helpdesk/db';
import type { Category, Locale, Role } from '@helpdesk/shared';
import { and, asc, eq, gt, sql } from 'drizzle-orm';

const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;

/** 256 random bits, base64url. Only its SHA-256 is stored, so a database leak does not leak sessions. */
export const newToken = (): string => randomBytes(32).toString('base64url');
export const isWellFormedToken = (t: string): boolean => TOKEN_RE.test(t);
export const hashToken = (token: string): string =>
  createHash('sha256').update(token).digest('hex');

export type SessionUser = {
  id: string;
  email: string;
  name: string;
  role: Role;
  locale: Locale;
  categories: Category[];
};

export const createSession = async (
  db: Db,
  input: {
    userId: string;
    ip: string;
    userAgent: string | undefined;
    ttlHours: number;
    maxPerUser: number;
  },
): Promise<string> => {
  const token = newToken();
  await db.transaction(async (tx) => {
    await tx.insert(sessions).values({
      id: hashToken(token),
      userId: input.userId,
      expiresAt: sql`now() + make_interval(hours => ${input.ttlHours})` as unknown as Date,
      ip: input.ip,
      userAgent: input.userAgent?.slice(0, 300) ?? null,
    });
    // keep only the newest N sessions of this user
    const keep = await tx
      .select({ id: sessions.id })
      .from(sessions)
      .where(eq(sessions.userId, input.userId))
      .orderBy(sql`${sessions.createdAt} DESC`, asc(sessions.id))
      .limit(input.maxPerUser);
    if (keep.length === input.maxPerUser) {
      await tx.execute(
        sql`DELETE FROM sessions WHERE user_id = ${input.userId} AND id NOT IN (${sql.join(
          keep.map((k) => sql`${k.id}`),
          sql`, `,
        )})`,
      );
    }
  });
  return token;
};

/** Valid = well-formed, stored, not expired, and the user is not disabled. */
export const findSession = async (
  db: Db,
  token: string,
): Promise<{ sessionId: string; user: SessionUser } | null> => {
  if (!isWellFormedToken(token)) return null;
  const id = hashToken(token);
  const rows = await db
    .select({
      sessionId: sessions.id,
      lastSeenAt: sessions.lastSeenAt,
      id: users.id,
      email: users.email,
      name: users.name,
      role: users.role,
      locale: users.locale,
    })
    .from(sessions)
    .innerJoin(users, eq(users.id, sessions.userId))
    .where(and(eq(sessions.id, id), gt(sessions.expiresAt, sql`now()`), eq(users.disabled, false)))
    .limit(1);
  const row = rows[0];
  if (!row) return null;
  const cats =
    row.role === 'agent'
      ? await db
          .select({ category: agentCategories.category })
          .from(agentCategories)
          .where(eq(agentCategories.userId, row.id))
      : [];
  // refresh last_seen at most once a minute (cheap sliding activity marker)
  if (Date.now() - row.lastSeenAt.getTime() > 60_000) {
    await db
      .update(sessions)
      .set({ lastSeenAt: sql`now()` as unknown as Date })
      .where(eq(sessions.id, id));
  }
  return {
    sessionId: id,
    user: {
      id: row.id,
      email: row.email,
      name: row.name,
      role: row.role,
      locale: row.locale,
      categories: cats.map((c) => c.category as Category),
    },
  };
};

export const deleteSessionByToken = async (db: Db, token: string): Promise<void> => {
  if (!isWellFormedToken(token)) return;
  await db.delete(sessions).where(eq(sessions.id, hashToken(token)));
};
