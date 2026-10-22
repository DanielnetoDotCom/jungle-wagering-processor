import type { SqlEntityManager } from '@mikro-orm/postgresql';

export interface SqlResult<Row> {
  rows: Row[];
  rowCount: number;
}

/**
 * Executes hand-written SQL inside the entity manager's current transaction.
 * Uses knex positional bindings (`?` -> `$n`), so values travel as protocol
 * level parameters and are never concatenated into the SQL text.
 * (MikroORM's `em.execute` inlines escaped values instead, hence this helper.)
 */
export async function sql<Row extends object>(
  em: SqlEntityManager,
  text: string,
  bindings: readonly unknown[] = [],
): Promise<SqlResult<Row>> {
  const query = em.getKnex().raw(text, bindings as never[]);
  const transaction: unknown = em.getTransactionContext();
  if (transaction) {
    query.transacting(transaction as never);
  }
  const result = (await query) as { rows?: Row[]; rowCount?: number | null };
  return { rows: result.rows ?? [], rowCount: result.rowCount ?? 0 };
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Avoids sending malformed ids to uuid columns (PostgreSQL would raise 22P02). */
export function isUuid(value: string): boolean {
  return UUID_PATTERN.test(value);
}
