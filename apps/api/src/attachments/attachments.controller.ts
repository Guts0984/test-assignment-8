import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { Controller, Get, HttpCode, Inject, Param, Post, Req, Res } from '@nestjs/common';
import { ApiConsumes, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { DbHandle } from '@helpdesk/db';
import { LIMITS, uuidSchema, type AttachmentDto } from '@helpdesk/shared';
import { sql } from 'drizzle-orm';
import type { Request, Response } from 'express';
import { ZodPipe } from '../http/zod.pipe';
import { appError, tooManyRequests } from '../lib/errors';
import type { Env } from '../env';
import type { Limiter } from '../lib/limiter';
import { Busy, type createSemaphore } from '../lib/semaphore';
import type { SessionUser } from '../lib/sessions';
import { fetchTicket } from '../tickets/mutate';
import { isStaff } from '../tickets/model';
import { TOKENS } from '../tokens';
import { readSingleFile } from './multipart';
import { contentDisposition, nameForMime, sanitizeFilename, sniffMime } from './sniff';
import type { Storage } from './storage';

const user = (req: Request): SessionUser => {
  if (!req.auth) throw new Error('auth guard did not run');
  return req.auth.user;
};

type AttachmentRow = {
  id: string;
  uploader_id: string;
  message_id: string | null;
  original_name: string;
  mime: string;
  size_bytes: number;
  storage_key: string;
  ticket_id: string | null;
  kind: 'public' | 'internal' | null;
};

@ApiTags('attachments')
@Controller('attachments')
export class AttachmentsController {
  constructor(
    @Inject(TOKENS.DB) private readonly db: DbHandle,
    @Inject(TOKENS.ENV) private readonly env: Env,
    @Inject(TOKENS.LIMITER) private readonly limiter: Limiter,
    @Inject(TOKENS.STORAGE) private readonly storage: Storage,
    @Inject(TOKENS.UPLOAD_GATE) private readonly gate: ReturnType<typeof createSemaphore>,
  ) {}

  @Post()
  @HttpCode(201)
  @ApiConsumes('multipart/form-data')
  @ApiOperation({
    summary:
      'Upload one file (multipart field "file"; ≤ 10 MB; png/jpeg/gif/webp/pdf/text by CONTENT). Attach it by id when sending a message.',
  })
  async upload(@Req() req: Request): Promise<AttachmentDto> {
    const u = user(req);
    const quota = await this.limiter.hit(`upload:${u.id}`, this.env.UPLOAD_PER_MIN, 60);
    if (!quota.allowed) throw tooManyRequests(quota.retryAfterSeconds, 'Too many uploads');
    const pending = await this.db.db.execute<{ n: number }>(
      sql`SELECT count(*)::int AS n FROM attachments WHERE uploader_id = ${u.id} AND message_id IS NULL`,
    );
    if (Number(pending.rows[0]?.n ?? 0) >= this.env.UPLOAD_MAX_PENDING) {
      throw appError(
        429,
        'rate_limited',
        'Too many unsent attachments; send or wait for them to expire',
      );
    }

    try {
      return await this.gate.run(async () => {
        const { filename, bytes } = await readSingleFile(req, LIMITS.attachmentMaxBytes);
        const mime = sniffMime(bytes);
        if (!mime)
          throw appError(
            415,
            'unsupported_media_type',
            'Only images, PDF and plain-text files are allowed',
          );
        const name = nameForMime(sanitizeFilename(filename), mime);
        if (!name)
          throw appError(
            415,
            'unsupported_media_type',
            'The file extension does not match the file content',
          );
        const key = await this.storage.save(bytes);
        try {
          const ins = await this.db.db.execute<{ id: string }>(sql`
            INSERT INTO attachments (uploader_id, original_name, mime, size_bytes, storage_key, sha256)
            VALUES (${u.id}, ${name}, ${mime}, ${bytes.length}, ${key}, ${createHash('sha256').update(bytes).digest('hex')})
            RETURNING id`);
          return { id: ins.rows[0]?.id ?? '', name, mime, sizeBytes: bytes.length };
        } catch (err) {
          await this.storage.remove(key); // no orphan file when the row could not be written
          throw err;
        }
      });
    } catch (err) {
      if (err instanceof Busy) throw tooManyRequests(1, 'Server is busy, retry shortly');
      if ((err as NodeJS.ErrnoException).code === 'ENOSPC')
        throw appError(503, 'service_unavailable', 'Storage is full');
      throw err;
    }
  }

  @Get(':id')
  @ApiOperation({
    summary:
      'Download. Allowed only with access to the ticket (and not for notes if you are a customer); unsent files only for their uploader.',
  })
  async download(
    @Req() req: Request,
    @Res() res: Response,
    @Param('id', new ZodPipe(uuidSchema)) id: string,
  ): Promise<void> {
    const u = user(req);
    const row = (
      await this.db.db.execute<AttachmentRow>(sql`
        SELECT a.id, a.uploader_id, a.message_id, a.original_name, a.mime, a.size_bytes, a.storage_key, m.ticket_id, m.kind
        FROM attachments a LEFT JOIN messages m ON m.id = a.message_id
        WHERE a.id = ${id}`)
    ).rows[0];
    const allowed = row
      ? row.message_id === null
        ? row.uploader_id === u.id // not sent yet: only the uploader
        : row.ticket_id !== null &&
          (row.kind === 'public' || isStaff(u.role)) &&
          (await fetchTicket(this.db.db, u, row.ticket_id)) !== undefined
      : false;
    if (!row || !allowed) throw appError(404, 'not_found', 'Attachment not found'); // same answer for "missing" and "not yours"

    const size = await this.storage.size(row.storage_key);
    if (size === null) throw appError(404, 'not_found', 'Attachment not found');
    const inline = row.mime.startsWith('image/');
    res.status(200);
    res.setHeader(
      'Content-Type',
      row.mime === 'text/plain' ? 'text/plain; charset=utf-8' : row.mime,
    );
    res.setHeader('Content-Length', String(size));
    res.setHeader(
      'Content-Disposition',
      contentDisposition(inline ? 'inline' : 'attachment', row.original_name),
    );
    res.setHeader('Cache-Control', 'private, no-store');
    res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
    await new Promise<void>((resolve) => {
      const stream = createReadStream(this.storage.path(row.storage_key));
      stream.on('error', () => {
        if (!res.headersSent) res.status(404);
        res.destroy();
        resolve();
      });
      res.on('close', () => {
        stream.destroy();
        resolve();
      });
      stream.pipe(res);
    });
  }
}
