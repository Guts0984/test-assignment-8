import { Injectable, type PipeTransform } from '@nestjs/common';
import type { ZodType } from 'zod';

/** Validates AND transforms input with a Zod schema from packages/shared. Failure → ZodError → 400 envelope. */
@Injectable()
export class ZodPipe<T> implements PipeTransform<unknown, T> {
  constructor(private readonly schema: ZodType<T>) {}
  transform(value: unknown): T {
    return this.schema.parse(value);
  }
}
