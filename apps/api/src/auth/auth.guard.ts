import { type CanActivate, type ExecutionContext, Inject, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { DbHandle } from '@helpdesk/db';
import type { Role } from '@helpdesk/shared';
import type { Request, Response } from 'express';
import { TOKENS } from '../tokens';
import type { Env } from '../env';
import { appError, tooManyRequests } from '../lib/errors';
import { clearSessionCookie, parseCookies } from '../lib/cookies';
import type { Limiter } from '../lib/limiter';
import { findSession } from '../lib/sessions';
import { IS_PUBLIC, ROLES_KEY } from './decorators';

/** Global guard: authenticates every route that is not @Public(), enforces @Roles(), applies the per-user quota. */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    @Inject(TOKENS.DB) private readonly db: DbHandle,
    @Inject(TOKENS.ENV) private readonly env: Env,
    @Inject(TOKENS.LIMITER) private readonly limiter: Limiter,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const targets = [context.getHandler(), context.getClass()];
    if (this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, targets)) return true;

    const req = context.switchToHttp().getRequest<Request>();
    const res = context.switchToHttp().getResponse<Response>();
    const token = parseCookies(req.headers.cookie).get(this.env.COOKIE_NAME);
    const found = token ? await findSession(this.db.db, token) : null;
    if (!found) {
      if (token)
        res.append('Set-Cookie', clearSessionCookie(this.env.COOKIE_NAME, this.env.COOKIE_SECURE));
      throw appError(401, 'unauthenticated', 'Authentication required');
    }
    req.auth = { user: found.user, sessionId: found.sessionId };

    const quota = await this.limiter.hit(
      `user:${found.user.id}`,
      this.env.RATE_LIMIT_USER_PER_MIN,
      60,
    );
    if (!quota.allowed) throw tooManyRequests(quota.retryAfterSeconds);

    const roles = this.reflector.getAllAndOverride<Role[] | undefined>(ROLES_KEY, targets);
    if (roles && !roles.includes(found.user.role))
      throw appError(403, 'forbidden', 'Insufficient permissions');
    return true;
  }
}
