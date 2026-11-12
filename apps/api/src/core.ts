import { Global, Module, type DynamicModule } from '@nestjs/common';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import type { DbHandle } from '@helpdesk/db';
import type { Env } from './env';
import type { AppState } from './http/types';
import { AllExceptionsFilter } from './http/exceptions.filter';
import type { Limiter } from './lib/limiter';
import type { Logger } from './lib/logger';
import { TOKENS } from './tokens';
import { createSemaphore } from './lib/semaphore';
import { AuthGuard } from './auth/auth.guard';
import { AuthController } from './auth/auth.controller';
import { HealthController } from './health/health.controller';
import { AttachmentsController } from './attachments/attachments.controller';
import type { Storage } from './attachments/storage';
import { NotificationsController } from './notifications/notifications.controller';
import { RealtimeController } from './realtime/realtime.controller';
import type { Realtime } from './realtime/realtime';
import { StatsController } from './stats/stats.controller';
import { TicketsController } from './tickets/tickets.controller';
import {
  AgentsController,
  CannedController,
  SavedViewsController,
  SlaController,
} from './tickets/staff.controller';

export type AppDeps = {
  env: Env;
  db: DbHandle;
  limiter: Limiter;
  logger: Logger;
  state: AppState;
  storage: Storage;
  realtime: Realtime;
};

@Global()
@Module({})
export class CoreModule {
  static register(deps: AppDeps): DynamicModule {
    return {
      module: CoreModule,
      controllers: [
        HealthController,
        AuthController,
        AttachmentsController,
        RealtimeController,
        NotificationsController,
        StatsController,
        TicketsController,
        CannedController,
        SavedViewsController,
        SlaController,
        AgentsController,
      ],
      providers: [
        { provide: TOKENS.ENV, useValue: deps.env },
        { provide: TOKENS.DB, useValue: deps.db },
        { provide: TOKENS.LIMITER, useValue: deps.limiter },
        { provide: TOKENS.LOGGER, useValue: deps.logger },
        { provide: TOKENS.STATE, useValue: deps.state },
        { provide: TOKENS.STORAGE, useValue: deps.storage },
        { provide: TOKENS.REALTIME, useValue: deps.realtime },
        { provide: TOKENS.UPLOAD_GATE, useValue: createSemaphore(deps.env.UPLOAD_CONCURRENCY, 16) },
        {
          provide: TOKENS.LOGIN_GATE,
          useValue: createSemaphore(deps.env.LOGIN_MAX_CONCURRENCY, deps.env.LOGIN_QUEUE_MAX),
        },
        { provide: APP_GUARD, useClass: AuthGuard },
        { provide: APP_FILTER, useValue: new AllExceptionsFilter(deps.logger) },
      ],
      exports: [TOKENS.ENV, TOKENS.DB, TOKENS.LIMITER, TOKENS.LOGGER, TOKENS.STATE],
    };
  }
}
