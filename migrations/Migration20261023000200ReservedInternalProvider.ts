import { Migration } from '@mikro-orm/migrations';

/**
 * The provider id "internal" belongs to system transactions (OPENING) only.
 * Without this rule a provider could submit under it and look up or collide
 * with the idempotency keys and external ids of internal transactions.
 */
export class Migration20261023000200ReservedInternalProvider extends Migration {
  override up(): void {
    this.addSql(`
      ALTER TABLE wager_transactions ADD CONSTRAINT wager_tx_internal_provider_ck
        CHECK ((provider_id = 'internal') = (channel = 'INTERNAL'));
    `);
  }

  override down(): void {
    this.addSql('ALTER TABLE wager_transactions DROP CONSTRAINT IF EXISTS wager_tx_internal_provider_ck;');
  }
}
