import { Migration } from '@mikro-orm/migrations';

/** Adds protection to existing deployments without rewriting financial history. */
export class Migration20261022000500FinancialIntegrity extends Migration {
  override up(): void {
    this.addSql(`
      ALTER TABLE wallets ADD CONSTRAINT wallets_balance_finite_ck
        CHECK (balance_amount BETWEEN -999999999999999999.99 AND 999999999999999999.99);
      ALTER TABLE wager_transactions ADD CONSTRAINT wager_tx_money_finite_ck
        CHECK (amount BETWEEN -999999999999999999.99 AND 999999999999999999.99
          AND (result_balance_amount IS NULL OR result_balance_amount BETWEEN -999999999999999999.99 AND 999999999999999999.99));
      ALTER TABLE wallet_ledger_entries ADD CONSTRAINT ledger_money_finite_ck
        CHECK (amount BETWEEN -999999999999999999.99 AND 999999999999999999.99
          AND balance_before BETWEEN -999999999999999999.99 AND 999999999999999999.99
          AND balance_after BETWEEN -999999999999999999.99 AND 999999999999999999.99);
    `);

    // Do not silently bless corruption left by an older schema. Constraints
    // above validate existing finite values; this check validates the chain.
    this.addSql(`
      DO $$ BEGIN
        IF EXISTS (
          SELECT 1 FROM (
            SELECT wallet_version, balance_before,
                   lag(wallet_version) OVER w AS prev_version,
                   lag(balance_after) OVER w AS prev_after
              FROM wallet_ledger_entries
              WINDOW w AS (PARTITION BY wallet_id ORDER BY wallet_version)
          ) c WHERE (prev_version IS NULL AND (wallet_version NOT IN (1, 2) OR balance_before <> 0))
                 OR (prev_version IS NOT NULL AND (wallet_version <> prev_version + 1 OR balance_before <> prev_after))
        ) OR EXISTS (
          SELECT 1 FROM wallet_ledger_entries e JOIN wager_transactions t ON t.id = e.transaction_id
          WHERE (e.wallet_version = 1) IS DISTINCT FROM (t.kind = 'OPENING')
        ) OR EXISTS (
          SELECT 1 FROM wallets w LEFT JOIN LATERAL (
            SELECT wallet_version, balance_after FROM wallet_ledger_entries
             WHERE wallet_id = w.id ORDER BY wallet_version DESC LIMIT 1
          ) tail ON true
          WHERE w.version <> coalesce(tail.wallet_version, 1)
             OR w.balance_amount <> coalesce(tail.balance_after, 0)
        ) THEN
          RAISE EXCEPTION 'Existing wallet/ledger divergence: investigate before applying the migration'
            USING ERRCODE = 'check_violation', CONSTRAINT = 'ledger_existing_history';
        END IF;
      END $$;
    `);

    this.addSql(`
      CREATE FUNCTION wallet_ledger_entries_validate_position() RETURNS trigger LANGUAGE plpgsql AS $$
      DECLARE
        wallet_state RECORD;
        successor RECORD;
        tail RECORD;
        transaction_kind varchar(16);
      BEGIN
        -- Also serialize direct SQL writers. Locking only in the application
        -- would not protect a deferred cross-row check against concurrent inserts.
        SELECT version, balance_amount INTO wallet_state FROM wallets WHERE id = NEW.wallet_id FOR UPDATE;
        IF NOT FOUND THEN
          RAISE EXCEPTION 'Ledger wallet does not exist'
            USING ERRCODE = 'check_violation', CONSTRAINT = 'ledger_entry_has_balance_change';
        END IF;

        SELECT wallet_version, balance_before INTO successor FROM wallet_ledger_entries
         WHERE wallet_id = NEW.wallet_id AND wallet_version > NEW.wallet_version
         ORDER BY wallet_version LIMIT 1;
        IF FOUND AND (successor.wallet_version <> NEW.wallet_version + 1 OR successor.balance_before <> NEW.balance_after) THEN
          RAISE EXCEPTION 'Ledger insertion breaks the existing successor'
            USING ERRCODE = 'check_violation', CONSTRAINT = 'ledger_chain_successor';
        END IF;

        IF NOT EXISTS (SELECT 1 FROM wallet_ledger_entries WHERE wallet_id = NEW.wallet_id AND wallet_version < NEW.wallet_version)
           AND NEW.wallet_version NOT IN (1, 2) THEN
          RAISE EXCEPTION 'First ledger version must be 1 (opening) or 2 (zero opening)'
            USING ERRCODE = 'check_violation', CONSTRAINT = 'ledger_initial_version';
        END IF;
        SELECT kind INTO transaction_kind FROM wager_transactions WHERE id = NEW.transaction_id;
        IF (NEW.wallet_version = 1) IS DISTINCT FROM (transaction_kind = 'OPENING') THEN
          RAISE EXCEPTION 'Only the opening transaction may use ledger version 1'
            USING ERRCODE = 'check_violation', CONSTRAINT = 'ledger_opening_version';
        END IF;

        -- Check the final state, not equality of NEW.version with wallet.version:
        -- several legitimate movements may be committed in the same SQL transaction.
        SELECT wallet_version, balance_after INTO tail FROM wallet_ledger_entries
         WHERE wallet_id = NEW.wallet_id ORDER BY wallet_version DESC LIMIT 1;
        IF tail.wallet_version <> wallet_state.version OR tail.balance_after <> wallet_state.balance_amount THEN
          RAISE EXCEPTION 'Ledger tail does not match the materialized wallet'
            USING ERRCODE = 'check_violation', CONSTRAINT = 'ledger_tail_matches_wallet';
        END IF;
        RETURN NULL;
      END $$;
      CREATE CONSTRAINT TRIGGER wallet_ledger_entries_validate_position
        AFTER INSERT ON wallet_ledger_entries DEFERRABLE INITIALLY DEFERRED
        FOR EACH ROW EXECUTE FUNCTION wallet_ledger_entries_validate_position();
    `);
  }

  override down(): void {
    this.addSql('DROP TRIGGER wallet_ledger_entries_validate_position ON wallet_ledger_entries;');
    this.addSql('DROP FUNCTION wallet_ledger_entries_validate_position();');
    this.addSql('ALTER TABLE wallet_ledger_entries DROP CONSTRAINT ledger_money_finite_ck;');
    this.addSql('ALTER TABLE wager_transactions DROP CONSTRAINT wager_tx_money_finite_ck;');
    this.addSql('ALTER TABLE wallets DROP CONSTRAINT wallets_balance_finite_ck;');
  }
}
