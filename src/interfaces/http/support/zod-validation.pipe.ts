import type { PipeTransform } from '@nestjs/common';
import type { z } from 'zod';
import { parseOrThrow } from '../../contracts/validation';

export class ZodValidationPipe<Schema extends z.ZodType> implements PipeTransform<unknown, z.infer<Schema>> {
  constructor(
    private readonly schema: Schema,
    private readonly what: string,
  ) {}

  transform(value: unknown): z.infer<Schema> {
    return parseOrThrow(this.schema, value, this.what);
  }
}
