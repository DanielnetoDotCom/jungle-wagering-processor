import type { z } from 'zod';
import { RequestValidationError } from '../../application/errors/application-errors';

/** Parses `value` or throws a RequestValidationError listing every issue (path + reason, never the value). */
export function parseOrThrow<Schema extends z.ZodType>(
  schema: Schema,
  value: unknown,
  what: string,
): z.infer<Schema> {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw new RequestValidationError(
      `Invalid ${what}`,
      result.error.issues.map((issue) => ({
        path: issue.path.map(String).join('.') || '(root)',
        message: issue.message,
      })),
    );
  }
  return result.data;
}
