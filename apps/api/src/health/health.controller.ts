import { Controller, Get, Inject } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { dbIsReachable, type DbHandle } from '@helpdesk/db';
import { TOKENS } from '../tokens';
import type { AppState } from '../http/types';
import { appError } from '../lib/errors';
import { Public } from '../auth/decorators';

const withTimeout = <T>(p: Promise<T>, ms: number, fallback: T): Promise<T> =>
  Promise.race([p, new Promise<T>((resolve) => setTimeout(() => resolve(fallback), ms).unref())]);

@ApiTags('health')
@Controller()
export class HealthController {
  constructor(
    @Inject(TOKENS.DB) private readonly db: DbHandle,
    @Inject(TOKENS.STATE) private readonly state: AppState,
  ) {}

  @Public()
  @Get('health')
  @ApiOperation({ summary: 'Liveness: the process is up (does not touch the database)' })
  health(): { status: 'ok' } {
    return { status: 'ok' };
  }

  @Public()
  @Get('ready')
  @ApiOperation({ summary: 'Readiness: database reachable and not shutting down' })
  async ready(): Promise<{ status: 'ready' }> {
    if (this.state.draining) throw appError(503, 'service_unavailable', 'Shutting down');
    if (!(await withTimeout(dbIsReachable(this.db), 2_000, false))) {
      throw appError(503, 'service_unavailable', 'Database unavailable');
    }
    return { status: 'ready' };
  }
}
