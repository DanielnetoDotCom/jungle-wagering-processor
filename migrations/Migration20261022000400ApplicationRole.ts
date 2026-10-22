import { Migration } from '@mikro-orm/migrations';

const TABLES = 'wallets, wager_transactions, wallet_ledger_entries, inbox_messages, outbox_messages';

/**
 * Least privilege for the runtime: services connect with a login role that is
 * a member of `wagering_app`, which can never UPDATE/DELETE/TRUNCATE the
 * ledger nor DELETE/TRUNCATE financial rows. Migrations run as the schema
 * owner. The group role is cluster-wide and therefore not dropped on `down`.
 */
export class Migration20261022000400ApplicationRole extends Migration {
  override up(): void {
    this.addSql(`
      DO $$
      BEGIN
        CREATE ROLE wagering_app NOLOGIN;
      EXCEPTION
        WHEN duplicate_object OR unique_violation THEN NULL;
      END
      $$;
    `);
    this.addSql(`REVOKE ALL ON ${TABLES} FROM PUBLIC;`);
    this.addSql('GRANT USAGE ON SCHEMA public TO wagering_app;');
    this.addSql(
      'GRANT SELECT, INSERT, UPDATE ON wallets, wager_transactions, inbox_messages, outbox_messages TO wagering_app;',
    );
    this.addSql('GRANT SELECT, INSERT ON wallet_ledger_entries TO wagering_app;');
    this.addSql('GRANT USAGE ON ALL SEQUENCES IN SCHEMA public TO wagering_app;');
  }

  override down(): void {
    this.addSql(`REVOKE ALL ON ${TABLES} FROM wagering_app;`);
    this.addSql('REVOKE USAGE ON ALL SEQUENCES IN SCHEMA public FROM wagering_app;');
    this.addSql('REVOKE USAGE ON SCHEMA public FROM wagering_app;');
  }
}
