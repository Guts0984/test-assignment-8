import { z } from 'zod';

const bool = z.enum(['true', 'false', '1', '0']).transform((v) => v === 'true' || v === '1');
const csv = z.string().transform((s) =>
  s
    .split(',')
    .map((x) => x.trim())
    .filter((x) => x.length > 0),
);
const int = (def: number, min: number, max: number) =>
  z.coerce.number().int().min(min).max(max).default(def);

/**
 * Every environment variable of the API, parsed once at startup.
 * Non-secret variables have defaults; SECRETS (DATABASE_URL) have none, so a missing one fails fast.
 */
const rawEnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error', 'silent']).default('info'),
  HOST: z.string().min(1).default('0.0.0.0'),
  PORT: int(3001, 1, 65_535),

  // --- secret: no default ---
  DATABASE_URL: z.string().url(),

  DB_POOL_MAX: int(10, 1, 100),
  DB_STATEMENT_TIMEOUT_MS: int(10_000, 100, 120_000),
  DB_CONNECT_TIMEOUT_MS: int(5_000, 100, 60_000),
  AUTO_MIGRATE: bool.default(true),
  AUTO_SEED: bool.default(false),

  SESSION_TTL_HOURS: int(24 * 7, 1, 24 * 365),
  SESSION_MAX_PER_USER: int(10, 1, 100),
  COOKIE_NAME: z
    .string()
    .regex(/^[A-Za-z0-9_-]{1,64}$/)
    .default('hd_session'),
  /** Defaults to true in production, false otherwise. */
  COOKIE_SECURE: bool.optional(),

  /** Peers allowed to set X-Forwarded-For (IPs or CIDRs). Empty = never trust the header. */
  TRUSTED_PROXIES: csv.default([]),
  /** Origins allowed for CORS and for state-changing requests (CSRF). */
  CORS_ORIGINS: csv.default(['http://localhost:3000']),

  RATE_LIMIT_API_PER_MIN: int(300, 1, 1_000_000),
  RATE_LIMIT_USER_PER_MIN: int(600, 1, 1_000_000),
  LOGIN_WINDOW_SECONDS: int(900, 1, 86_400),
  LOGIN_IP_MAX_FAILURES: int(20, 1, 10_000),
  LOGIN_PAIR_MAX_FAILURES: int(5, 1, 1_000),
  LOGIN_MAX_CONCURRENCY: int(4, 1, 64),
  LOGIN_QUEUE_MAX: int(16, 0, 1_000),

  BODY_LIMIT_BYTES: int(256 * 1024, 1_024, 50 * 1024 * 1024),
  MAX_CONNECTIONS: int(2_000, 1, 100_000),
  HEADERS_TIMEOUT_MS: int(10_000, 100, 120_000),
  REQUEST_TIMEOUT_MS: int(30_000, 100, 600_000),
  KEEP_ALIVE_TIMEOUT_MS: int(5_000, 100, 120_000),
  SHUTDOWN_TIMEOUT_MS: int(10_000, 100, 120_000),
});

export type Env = Omit<z.infer<typeof rawEnvSchema>, 'COOKIE_SECURE'> & { COOKIE_SECURE: boolean };

/** Pure: throws an Error that names the offending variables but never echoes their values. */
export const parseEnv = (raw: Record<string, string | undefined>): Env => {
  // Empty strings (e.g. `FOO=` in .env) count as "not set".
  const cleaned = Object.fromEntries(
    Object.entries(raw).filter(([, v]) => v !== undefined && v !== ''),
  );
  const parsed = rawEnvSchema.safeParse(cleaned);
  if (!parsed.success) {
    const problems = parsed.error.issues.map(
      (i) => `${i.path.join('.') || '(root)'}: ${i.message}`,
    );
    throw new Error(`Invalid environment:\n  ${problems.join('\n  ')}`);
  }
  const env = parsed.data;
  return { ...env, COOKIE_SECURE: env.COOKIE_SECURE ?? env.NODE_ENV === 'production' };
};

export const loadEnv = (): Env => parseEnv(process.env);
