import { Catch, type ArgumentsHost, type ExceptionFilter } from '@nestjs/common';
import type { Request, Response } from 'express';
import { mapError } from '../lib/errors';
import type { Logger } from '../lib/logger';
import { sendError } from './middleware';

@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  constructor(private readonly logger: Logger) {}
  catch(exception: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    const req = http.getRequest<Request>();
    const res = http.getResponse<Response>();
    const mapped = mapError(exception, req.requestId);
    if (mapped.status >= 500) {
      this.logger.error('request failed', {
        id: req.requestId,
        method: req.method,
        path: req.path,
        err:
          exception instanceof Error
            ? { name: exception.name, message: exception.message, stack: exception.stack }
            : String(exception),
      });
    }
    sendError(res, mapped);
  }
}
