import 'reflect-metadata';
import http from 'node:http';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { createDb, migrate, seed } from '@helpdesk/db';
import { json } from 'express';
import { loadEnv } from './env';
import { CoreModule } from './core';
import { apiRateLimit, csrfProtection, errorHandler, requestContext } from './http/middleware';
import type { AppState } from './http/types';
import { createRealtime } from './realtime/realtime';
import { startWorker } from './jobs/worker';
import { createStorage } from './attachments/storage';
import { createLimiter } from './lib/limiter';
import { createLogger } from './lib/logger';
import { buildOriginPolicy } from './lib/origins';

const bootstrap = async (): Promise<void> => {
  const env = loadEnv();
  const logger = createLogger(env.LOG_LEVEL);
  const state: AppState = { draining: false };

  const db = createDb(env.DATABASE_URL, {
    max: env.DB_POOL_MAX,
    connectionTimeoutMillis: env.DB_CONNECT_TIMEOUT_MS,
    statement_timeout: env.DB_STATEMENT_TIMEOUT_MS,
    idle_in_transaction_session_timeout: env.DB_STATEMENT_TIMEOUT_MS,
  });
  if (env.AUTO_MIGRATE) await migrate(db);
  if (env.AUTO_SEED) {
    const result = await seed(db, {
      ...(process.env.SEED_TICKETS ? { tickets: Number(process.env.SEED_TICKETS) } : {}),
      ...(process.env.SEED_CUSTOMERS ? { customers: Number(process.env.SEED_CUSTOMERS) } : {}),
    });
    logger.info(result.skipped ? 'seed skipped' : 'seeded', result.skipped ? {} : { ...result });
  }
  const limiter = createLimiter(db.db);
  const storage = createStorage(env.UPLOADS_DIR);
  await storage.ensure();
  const realtime = createRealtime({ db: db.db, databaseUrl: env.DATABASE_URL, logger });
  await realtime.start();

  const app = await NestFactory.create<NestExpressApplication>(
    CoreModule.register({ env, db, limiter, logger, state, storage, realtime }),
    {
      bodyParser: false,
      logger: env.LOG_LEVEL === 'debug' ? ['error', 'warn', 'log'] : ['error'],
      abortOnError: false,
    },
  );
  app.disable('x-powered-by');
  app.disable('etag');

  const origins = buildOriginPolicy(env.CORS_ORIGINS);
  app.use(requestContext({ trustedProxies: env.TRUSTED_PROXIES, logger, state }));
  app.use(apiRateLimit({ limiter, perMinute: env.RATE_LIMIT_API_PER_MIN }));
  app.enableCors({
    origin: (origin, cb) =>
      cb(null, origin === undefined ? false : origins.isAllowed(origin) ? origin : false),
    credentials: true,
    methods: ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE'],
    maxAge: 600,
  });
  app.use(csrfProtection(origins));
  app.use(json({ limit: env.BODY_LIMIT_BYTES, strict: true, type: 'application/json' }));

  const document = SwaggerModule.createDocument(
    app,
    new DocumentBuilder()
      .setTitle('Helpdesk API')
      .setVersion('1.0')
      .addCookieAuth(env.COOKIE_NAME)
      .build(),
  );
  SwaggerModule.setup('docs', app, document, { jsonDocumentUrl: 'docs-json' });

  await app.init();
  // after Nest's own routes: catches body-parser errors, bad URL encodings, anything else
  app.getHttpAdapter().getInstance().use(errorHandler(logger));

  // We own the HTTP server so we can set `connectionsCheckingInterval`: Node only enforces
  // headersTimeout/requestTimeout when it sweeps connections, and the default sweep is every 30 s —
  // a slowloris socket would outlive the configured timeout by up to 30 s.
  const server = http.createServer(
    {
      headersTimeout: env.HEADERS_TIMEOUT_MS, // slowloris on headers
      requestTimeout: env.REQUEST_TIMEOUT_MS, // slow bodies
      keepAliveTimeout: env.KEEP_ALIVE_TIMEOUT_MS,
      connectionsCheckingInterval: Math.max(
        100,
        Math.min(1_000, Math.floor(env.HEADERS_TIMEOUT_MS / 2)),
      ),
    },
    app.getHttpAdapter().getInstance(),
  );
  server.maxHeadersCount = 64;
  server.maxConnections = env.MAX_CONNECTIONS;
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(env.PORT, env.HOST, resolve);
  });
  logger.info('listening', { host: env.HOST, port: env.PORT });

  const worker = env.WORKER_ENABLED
    ? startWorker(
        { db: db.db, storage, logger, now: () => new Date() },
        { pollMs: env.JOB_POLL_MS, leaseSeconds: env.JOB_LEASE_SECONDS },
      )
    : undefined;

  // ---- graceful shutdown: stop accepting, let in-flight requests finish, exit 0 ----
  let shuttingDown = false;
  const shutdown = (signal: string): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    state.draining = true;
    logger.info('shutting down', { signal });
    const forced = setTimeout(() => {
      logger.error('shutdown timed out; closing remaining connections');
      server.closeAllConnections();
      process.exit(1);
    }, env.SHUTDOWN_TIMEOUT_MS);
    forced.unref();
    // end event streams first: they never finish on their own and would block server.close()
    void realtime.stop();
    server.close(() => {
      Promise.resolve(worker?.stop())
        .then(() => db.close())
        .then(
          () => process.exit(0),
          () => process.exit(0),
        );
    });
    server.closeIdleConnections();
    // idle keep-alive sockets that become idle while draining must not hold the process open
    const sweep = setInterval(() => server.closeIdleConnections(), 200);
    sweep.unref();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
};

bootstrap().catch((err: unknown) => {
  process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
