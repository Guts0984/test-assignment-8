/** Dependency-injection tokens (kept separate from core.ts to avoid circular imports). */
export const TOKENS = {
  ENV: 'ENV',
  DB: 'DB',
  LIMITER: 'LIMITER',
  LOGGER: 'LOGGER',
  STATE: 'APP_STATE',
  LOGIN_GATE: 'LOGIN_GATE',
} as const;
