import type { MigrationObject } from '@mikro-orm/core';
import { Migration20261022000100CoreSchema } from './Migration20261022000100CoreSchema';
import { Migration20261022000200MessagingTables } from './Migration20261022000200MessagingTables';
import { Migration20261022000300IntegrityTriggers } from './Migration20261022000300IntegrityTriggers';
import { Migration20261022000400ApplicationRole } from './Migration20261022000400ApplicationRole';
import { Migration20261022000500FinancialIntegrity } from './Migration20261022000500FinancialIntegrity';
import { Migration20261023000100InboxAttempts } from './Migration20261023000100InboxAttempts';

/**
 * Explicit, ordered migration list (no filesystem discovery): identical in
 * `bun` (TypeScript sources) and in the compiled production image.
 */
export const MIGRATIONS: MigrationObject[] = [
  { name: 'Migration20261022000100CoreSchema', class: Migration20261022000100CoreSchema },
  { name: 'Migration20261022000200MessagingTables', class: Migration20261022000200MessagingTables },
  { name: 'Migration20261022000300IntegrityTriggers', class: Migration20261022000300IntegrityTriggers },
  { name: 'Migration20261022000400ApplicationRole', class: Migration20261022000400ApplicationRole },
  { name: 'Migration20261022000500FinancialIntegrity', class: Migration20261022000500FinancialIntegrity },
  { name: 'Migration20261023000100InboxAttempts', class: Migration20261023000100InboxAttempts },
];
