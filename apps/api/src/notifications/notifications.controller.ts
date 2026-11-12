import { Body, Controller, Get, HttpCode, Inject, Post, Req } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { DbHandle } from '@helpdesk/db';
import { markReadSchema, type NotificationList } from '@helpdesk/shared';
import { sql } from 'drizzle-orm';
import type { Request } from 'express';
import { z } from 'zod';
import { Roles } from '../auth/decorators';
import { ZodPipe } from '../http/zod.pipe';
import type { SessionUser } from '../lib/sessions';
import { toDate, visibleTo } from '../tickets/model';
import { TOKENS } from '../tokens';

const user = (req: Request): SessionUser => {
  if (!req.auth) throw new Error('auth guard did not run');
  return req.auth.user;
};

@ApiTags('notifications')
@Controller('notifications')
export class NotificationsController {
  constructor(@Inject(TOKENS.DB) private readonly db: DbHandle) {}

  @Get()
  @Roles('agent', 'lead')
  @ApiOperation({
    summary:
      'My latest 50 notifications (assigned, customer replied, SLA soon/breached) and the unread count',
  })
  async list(@Req() req: Request): Promise<NotificationList> {
    const u = user(req);
    // only notifications about tickets the user can STILL see (a ticket moved away must not leak its subject)
    const rows = await this.db.db.execute<{
      id: string;
      type: NotificationList['items'][number]['type'];
      created_at: Date | string;
      read_at: Date | string | null;
      ticket_id: string;
      number: number;
      subject: string;
    }>(sql`
      SELECT n.id, n.type, n.created_at, n.read_at, t.id AS ticket_id, t.number, t.subject
      FROM notifications n JOIN tickets t ON t.id = n.ticket_id
      WHERE n.user_id = ${u.id} AND ${visibleTo(u)}
      ORDER BY n.created_at DESC, n.id DESC LIMIT 50`);
    const unread = await this.db.db.execute<{ n: number }>(sql`
      SELECT count(*)::int AS n FROM notifications n JOIN tickets t ON t.id = n.ticket_id
      WHERE n.user_id = ${u.id} AND n.read_at IS NULL AND ${visibleTo(u)}`);
    return {
      items: rows.rows.map((r) => ({
        id: r.id,
        type: r.type,
        ticket: { id: r.ticket_id, code: `HD-${r.number}`, subject: r.subject },
        createdAt: toDate(r.created_at).toISOString(),
        readAt: r.read_at ? toDate(r.read_at).toISOString() : null,
      })),
      unreadCount: Number(unread.rows[0]?.n ?? 0),
    };
  }

  @Post('read')
  @Roles('agent', 'lead')
  @HttpCode(200)
  @ApiOperation({ summary: 'Mark notifications as read (ids that are not yours are ignored)' })
  async read(
    @Req() req: Request,
    @Body(new ZodPipe(markReadSchema)) body: z.infer<typeof markReadSchema>,
  ): Promise<{ marked: number }> {
    const ids = sql.join(
      body.ids.map((i) => sql`${i}::uuid`),
      sql`, `,
    );
    const r = await this.db.db.execute(
      sql`UPDATE notifications SET read_at = now() WHERE user_id = ${user(req).id} AND read_at IS NULL AND id IN (${ids})`,
    );
    return { marked: r.rowCount ?? 0 };
  }
}
