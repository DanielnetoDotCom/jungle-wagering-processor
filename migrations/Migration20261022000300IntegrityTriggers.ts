import { Migration } from '@mikro-orm/migrations';

/**
 * Rules that a CHECK constraint cannot express because they compare rows:
 *
 *  - ledger is append-only (no UPDATE / DELETE / TRUNCATE);
 *  - each ledger line continues the previous one (balance_before = previous
 *    balance_after, contiguous versions, first line starts at zero);
 *  - each ledger line belongs to a PROCESSED transaction with the direction
 *    implied by its kind (BET debits, WIN/REFUND/OPENING credit, ROLLBACK
 *    inverts its reference, LOSS never moves money), and every PROCESSED
 *    transaction that moves money has its ledger line at COMMIT;
 *  - a wallet's version changes iff its balance changes (+1 exactly), and the
 *    new (version, balance) must have a ledger line: checked at COMMIT by a
 *    deferred constraint trigger, so a balance can never change without its
 *    ledger line and vice versa;
 *  - terminal wager transactions are immutable; identity/amount columns never
 *    change; references are validated against the referenced row;
 *  - processed inbox rows and published outbox rows are immutable.
 *
 * Errors carry SQLSTATE 23514/23000 plus a CONSTRAINT name so the application
 * classifies them as integrity violations (never retried).
 * These rules hold for every connection; only a superuser disabling triggers
 * (session_replication_role) can bypass them, which reconciliation detects.
 */
