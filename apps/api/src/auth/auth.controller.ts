import { Body, Controller, Get, HttpCode, Inject, Post, Req, Res } from '@nestjs/common';
import { ApiBody, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { DbHandle } from '@helpdesk/db';
import { loginSchema, type LoginInput as LoginBody, type Me } from '@helpdesk/shared';
import type { Request, Response } from 'express';
import { jsonSchemaOf } from '../http/swagger';
import { TOKENS } from '../tokens';
import type { Env } from '../env';
import { appError } from '../lib/errors';
import { ZodPipe } from '../http/zod.pipe';
import { clearSessionCookie, parseCookies, serializeSessionCookie } from '../lib/cookies';
import type { Limiter } from '../lib/limiter';
import { deleteSessionByToken, hashToken, loadSessionUser } from '../lib/sessions';
import type { Realtime } from '../realtime/realtime';
import type { createSemaphore } from '../lib/semaphore';
import { Public } from './decorators';
import { login } from './login';

@ApiTags('auth')
@Controller()
export class AuthController {
  constructor(
    @Inject(TOKENS.DB) private readonly db: DbHandle,
    @Inject(TOKENS.ENV) private readonly env: Env,
    @Inject(TOKENS.LIMITER) private readonly limiter: Limiter,
    @Inject(TOKENS.LOGIN_GATE) private readonly gate: ReturnType<typeof createSemaphore>,
    @Inject(TOKENS.REALTIME) private readonly rt: Realtime,
  ) {}

  @Public()
  @Post('auth/login')
  @HttpCode(200)
  @ApiOperation({ summary: 'Log in; sets an httpOnly session cookie' })
  @ApiBody({ schema: jsonSchemaOf(loginSchema) })
  async login(
    @Body(new ZodPipe(loginSchema)) body: LoginBody,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<{ user: Me }> {
    const result = await login(
      { db: this.db.db, limiter: this.limiter, env: this.env, gate: this.gate },
      {
        email: body.email,
        password: body.password,
        clientKey: req.clientKey,
        ip: req.clientIp,
        userAgent: req.get('user-agent'),
        presentedToken: parseCookies(req.headers.cookie).get(this.env.COOKIE_NAME),
      },
    );
    res.setHeader(
      'Set-Cookie',
      serializeSessionCookie(this.env.COOKIE_NAME, result.token, {
        maxAgeSeconds: this.env.SESSION_TTL_HOURS * 3600,
        secure: this.env.COOKIE_SECURE,
      }),
    );
    const user = await loadSessionUser(this.db.db, result.userId);
    if (!user) throw appError(401, 'unauthenticated', 'Invalid email or password');
    return { user };
  }

  @Public()
  @Post('auth/logout')
  @HttpCode(204)
  @ApiOperation({ summary: 'Invalidate the current session (idempotent)' })
  async logout(@Req() req: Request, @Res({ passthrough: true }) res: Response): Promise<void> {
    const token = parseCookies(req.headers.cookie).get(this.env.COOKIE_NAME);
    if (token) {
      await deleteSessionByToken(this.db.db, token);
      this.rt.closeSession(hashToken(token)); // the live stream must not outlive the session
    }
    res.setHeader('Set-Cookie', clearSessionCookie(this.env.COOKIE_NAME, this.env.COOKIE_SECURE));
  }

  @Get('me')
  @ApiOperation({ summary: 'Current user' })
  me(@Req() req: Request): Me {
    const user = req.auth?.user;
    if (!user) throw new Error('auth guard did not run'); // unreachable: guard is global
    return user;
  }
}
