import { Migration } from '@mikro-orm/migrations';

/**
 * Core financial schema: wallets, wager transactions and the append-only
 * ledger. Uniqueness, non-negativity, arithmetic and cross-table identity
 * rules live HERE, not only in application code.
 *
 * Foreign keys are DEFERRABLE INITIALLY DEFERRED: they are still enforced, but
 * at COMMIT, so the insert order inside one financial transaction is free.
 */
export class Migration20261022000100CoreSchema extends Migration {
  override up(): void {
    this.addSql(`
      CREATE TABLE wallets (
        id              uuid           PRIMARY KEY,
        player_id       varchar(128)   NOT NULL,
        currency        char(3)        NOT NULL,
        balance_amount  numeric(20, 2) NOT NULL,
        version         integer        NOT NULL,
        created_at      timestamptz    NOT NULL,
        updated_at      timestamptz    NOT NULL,
        CONSTRAINT wallets_player_currency_uq UNIQUE (player_id, currency),
        -- target of the ledger composite FK (wallet + currency must match)
        CONSTRAINT wallets_id_currency_uq UNIQUE (id, currency),
        CONSTRAINT wallets_currency_format_ck CHECK (currency ~ '^[A-Z]{3}$'),
        CONSTRAINT wallets_balance_non_negative_ck CHECK (balance_amount >= 0),
        CONSTRAINT wallets_version_positive_ck CHECK (version >= 1),
        CONSTRAINT wallets_player_id_not_blank_ck CHECK (length(btrim(player_id)) > 0),
        CONSTRAINT wallets_timestamps_ck CHECK (updated_at >= created_at)
      );
    `);

    this.addSql(`
      CREATE TABLE wager_transactions (
        id                                uuid           PRIMARY KEY,
        provider_id                       varchar(64)    NOT NULL,
        external_transaction_id           varchar(128)   NOT NULL,
        idempotency_key                   varchar(255)   NOT NULL,
        payload_hash                      char(64)       NOT NULL,
        channel                           varchar(16)    NOT NULL,
        wallet_id                         uuid           NOT NULL,
        player_id                         varchar(128)   NOT NULL,
        round_id                          varchar(128),
        game_id                           varchar(128),
        kind                              varchar(16)    NOT NULL,
        amount                            numeric(20, 2) NOT NULL,
        currency                          char(3)        NOT NULL,
        reference_external_transaction_id varchar(128),
        reference_transaction_id          uuid,
        status                            varchar(24)    NOT NULL,
        failure_code                      varchar(64),
        result_balance_amount             numeric(20, 2),
        result_wallet_version             integer,
        reference_attempts                integer        NOT NULL DEFAULT 0,
        next_attempt_at                   timestamptz,
        reference_expires_at              timestamptz,
        claimed_by                        varchar(128),
        claim_expires_at                  timestamptz,
        created_at                        timestamptz    NOT NULL,
        updated_at                        timestamptz    NOT NULL,
        processed_at                      timestamptz,

        -- Persistent idempotency, shared by HTTP and SQS and by every process.
        CONSTRAINT wager_tx_provider_idempotency_key_uq UNIQUE (provider_id, idempotency_key),
        CONSTRAINT wager_tx_provider_external_id_uq UNIQUE (provider_id, external_transaction_id),
        -- Targets of composite foreign keys.
        CONSTRAINT wager_tx_ledger_identity_uq UNIQUE (id, wallet_id, currency, amount),
        CONSTRAINT wager_tx_wallet_identity_uq UNIQUE (id, wallet_id),

        CONSTRAINT wager_tx_wallet_fk FOREIGN KEY (wallet_id)
          REFERENCES wallets (id) DEFERRABLE INITIALLY DEFERRED,
        -- A reference can only point to a transaction of the SAME wallet.
        CONSTRAINT wager_tx_reference_same_wallet_fk FOREIGN KEY (reference_transaction_id, wallet_id)
          REFERENCES wager_transactions (id, wallet_id) DEFERRABLE INITIALLY DEFERRED,

        CONSTRAINT wager_tx_kind_ck CHECK (kind IN ('OPENING', 'BET', 'WIN', 'LOSS', 'REFUND', 'ROLLBACK')),
        CONSTRAINT wager_tx_status_ck CHECK (status IN ('PENDING', 'PENDING_REFERENCE', 'PROCESSED', 'REJECTED', 'FAILED')),
        CONSTRAINT wager_tx_channel_ck CHECK (channel IN ('HTTP', 'SQS', 'INTERNAL')),
        CONSTRAINT wager_tx_currency_format_ck CHECK (currency ~ '^[A-Z]{3}$'),
        CONSTRAINT wager_tx_payload_hash_ck CHECK (payload_hash ~ '^[0-9a-f]{64}$'),
        CONSTRAINT wager_tx_amount_non_negative_ck CHECK (amount >= 0),
        -- Only LOSS may carry a zero amount; everything that moves money is positive.
        CONSTRAINT wager_tx_amount_positive_ck CHECK (amount > 0 OR kind = 'LOSS'),
        -- OPENING is internal only, and the internal channel only creates OPENING.
        CONSTRAINT wager_tx_opening_internal_ck CHECK ((kind = 'OPENING') = (channel = 'INTERNAL')),
        CONSTRAINT wager_tx_round_required_ck CHECK (kind = 'OPENING' OR (round_id IS NOT NULL AND game_id IS NOT NULL)),
        CONSTRAINT wager_tx_reversal_requires_reference_ck
          CHECK (kind NOT IN ('REFUND', 'ROLLBACK') OR reference_external_transaction_id IS NOT NULL),
        CONSTRAINT wager_tx_reference_allowed_ck
          CHECK (kind NOT IN ('OPENING', 'BET') OR reference_external_transaction_id IS NULL),
        CONSTRAINT wager_tx_no_self_reference_ck
          CHECK (reference_external_transaction_id IS DISTINCT FROM external_transaction_id
                 AND reference_transaction_id IS DISTINCT FROM id),
        CONSTRAINT wager_tx_resolved_reference_ck
          CHECK (reference_transaction_id IS NULL OR reference_external_transaction_id IS NOT NULL),
        -- A PROCESSED transaction with a reference must point to the resolved row.
        CONSTRAINT wager_tx_processed_reference_ck
          CHECK (status <> 'PROCESSED' OR reference_external_transaction_id IS NULL OR reference_transaction_id IS NOT NULL),
        -- failure_code exists exactly for REJECTED / FAILED.
        CONSTRAINT wager_tx_failure_code_ck CHECK ((status IN ('REJECTED', 'FAILED')) = (failure_code IS NOT NULL)),
        -- processed_at is the moment a terminal state was reached.
        CONSTRAINT wager_tx_processed_at_ck CHECK ((status IN ('PROCESSED', 'REJECTED', 'FAILED')) = (processed_at IS NOT NULL)),
        -- Every persisted state carries the result snapshot used for idempotent replays.
        CONSTRAINT wager_tx_result_snapshot_ck
          CHECK (status = 'PENDING' OR (result_balance_amount IS NOT NULL AND result_wallet_version IS NOT NULL)),
        CONSTRAINT wager_tx_result_balance_non_negative_ck CHECK (result_balance_amount IS NULL OR result_balance_amount >= 0),
        CONSTRAINT wager_tx_pending_schedule_ck
          CHECK (status <> 'PENDING_REFERENCE' OR (next_attempt_at IS NOT NULL AND reference_expires_at IS NOT NULL)),
        CONSTRAINT wager_tx_reference_attempts_ck CHECK (reference_attempts >= 0),
        CONSTRAINT wager_tx_claim_pair_ck CHECK ((claimed_by IS NULL) = (claim_expires_at IS NULL)),
        CONSTRAINT wager_tx_claim_only_pending_ck CHECK (status IN ('PENDING', 'PENDING_REFERENCE') OR claimed_by IS NULL)
      );
    `);

    // At most ONE successful reversal (REFUND or ROLLBACK, whatever the kind) per referenced transaction.
    this.addSql(`
      CREATE UNIQUE INDEX wager_tx_single_successful_reversal_uq
        ON wager_transactions (reference_transaction_id)
        WHERE status = 'PROCESSED' AND kind IN ('REFUND', 'ROLLBACK');
    `);
    // PendingReferenceWorker scan (small partial index: only waiting rows).
    this.addSql(`
      CREATE INDEX wager_tx_pending_reference_due_idx
        ON wager_transactions (next_attempt_at)
        WHERE status = 'PENDING_REFERENCE';
    `);
    // "Wake dependents" lookup when a referenced transaction is settled.
    this.addSql(`
      CREATE INDEX wager_tx_waiting_dependents_idx
        ON wager_transactions (provider_id, reference_external_transaction_id)
        WHERE status = 'PENDING_REFERENCE';
    `);
    this.addSql(`
      CREATE INDEX wager_tx_reference_transaction_idx
        ON wager_transactions (reference_transaction_id)
        WHERE reference_transaction_id IS NOT NULL;
    `);
    this.addSql(`CREATE INDEX wager_tx_wallet_created_idx ON wager_transactions (wallet_id, created_at);`);

    this.addSql(`
      CREATE TABLE wallet_ledger_entries (
        id              uuid           PRIMARY KEY,
        wallet_id       uuid           NOT NULL,
        transaction_id  uuid           NOT NULL,
        direction       varchar(6)     NOT NULL,
        amount          numeric(20, 2) NOT NULL,
        currency        char(3)        NOT NULL,
        balance_before  numeric(20, 2) NOT NULL,
        balance_after   numeric(20, 2) NOT NULL,
        wallet_version  integer        NOT NULL,
        created_at      timestamptz    NOT NULL,

        -- One ledger line per financial transaction (single-wallet operations).
        CONSTRAINT ledger_transaction_uq UNIQUE (transaction_id),
        -- One line per wallet version: also the keyset pagination index.
        CONSTRAINT ledger_wallet_version_uq UNIQUE (wallet_id, wallet_version),
        -- Line currency must be the wallet currency.
        CONSTRAINT ledger_wallet_fk FOREIGN KEY (wallet_id, currency)
          REFERENCES wallets (id, currency) DEFERRABLE INITIALLY DEFERRED,
        -- Line wallet, currency and amount must be exactly the transaction's.
        CONSTRAINT ledger_transaction_fk FOREIGN KEY (transaction_id, wallet_id, currency, amount)
          REFERENCES wager_transactions (id, wallet_id, currency, amount) DEFERRABLE INITIALLY DEFERRED,

        CONSTRAINT ledger_direction_ck CHECK (direction IN ('CREDIT', 'DEBIT')),
        CONSTRAINT ledger_amount_positive_ck CHECK (amount > 0),
        CONSTRAINT ledger_balances_non_negative_ck CHECK (balance_before >= 0 AND balance_after >= 0),
        CONSTRAINT ledger_arithmetic_ck CHECK (
          (direction = 'CREDIT' AND balance_after = balance_before + amount)
          OR (direction = 'DEBIT' AND balance_after = balance_before - amount)
        ),
        CONSTRAINT ledger_wallet_version_positive_ck CHECK (wallet_version >= 1)
      );
    `);
  }

  override down(): void {
    this.addSql('DROP TABLE IF EXISTS wallet_ledger_entries;');
    this.addSql('DROP TABLE IF EXISTS wager_transactions;');
    this.addSql('DROP TABLE IF EXISTS wallets;');
  }
}