export class Migration20261022000300IntegrityTriggers extends Migration {
  override up(): void {
    this.addSql(`
      CREATE FUNCTION wagering_reject_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        RAISE EXCEPTION '% on % is not allowed', TG_OP, TG_TABLE_NAME
          USING ERRCODE = 'integrity_constraint_violation', CONSTRAINT = TG_ARGV[0];
      END;
      $$;
    `);

    // ---- ledger -------------------------------------------------------------
    this.addSql(`
      CREATE TRIGGER wallet_ledger_entries_append_only
        BEFORE UPDATE OR DELETE ON wallet_ledger_entries
        FOR EACH ROW EXECUTE FUNCTION wagering_reject_mutation('wallet_ledger_entries_append_only');
    `);
    this.addSql(`
      CREATE TRIGGER wallet_ledger_entries_no_truncate
        BEFORE TRUNCATE ON wallet_ledger_entries
        FOR EACH STATEMENT EXECUTE FUNCTION wagering_reject_mutation('wallet_ledger_entries_append_only');
    `);
    this.addSql(`
      CREATE FUNCTION wallet_ledger_entries_validate() RETURNS trigger LANGUAGE plpgsql AS $$
      DECLARE
        previous_entry RECORD;
        settled RECORD;
        reference_kind varchar(16);
        expected_direction varchar(6);
        current_version integer;
      BEGIN
        SELECT balance_after, wallet_version INTO previous_entry
          FROM wallet_ledger_entries
         WHERE wallet_id = NEW.wallet_id AND wallet_version < NEW.wallet_version
         ORDER BY wallet_version DESC
         LIMIT 1;
        IF FOUND THEN
          IF previous_entry.wallet_version <> NEW.wallet_version - 1 OR previous_entry.balance_after <> NEW.balance_before THEN
            RAISE EXCEPTION 'ledger chain broken for wallet %: version % does not continue version %',
              NEW.wallet_id, NEW.wallet_version, previous_entry.wallet_version
              USING ERRCODE = 'check_violation', CONSTRAINT = 'ledger_chain_continuity';
          END IF;
        ELSIF NEW.balance_before <> 0 THEN
          RAISE EXCEPTION 'first ledger entry of wallet % must start from a zero balance', NEW.wallet_id
            USING ERRCODE = 'check_violation', CONSTRAINT = 'ledger_chain_continuity';
        END IF;

        SELECT version INTO current_version FROM wallets WHERE id = NEW.wallet_id;
        IF current_version IS NULL OR current_version < NEW.wallet_version THEN
          RAISE EXCEPTION 'ledger entry % has no matching wallet balance change', NEW.id
            USING ERRCODE = 'check_violation', CONSTRAINT = 'ledger_entry_has_balance_change';
        END IF;

        SELECT kind, status, reference_transaction_id INTO settled
          FROM wager_transactions WHERE id = NEW.transaction_id;
        IF NOT FOUND OR settled.status <> 'PROCESSED' THEN
          RAISE EXCEPTION 'ledger entry % requires a PROCESSED transaction', NEW.id
            USING ERRCODE = 'check_violation', CONSTRAINT = 'ledger_requires_processed_transaction';
        END IF;

        IF settled.kind = 'BET' THEN
          expected_direction := 'DEBIT';
        ELSIF settled.kind IN ('OPENING', 'WIN', 'REFUND') THEN
          expected_direction := 'CREDIT';
        ELSIF settled.kind = 'ROLLBACK' THEN
          SELECT kind INTO reference_kind FROM wager_transactions WHERE id = settled.reference_transaction_id;
          expected_direction := CASE reference_kind WHEN 'BET' THEN 'CREDIT' WHEN 'WIN' THEN 'DEBIT' WHEN 'REFUND' THEN 'DEBIT' END;
        ELSE
          expected_direction := NULL; -- LOSS never moves money
        END IF;

        IF expected_direction IS DISTINCT FROM NEW.direction THEN
          RAISE EXCEPTION 'ledger direction % is not valid for % transaction %', NEW.direction, settled.kind, NEW.transaction_id
            USING ERRCODE = 'check_violation', CONSTRAINT = 'ledger_direction_matches_kind';
        END IF;
        RETURN NULL;
      END;
      $$;
    `);
    this.addSql(`
      CREATE CONSTRAINT TRIGGER wallet_ledger_entries_validate
        AFTER INSERT ON wallet_ledger_entries
        DEFERRABLE INITIALLY DEFERRED
        FOR EACH ROW EXECUTE FUNCTION wallet_ledger_entries_validate();
    `);

    // ---- wallets ------------------------------------------------------------
    this.addSql(`
      CREATE FUNCTION wallets_guard() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF TG_OP = 'INSERT' THEN
          IF NEW.version <> 1 THEN
            RAISE EXCEPTION 'wallet % must be created with version 1', NEW.id
              USING ERRCODE = 'check_violation', CONSTRAINT = 'wallets_initial_version';
          END IF;
          RETURN NEW;
        END IF;
        IF NEW.id <> OLD.id OR NEW.player_id <> OLD.player_id OR NEW.currency <> OLD.currency OR NEW.created_at <> OLD.created_at THEN
          RAISE EXCEPTION 'identity of wallet % is immutable', OLD.id
            USING ERRCODE = 'check_violation', CONSTRAINT = 'wallets_identity_immutable';
        END IF;
        IF NEW.balance_amount <> OLD.balance_amount THEN
          IF NEW.version <> OLD.version + 1 THEN
            RAISE EXCEPTION 'balance change of wallet % must increment version by exactly one', OLD.id
              USING ERRCODE = 'check_violation', CONSTRAINT = 'wallets_version_follows_balance';
          END IF;
        ELSIF NEW.version <> OLD.version THEN
          RAISE EXCEPTION 'version of wallet % can only change together with its balance', OLD.id
            USING ERRCODE = 'check_violation', CONSTRAINT = 'wallets_version_follows_balance';
        END IF;
        RETURN NEW;
      END;
      $$;
    `);
    this.addSql(`
      CREATE TRIGGER wallets_guard
        BEFORE INSERT OR UPDATE ON wallets
        FOR EACH ROW EXECUTE FUNCTION wallets_guard();
    `);
    this.addSql(`
      CREATE TRIGGER wallets_no_delete
        BEFORE DELETE ON wallets
        FOR EACH ROW EXECUTE FUNCTION wagering_reject_mutation('wallets_permanent');
    `);
    this.addSql(`
      CREATE TRIGGER wallets_no_truncate
        BEFORE TRUNCATE ON wallets
        FOR EACH STATEMENT EXECUTE FUNCTION wagering_reject_mutation('wallets_permanent');
    `);
    this.addSql(`
      CREATE FUNCTION wallets_require_ledger_entry() RETURNS trigger LANGUAGE plpgsql AS $$
      DECLARE
        entry_balance numeric(20, 2);
      BEGIN
        IF TG_OP = 'UPDATE' AND NEW.version = OLD.version THEN
          RETURN NULL;
        END IF;
        IF TG_OP = 'INSERT' AND NEW.balance_amount = 0 THEN
          RETURN NULL; -- a zero opening balance is not a financial movement
        END IF;
        SELECT balance_after INTO entry_balance
          FROM wallet_ledger_entries
         WHERE wallet_id = NEW.id AND wallet_version = NEW.version;
        IF NOT FOUND OR entry_balance <> NEW.balance_amount THEN
          RAISE EXCEPTION 'balance of wallet % at version % has no matching ledger entry', NEW.id, NEW.version
            USING ERRCODE = 'check_violation', CONSTRAINT = 'wallets_balance_change_has_ledger_entry';
        END IF;
        RETURN NULL;
      END;
      $$;
    `);
    this.addSql(`
      CREATE CONSTRAINT TRIGGER wallets_balance_change_has_ledger_entry
        AFTER INSERT OR UPDATE ON wallets
        DEFERRABLE INITIALLY DEFERRED
        FOR EACH ROW EXECUTE FUNCTION wallets_require_ledger_entry();
    `);

    // ---- wager transactions ------------------------------------------------
    this.addSql(`
      CREATE FUNCTION wager_transactions_guard() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF OLD.status IN ('PROCESSED', 'REJECTED', 'FAILED') THEN
          RAISE EXCEPTION 'wager transaction % is % (terminal) and cannot change', OLD.id, OLD.status
            USING ERRCODE = 'check_violation', CONSTRAINT = 'wager_tx_terminal_immutable';
        END IF;
        IF NEW.id <> OLD.id
           OR NEW.provider_id <> OLD.provider_id
           OR NEW.external_transaction_id <> OLD.external_transaction_id
           OR NEW.idempotency_key <> OLD.idempotency_key
           OR NEW.payload_hash <> OLD.payload_hash
           OR NEW.channel <> OLD.channel
           OR NEW.wallet_id <> OLD.wallet_id
           OR NEW.player_id <> OLD.player_id
           OR NEW.round_id IS DISTINCT FROM OLD.round_id
           OR NEW.game_id IS DISTINCT FROM OLD.game_id
           OR NEW.kind <> OLD.kind
           OR NEW.amount <> OLD.amount
           OR NEW.currency <> OLD.currency
           OR NEW.reference_external_transaction_id IS DISTINCT FROM OLD.reference_external_transaction_id
           OR NEW.created_at <> OLD.created_at THEN
          RAISE EXCEPTION 'identity and financial content of wager transaction % are immutable', OLD.id
            USING ERRCODE = 'check_violation', CONSTRAINT = 'wager_tx_identity_immutable';
        END IF;
        IF OLD.status = 'PENDING_REFERENCE' AND NEW.status = 'PENDING' THEN
          RAISE EXCEPTION 'wager transaction % cannot go back to PENDING', OLD.id
            USING ERRCODE = 'check_violation', CONSTRAINT = 'wager_tx_status_transition';
        END IF;
        IF NEW.reference_attempts < OLD.reference_attempts THEN
          RAISE EXCEPTION 'reference attempts of wager transaction % cannot decrease', OLD.id
            USING ERRCODE = 'check_violation', CONSTRAINT = 'wager_tx_attempts_monotonic';
        END IF;
        RETURN NEW;
      END;
      $$;
    `);
    this.addSql(`
      CREATE TRIGGER wager_transactions_guard
        BEFORE UPDATE ON wager_transactions
        FOR EACH ROW EXECUTE FUNCTION wager_transactions_guard();
    `);
    this.addSql(`
      CREATE TRIGGER wager_transactions_no_delete
        BEFORE DELETE ON wager_transactions
        FOR EACH ROW EXECUTE FUNCTION wagering_reject_mutation('wager_tx_permanent');
    `);
    this.addSql(`
      CREATE TRIGGER wager_transactions_no_truncate
        BEFORE TRUNCATE ON wager_transactions
        FOR EACH STATEMENT EXECUTE FUNCTION wagering_reject_mutation('wager_tx_permanent');
    `);
    this.addSql(`
      CREATE FUNCTION wager_transactions_validate_reference() RETURNS trigger LANGUAGE plpgsql AS $$
      DECLARE
        ref RECORD;
      BEGIN
        IF NEW.status <> 'PROCESSED' OR NEW.reference_transaction_id IS NULL THEN
          RETURN NEW;
        END IF;
        SELECT * INTO ref FROM wager_transactions WHERE id = NEW.reference_transaction_id;
        IF NOT FOUND
           OR ref.status <> 'PROCESSED'
           OR ref.provider_id <> NEW.provider_id
           OR ref.external_transaction_id <> NEW.reference_external_transaction_id
           OR ref.wallet_id <> NEW.wallet_id
           OR ref.player_id <> NEW.player_id
           OR ref.currency <> NEW.currency
           OR ref.round_id IS DISTINCT FROM NEW.round_id THEN
          RAISE EXCEPTION 'reference of wager transaction % is not a PROCESSED transaction of the same provider, player, wallet, currency and round', NEW.id
            USING ERRCODE = 'check_violation', CONSTRAINT = 'wager_tx_reference_matches';
        END IF;
        IF NOT ((NEW.kind = 'REFUND' AND ref.kind = 'BET')
             OR (NEW.kind = 'ROLLBACK' AND ref.kind IN ('BET', 'WIN', 'REFUND'))
             OR (NEW.kind IN ('WIN', 'LOSS') AND ref.kind = 'BET')) THEN
          RAISE EXCEPTION '% cannot reference a % transaction', NEW.kind, ref.kind
            USING ERRCODE = 'check_violation', CONSTRAINT = 'wager_tx_reference_kind';
        END IF;
        IF NEW.kind IN ('REFUND', 'ROLLBACK') AND NEW.amount <> ref.amount THEN
          RAISE EXCEPTION 'reversal % must have the same amount as its reference', NEW.id
            USING ERRCODE = 'check_violation', CONSTRAINT = 'wager_tx_reversal_amount';
        END IF;
        RETURN NEW;
      END;
      $$;
    `);
    this.addSql(`
      CREATE TRIGGER wager_transactions_validate_reference
        BEFORE INSERT OR UPDATE ON wager_transactions
        FOR EACH ROW EXECUTE FUNCTION wager_transactions_validate_reference();
    `);
    // Closes the loop with the ledger: a PROCESSED transaction that moves money
    // must have its ledger line by COMMIT (LOSS must not: see ledger validation).
    this.addSql(`
      CREATE FUNCTION wager_transactions_require_ledger_entry() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.status <> 'PROCESSED' OR NEW.kind = 'LOSS' THEN
          RETURN NULL;
        END IF;
        IF NOT EXISTS (SELECT 1 FROM wallet_ledger_entries WHERE transaction_id = NEW.id) THEN
          RAISE EXCEPTION 'PROCESSED % transaction % has no ledger entry', NEW.kind, NEW.id
            USING ERRCODE = 'check_violation', CONSTRAINT = 'wager_tx_processed_has_ledger_entry';
        END IF;
        RETURN NULL;
      END;
      $$;
    `);
    this.addSql(`
      CREATE CONSTRAINT TRIGGER wager_transactions_processed_has_ledger_entry
        AFTER INSERT OR UPDATE OF status ON wager_transactions
        DEFERRABLE INITIALLY DEFERRED
        FOR EACH ROW EXECUTE FUNCTION wager_transactions_require_ledger_entry();
    `);

    // ---- messaging ----------------------------------------------------------
    this.addSql(`
      CREATE FUNCTION inbox_messages_guard() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF OLD.status = 'PROCESSED' THEN
          RAISE EXCEPTION 'processed inbox message %/% is immutable', OLD.consumer_name, OLD.message_id
            USING ERRCODE = 'check_violation', CONSTRAINT = 'inbox_processed_immutable';
        END IF;
        IF NEW.consumer_name <> OLD.consumer_name OR NEW.message_id <> OLD.message_id OR NEW.received_at <> OLD.received_at THEN
          RAISE EXCEPTION 'identity of inbox message %/% is immutable', OLD.consumer_name, OLD.message_id
            USING ERRCODE = 'check_violation', CONSTRAINT = 'inbox_identity_immutable';
        END IF;
        RETURN NEW;
      END;
      $$;
    `);
    this.addSql(`
      CREATE TRIGGER inbox_messages_guard
        BEFORE UPDATE ON inbox_messages
        FOR EACH ROW EXECUTE FUNCTION inbox_messages_guard();
    `);
    this.addSql(`
      CREATE FUNCTION outbox_messages_guard() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF OLD.status = 'PUBLISHED' THEN
          RAISE EXCEPTION 'published outbox event % is immutable', OLD.id
            USING ERRCODE = 'check_violation', CONSTRAINT = 'outbox_published_immutable';
        END IF;
        IF NEW.id <> OLD.id
           OR NEW.seq <> OLD.seq
           OR NEW.aggregate_type <> OLD.aggregate_type
           OR NEW.aggregate_id <> OLD.aggregate_id
           OR NEW.event_type <> OLD.event_type
           OR NEW.event_version <> OLD.event_version
           OR NEW.message_group_id <> OLD.message_group_id
           OR NEW.correlation_id <> OLD.correlation_id
           OR NEW.causation_id IS DISTINCT FROM OLD.causation_id
           OR NEW.payload <> OLD.payload
           OR NEW.occurred_at <> OLD.occurred_at THEN
          RAISE EXCEPTION 'content of outbox event % is immutable', OLD.id
            USING ERRCODE = 'check_violation', CONSTRAINT = 'outbox_event_immutable';
        END IF;
        IF NEW.attempts < OLD.attempts THEN
          RAISE EXCEPTION 'attempts of outbox event % cannot decrease', OLD.id
            USING ERRCODE = 'check_violation', CONSTRAINT = 'outbox_attempts_monotonic';
        END IF;
        RETURN NEW;
      END;
      $$;
    `);
    this.addSql(`
      CREATE TRIGGER outbox_messages_guard
        BEFORE UPDATE ON outbox_messages
        FOR EACH ROW EXECUTE FUNCTION outbox_messages_guard();
    `);
  }

