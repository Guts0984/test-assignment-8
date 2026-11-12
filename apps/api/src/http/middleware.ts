import { randomUUID } from 'node:crypto';
import type { ErrorRequestHandler, NextFunction, Request, RequestHandler, Response } from 'express';
import { buildTrustedProxies, limiterKeyForIp, resolveClientIp } from '../lib/client-ip';
import { csrfAllows, type OriginPolicy } from '../lib/origins';
import { createGate } from '../lib/gate';
import { mapError, tooManyRequests, type Mapped } from '../lib/errors';
import type { Limiter } from '../lib/limiter';
import type { Logger } from '../lib/logger';
import type { AppState } from './types';
import { appError } from '../lib/errors';

export const sendError = (res: Response, mapped: Mapped): void => {
  if (res.headersSent) {
    res.destroy();
    return;
  }
  for (const [k, v] of Object.entries(mapped.headers ?? {})) res.setHeader(k, v);
  res.status(mapped.status).json({ error: mapped.body });
};

const REQUEST_ID_RE = /^[A-Za-z0-9-]{8,64}$/;

/** Request id, client address, security headers, access log, `Connection: close` while draining. */
export const requestContext = (opts: {
  trustedProxies: readonly string[];
  logger: Logger;
  state: AppState;
}): RequestHandler => {
  const trusted = buildTrustedProxies(opts.trustedProxies);
  return (req, res, next) => {
    const started = process.hrtime.bigint();
    const incoming = req.get('x-request-id');
    req.requestId = incoming && REQUEST_ID_RE.test(incoming) ? incoming : randomUUID();
    req.clientIp = resolveClientIp(
      req.socket.remoteAddress,
      req.headers['x-forwarded-for'],
      trusted,
    );
    req.clientKey = limiterKeyForIp(req.clientIp);

    res.setHeader('X-Request-Id', req.requestId);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Cross-Origin-Resource-Policy', 'same-site');
    if (!req.path.startsWith('/docs')) {
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'");
    }
    if (opts.state.draining) res.setHeader('Connection', 'close');

    res.on('finish', () => {
      const ms = Number(process.hrtime.bigint() - started) / 1e6;
      opts.logger.info('request', {
        id: req.requestId,
        method: req.method,
        path: req.path, // no query string: it may carry search terms / tokens
        status: res.statusCode,
        ms: Math.round(ms * 10) / 10,
        ip: req.clientIp,
      });
    });
    next();
  };
};

/** Per-client quota for every route. In-process gate first (cheap reject), PostgreSQL second (authoritative). */
export const apiRateLimit = (opts: { limiter: Limiter; perMinute: number }): RequestHandler => {
  const gate = createGate(60_000);
  const reject = (res: Response, retryAfter: number, limit: number) => {
    res.setHeader('RateLimit-Limit', String(limit));
    res.setHeader('RateLimit-Remaining', '0');
    res.setHeader('RateLimit-Reset', String(retryAfter));
    sendError(res, mapError(tooManyRequests(retryAfter), res.req.requestId));
  };
  return (req, res, next) => {
    const local = gate.hit(req.clientKey);
    if (local > opts.perMinute) return reject(res, 60, opts.perMinute);
    // liveness must not depend on the database
    if (req.path === '/health') return next();
    opts.limiter.hit(`api:${req.clientKey}`, opts.perMinute, 60).then(
      (r) => {
        res.setHeader('RateLimit-Limit', String(r.limit));
        res.setHeader('RateLimit-Remaining', String(r.remaining));
        res.setHeader('RateLimit-Reset', String(r.retryAfterSeconds));
        if (!r.allowed) return reject(res, r.retryAfterSeconds, r.limit);
        next();
      },
      (err: unknown) => next(err),
    );
  };
};

/** Blocks cross-site state-changing requests (see csrfAllows for the exact rules). */
export const csrfProtection =
  (policy: OriginPolicy): RequestHandler =>
  (req, res, next) => {
    const ok = csrfAllows(
      req.method,
      { origin: req.get('origin'), secFetchSite: req.get('sec-fetch-site') },
      policy,
    );
    if (ok) return next();
    sendError(
      res,
      mapError(appError(403, 'forbidden', 'Cross-site request blocked'), req.requestId),
    );
  };

/** Last-resort Express error handler: body-parser failures, bad URLs and anything Nest filters did not see. */
export const errorHandler =
  (logger: Logger): ErrorRequestHandler =>
  (err: unknown, req: Request, res: Response, _next: NextFunction) => {
    const mapped = mapError(err, req.requestId);
    if (mapped.status >= 500) {
      logger.error('unhandled error', {
        id: req.requestId,
        path: req.path,
        err:
          err instanceof Error
            ? { name: err.name, message: err.message, stack: err.stack }
            : String(err),
      });
    }
    sendError(res, mapped);
  };
