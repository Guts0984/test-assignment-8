import { Controller, Get, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Inject } from '@nestjs/common';
import type { DbHandle } from '@helpdesk/db';
import { statsQuerySchema, type Stats } from '@helpdesk/shared';
import { sql } from 'drizzle-orm';
import type { z } from 'zod';
import { Roles } from '../auth/decorators';
import { ZodPipe } from '../http/zod.pipe';
import { TOKENS } from '../tokens';

const num = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));

@ApiTags('stats')
@Controller('stats')
export class StatsController {
  constructor(@Inject(TOKENS.DB) private readonly db: DbHandle) {}

  @Get()
  @Roles('lead')
  @ApiOperation({
    summary:
      'Created/resolved, average first response and resolution time, SLA breach %, average rating, load per agent',
  })
  async stats(
    @Query(new ZodPipe(statsQuerySchema)) q: z.infer<typeof statsQuerySchema>,
  ): Promise<Stats> {
    const { from, to } = q;
    const db = this.db.db;
    const created = (
      await db.execute<{ total: number; breached: number; avg_first: number | null }>(sql`
        SELECT count(*)::int AS total,
               count(*) FILTER (WHERE first_response_breached_at IS NOT NULL OR resolution_breached_at IS NOT NULL)::int AS breached,
               avg(EXTRACT(EPOCH FROM (first_responded_at - created_at))) FILTER (WHERE first_responded_at IS NOT NULL)::float8 AS avg_first
        FROM tickets WHERE created_at >= ${from} AND created_at < ${to}`)
    ).rows[0];
    const resolved = (
      await db.execute<{ total: number; avg_res: number | null }>(sql`
        SELECT count(*)::int AS total, avg(EXTRACT(EPOCH FROM (resolved_at - created_at)))::float8 AS avg_res
        FROM tickets WHERE resolved_at >= ${from} AND resolved_at < ${to}`)
    ).rows[0];
    const rating = (
      await db.execute<{ avg: number | null; n: number }>(
        sql`SELECT avg(score)::float8 AS avg, count(*)::int AS n FROM ratings WHERE created_at >= ${from} AND created_at < ${to}`,
      )
    ).rows[0];
    const load = await db.execute<{
      id: string;
      name: string;
      active: number;
      resolved: number;
      breached: number;
    }>(sql`
      SELECT u.id, u.name,
             count(t.id) FILTER (WHERE t.status IN ('new', 'open', 'pending'))::int AS active,
             count(t.id) FILTER (WHERE t.resolved_at >= ${from} AND t.resolved_at < ${to})::int AS resolved,
             count(t.id) FILTER (WHERE t.first_response_breached_at IS NOT NULL OR t.resolution_breached_at IS NOT NULL)::int AS breached
      FROM users u LEFT JOIN tickets t ON t.assignee_id = u.id
      WHERE u.role = 'agent' AND u.disabled = false GROUP BY u.id, u.name ORDER BY u.name`);
    const total = Number(created?.total ?? 0);
    return {
      from: from,
      to: to,
      created: total,
      resolved: Number(resolved?.total ?? 0),
      avgFirstResponseSeconds: num(created?.avg_first),
      avgResolutionSeconds: num(resolved?.avg_res),
      slaBreachPercent:
        total === 0 ? null : Math.round((Number(created?.breached ?? 0) / total) * 1000) / 10,
      avgRating: num(rating?.avg),
      ratingCount: Number(rating?.n ?? 0),
      workload: load.rows.map((r) => ({
        agent: { id: r.id, name: r.name },
        active: Number(r.active),
        resolvedInPeriod: Number(r.resolved),
        breached: Number(r.breached),
      })),
    };
  }
}