  override down(): void {
    this.addSql('DROP TRIGGER IF EXISTS outbox_messages_guard ON outbox_messages;');
    this.addSql('DROP FUNCTION IF EXISTS outbox_messages_guard();');
    this.addSql('DROP TRIGGER IF EXISTS inbox_messages_guard ON inbox_messages;');
    this.addSql('DROP FUNCTION IF EXISTS inbox_messages_guard();');
    this.addSql(
      'DROP TRIGGER IF EXISTS wager_transactions_processed_has_ledger_entry ON wager_transactions;',
    );
    this.addSql('DROP FUNCTION IF EXISTS wager_transactions_require_ledger_entry();');
    this.addSql('DROP TRIGGER IF EXISTS wager_transactions_validate_reference ON wager_transactions;');
    this.addSql('DROP FUNCTION IF EXISTS wager_transactions_validate_reference();');
    this.addSql('DROP TRIGGER IF EXISTS wager_transactions_no_truncate ON wager_transactions;');
    this.addSql('DROP TRIGGER IF EXISTS wager_transactions_no_delete ON wager_transactions;');
    this.addSql('DROP TRIGGER IF EXISTS wager_transactions_guard ON wager_transactions;');
    this.addSql('DROP FUNCTION IF EXISTS wager_transactions_guard();');
    this.addSql('DROP TRIGGER IF EXISTS wallets_balance_change_has_ledger_entry ON wallets;');
    this.addSql('DROP FUNCTION IF EXISTS wallets_require_ledger_entry();');
    this.addSql('DROP TRIGGER IF EXISTS wallets_no_truncate ON wallets;');
    this.addSql('DROP TRIGGER IF EXISTS wallets_no_delete ON wallets;');
    this.addSql('DROP TRIGGER IF EXISTS wallets_guard ON wallets;');
    this.addSql('DROP FUNCTION IF EXISTS wallets_guard();');
    this.addSql('DROP TRIGGER IF EXISTS wallet_ledger_entries_validate ON wallet_ledger_entries;');
    this.addSql('DROP FUNCTION IF EXISTS wallet_ledger_entries_validate();');
    this.addSql('DROP TRIGGER IF EXISTS wallet_ledger_entries_no_truncate ON wallet_ledger_entries;');
    this.addSql('DROP TRIGGER IF EXISTS wallet_ledger_entries_append_only ON wallet_ledger_entries;');
    this.addSql('DROP FUNCTION IF EXISTS wagering_reject_mutation();');
  }
}
