import { Body, Controller, Get, HttpCode, Inject, Param, Post, Req, Res } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { DbHandle } from '@helpdesk/db';
import { presenceSchema, uuidSchema } from '@helpdesk/shared';
import { sql } from 'drizzle-orm';
import type { Request, Response } from 'express';
import { z } from 'zod';
import { Roles } from '../auth/decorators';
import type { Env } from '../env';
import { ZodPipe } from '../http/zod.pipe';
import { appError } from '../lib/errors';
import { parseCookies } from '../lib/cookies';
import { findSession, type SessionUser } from '../lib/sessions';
import { emit } from '../tickets/history';
import { fetchTicket } from '../tickets/mutate';
import { TOKENS } from '../tokens';
import type { Realtime } from './realtime';

const user = (req: Request): SessionUser => {
  if (!req.auth) throw new Error('auth guard did not run');
  return req.auth.user;
};
const PRESENCE_TTL_SECONDS = 8;

@ApiTags('realtime')
@Controller()
export class RealtimeController {
  constructor(
    @Inject(TOKENS.DB) private readonly db: DbHandle,
    @Inject(TOKENS.ENV) private readonly env: Env,
    @Inject(TOKENS.REALTIME) private readonly rt: Realtime,
  ) {}

  @Get('events')
  @ApiOperation({
    summary:
      'Server-Sent Events: new messages, ticket changes, notifications, presence — only what you may see. Resume with Last-Event-ID.',
  })
  async events(@Req() req: Request, @Res() res: Response): Promise<void> {
    const u = user(req);
    if (
      this.rt.countFor(u.id) >= this.env.SSE_MAX_PER_USER ||
      this.rt.countForClient(req.clientKey) >= this.env.SSE_MAX_PER_IP
    ) {
      throw appError(429, 'rate_limited', 'Too many open event streams', { retryAfterSeconds: 5 });
    }
    res.status(200);
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();
    res.write('retry: 3000\n: connected\n\n');

    const conn = this.rt.add(u, req.clientKey, res);
    const token = parseCookies(req.headers.cookie).get(this.env.COOKIE_NAME);
    const heartbeat = setInterval(() => {
      // a stream must not outlive its session (logout, expiry, disabled account)
      void (token ? findSession(this.db.db, token) : Promise.resolve(null)).then(
        (s) => {
          if (!s) res.end();
          else this.rt.write(conn, ': ping\n\n');
        },
        () => this.rt.write(conn, ': ping\n\n'),
      );
    }, this.env.SSE_HEARTBEAT_MS);
    const cleanup = () => {
      clearInterval(heartbeat);
      this.rt.remove(conn);
    };
    res.on('close', cleanup);

    const last = req.get('last-event-id');
    if (last && /^\d{1,18}$/.test(last))
      await this.rt.replay(conn, BigInt(last)).catch(() => undefined);
  }

  @Post('tickets/:id/typing')
  @Roles('agent', 'lead')
  @HttpCode(204)
  @ApiOperation({
    summary:
      'Tell colleagues you are writing a reply in this ticket (repeat every ~5 s; it expires after 8 s)',
  })
  async typing(
    @Req() req: Request,
    @Param('id', new ZodPipe(uuidSchema)) id: string,
    @Body(new ZodPipe(presenceSchema)) body: z.infer<typeof presenceSchema>,
  ): Promise<void> {
    const u = user(req);
    if (!(await fetchTicket(this.db.db, u, id)))
      throw appError(404, 'not_found', 'Ticket not found');
    await this.db.db.transaction(async (tx) => {
      if (body.typing) {
        await tx.execute(sql`
          INSERT INTO ticket_presence (ticket_id, user_id, expires_at) VALUES (${id}, ${u.id}, now() + make_interval(secs => ${PRESENCE_TTL_SECONDS}))
          ON CONFLICT (ticket_id, user_id) DO UPDATE SET expires_at = EXCLUDED.expires_at`);
      } else {
        await tx.execute(
          sql`DELETE FROM ticket_presence WHERE ticket_id = ${id} AND user_id = ${u.id}`,
        );
      }
      await emit(tx, 'presence', id, { userId: u.id, typing: body.typing });
    });
  }

  @Get('tickets/:id/presence')
  @Roles('agent', 'lead')
  @ApiOperation({ summary: 'Colleagues currently writing in this ticket' })
  async presence(@Req() req: Request, @Param('id', new ZodPipe(uuidSchema)) id: string) {
    const u = user(req);
    if (!(await fetchTicket(this.db.db, u, id)))
      throw appError(404, 'not_found', 'Ticket not found');
    const r = await this.db.db.execute<{ id: string; name: string }>(sql`
      SELECT us.id, us.name FROM ticket_presence p JOIN users us ON us.id = p.user_id
      WHERE p.ticket_id = ${id} AND p.expires_at > now() AND p.user_id <> ${u.id} ORDER BY us.name`);
    return r.rows;
  }
}
