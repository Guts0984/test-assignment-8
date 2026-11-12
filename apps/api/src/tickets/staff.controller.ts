import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Inject,
  Param,
  Post,
  Put,
  Req,
  Res,
} from '@nestjs/common';
import { ApiBody, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { DbHandle } from '@helpdesk/db';
import {
  cannedResponseSchema,
  savedViewSchema,
  slaSettingsSchema,
  unknownPlaceholders,
  uuidSchema,
  type AgentDto,
  type CannedResponseDto,
  type CannedResponseInput,
  type Category,
} from '@helpdesk/shared';
import { sql } from 'drizzle-orm';
import type { Request, Response } from 'express';
import { z } from 'zod';
import { Roles } from '../auth/decorators';
import { jsonSchemaOf } from '../http/swagger';
import { ZodPipe } from '../http/zod.pipe';
import { appError } from '../lib/errors';
import type { SessionUser } from '../lib/sessions';
import { TOKENS } from '../tokens';
import { toDate } from './model';

const uuidParam = new ZodPipe(uuidSchema);
const user = (req: Request): SessionUser => {
  if (!req.auth) throw new Error('auth guard did not run');
  return req.auth.user;
};

type CannedRow = {
  id: string;
  title: string;
  body: string;
  category: Category | null;
  updated_at: Date | string;
};
const toCanned = (r: CannedRow): CannedResponseDto => ({
  id: r.id,
  title: r.title,
  body: r.body,
  category: r.category,
  updatedAt: toDate(r.updated_at).toISOString(),
});
const checkTemplate = (body: CannedResponseInput): void => {
  const bad = unknownPlaceholders(body.body);
  if (bad.length)
    throw appError(400, 'validation_error', `Unknown placeholders: ${bad.join(', ')}`);
};

@ApiTags('canned-responses')
@Controller('canned-responses')
export class CannedController {
  constructor(@Inject(TOKENS.DB) private readonly db: DbHandle) {}

  @Get()
  @Roles('agent', 'lead')
  @ApiOperation({ summary: 'Reply templates ({{customer_name}}, {{ticket_number}})' })
  async list(): Promise<CannedResponseDto[]> {
    const r = await this.db.db.execute<CannedRow>(
      sql`SELECT id, title, body, category, updated_at FROM canned_responses ORDER BY title, id`,
    );
    return r.rows.map(toCanned);
  }

  @Post()
  @Roles('lead')
  @ApiBody({ schema: jsonSchemaOf(cannedResponseSchema) })
  async create(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
    @Body(new ZodPipe(cannedResponseSchema)) body: CannedResponseInput,
  ): Promise<CannedResponseDto> {
    checkTemplate(body);
    const r = await this.db.db.execute<CannedRow>(sql`
      INSERT INTO canned_responses (title, body, category, created_by) VALUES (${body.title}, ${body.body}, ${body.category}, ${user(req).id})
      RETURNING id, title, body, category, updated_at`);
    res.status(201);
    return toCanned(r.rows[0] as CannedRow);
  }

  @Put(':id')
  @Roles('lead')
  @ApiBody({ schema: jsonSchemaOf(cannedResponseSchema) })
  async update(
    @Param('id', uuidParam) id: string,
    @Body(new ZodPipe(cannedResponseSchema)) body: CannedResponseInput,
  ): Promise<CannedResponseDto> {
    checkTemplate(body);
    const r = await this.db.db.execute<CannedRow>(sql`
      UPDATE canned_responses SET title = ${body.title}, body = ${body.body}, category = ${body.category}, updated_at = now()
      WHERE id = ${id} RETURNING id, title, body, category, updated_at`);
    if (!r.rows[0]) throw appError(404, 'not_found', 'Template not found');
    return toCanned(r.rows[0]);
  }

  @Delete(':id')
  @Roles('lead')
  @HttpCode(204)
  async remove(@Param('id', uuidParam) id: string): Promise<void> {
    const r = await this.db.db.execute(sql`DELETE FROM canned_responses WHERE id = ${id}`);
    if ((r.rowCount ?? 0) === 0) throw appError(404, 'not_found', 'Template not found');
  }
}

@ApiTags('saved-views')
@Controller('saved-views')
export class SavedViewsController {
  constructor(@Inject(TOKENS.DB) private readonly db: DbHandle) {}

  @Get()
  @Roles('agent', 'lead')
  async list(@Req() req: Request) {
    const r = await this.db.db.execute<{ id: string; name: string; query: unknown }>(
      sql`SELECT id, name, query FROM saved_views WHERE user_id = ${user(req).id} ORDER BY name`,
    );
    return r.rows;
  }

  @Post()
  @Roles('agent', 'lead')
  @ApiBody({ schema: jsonSchemaOf(savedViewSchema) })
  async create(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
    @Body(new ZodPipe(savedViewSchema)) body: z.infer<typeof savedViewSchema>,
  ) {
    const r = await this.db.db.execute<{ id: string; name: string; query: unknown }>(sql`
      INSERT INTO saved_views (user_id, name, query) VALUES (${user(req).id}, ${body.name}, ${JSON.stringify(body.query)}::jsonb)
      RETURNING id, name, query`); // duplicate name → unique violation → 409
    res.status(201);
    return r.rows[0];
  }

  @Delete(':id')
  @Roles('agent', 'lead')
  @HttpCode(204)
  async remove(@Req() req: Request, @Param('id', uuidParam) id: string): Promise<void> {
    const r = await this.db.db.execute(
      sql`DELETE FROM saved_views WHERE id = ${id} AND user_id = ${user(req).id}`,
    );
    if ((r.rowCount ?? 0) === 0) throw appError(404, 'not_found', 'View not found');
  }
}

@ApiTags('sla')
@Controller('sla')
export class SlaController {
  constructor(@Inject(TOKENS.DB) private readonly db: DbHandle) {}

  @Get()
  @Roles('agent', 'lead')
  @ApiOperation({ summary: 'SLA policy per priority' })
  async get() {
    const r = await this.db.db.execute<{
      priority: string;
      first_response_minutes: number;
      resolution_minutes: number;
      business_hours: boolean;
    }>(
      sql`SELECT priority, first_response_minutes, resolution_minutes, business_hours FROM sla_policies ORDER BY priority DESC`,
    );
    return {
      policies: r.rows.map((p) => ({
        priority: p.priority,
        firstResponseMinutes: p.first_response_minutes,
        resolutionMinutes: p.resolution_minutes,
        businessHours: p.business_hours,
      })),
    };
  }

  @Put()
  @Roles('lead')
  @ApiOperation({ summary: 'Set SLA deadlines (applies to new tickets and to priority changes)' })
  @ApiBody({ schema: jsonSchemaOf(slaSettingsSchema) })
  async put(
    @Req() req: Request,
    @Body(new ZodPipe(slaSettingsSchema)) body: z.infer<typeof slaSettingsSchema>,
  ) {
    await this.db.db.transaction(async (tx) => {
      for (const p of body.policies) {
        await tx.execute(sql`
          UPDATE sla_policies SET first_response_minutes = ${p.firstResponseMinutes}, resolution_minutes = ${p.resolutionMinutes},
                 business_hours = ${p.businessHours}, updated_by = ${user(req).id}, updated_at = now()
          WHERE priority = ${p.priority}`);
      }
    });
    return this.get();
  }
}

@ApiTags('agents')
@Controller('agents')
export class AgentsController {
  constructor(@Inject(TOKENS.DB) private readonly db: DbHandle) {}

  @Get()
  @Roles('agent', 'lead')
  @ApiOperation({ summary: 'Active agents and their categories (assignee picker)' })
  async list(): Promise<AgentDto[]> {
    const r = await this.db.db.execute<{
      id: string;
      name: string;
      categories: Category[] | null;
    }>(sql`
      SELECT u.id, u.name, (SELECT array_agg(ac.category ORDER BY ac.category) FROM agent_categories ac WHERE ac.user_id = u.id) AS categories
      FROM users u WHERE u.role = 'agent' AND u.disabled = false ORDER BY u.name`);
    return r.rows.map((a) => ({ id: a.id, name: a.name, categories: a.categories ?? [] }));
  }
}
