import type { Env } from '../env';
import type { SessionUser } from '../lib/sessions';

declare module 'express-serve-static-core' {
  interface Request {
    requestId: string;
    clientIp: string;
    /** Rate-limit bucket for the client (IPv6 collapsed to its /64). */
    clientKey: string;
    auth?: { user: SessionUser; sessionId: string };
  }
}

export type AppState = { draining: boolean };
export type { Env };
