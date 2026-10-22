import { Migration } from '@mikro-orm/migrations';

/** Transactional inbox (message deduplication) and outbox (post-commit publication). */
export class Migration20261022000200MessagingTables extends Migration {
  override up(): void {
    this.addSql(`
      CREATE TABLE inbox_messages (
        consumer_name  varchar(128) NOT NULL,
        message_id     varchar(256) NOT NULL,
        payload_hash   char(64),
        status         varchar(16)  NOT NULL,
        outcome        varchar(32),
        transaction_id uuid,
        result_code    varchar(64),
        receive_count  integer      NOT NULL DEFAULT 1,
        received_at    timestamptz  NOT NULL,
        processed_at   timestamptz,
        -- Deduplication key: one row per (consumer, message).
        CONSTRAINT inbox_messages_pk PRIMARY KEY (consumer_name, message_id),
        CONSTRAINT inbox_transaction_fk FOREIGN KEY (transaction_id)
          REFERENCES wager_transactions (id) DEFERRABLE INITIALLY DEFERRED,
        CONSTRAINT inbox_status_ck CHECK (status IN ('PROCESSED', 'DEAD_LETTERED')),
        CONSTRAINT inbox_processed_at_ck CHECK ((status = 'PROCESSED') = (processed_at IS NOT NULL)),
        CONSTRAINT inbox_processed_hash_ck CHECK (status <> 'PROCESSED' OR payload_hash IS NOT NULL),
        CONSTRAINT inbox_payload_hash_ck CHECK (payload_hash IS NULL OR payload_hash ~ '^[0-9a-f]{64}$'),
        CONSTRAINT inbox_receive_count_ck CHECK (receive_count >= 1)
      );
    `);

    this.addSql(`
      CREATE TABLE outbox_messages (
        id               uuid          PRIMARY KEY,
        seq              bigint        GENERATED ALWAYS AS IDENTITY,
        aggregate_type   varchar(64)   NOT NULL,
        aggregate_id     varchar(128)  NOT NULL,
        event_type       varchar(128)  NOT NULL,
        event_version    integer       NOT NULL,
        message_group_id varchar(128)  NOT NULL,
        correlation_id   varchar(128)  NOT NULL,
        causation_id     varchar(256),
        payload          jsonb         NOT NULL,
        status           varchar(16)   NOT NULL DEFAULT 'PENDING',
        attempts         integer       NOT NULL DEFAULT 0,
        next_attempt_at  timestamptz   NOT NULL,
        claimed_by       varchar(128),
        claim_expires_at timestamptz,
        last_error       varchar(1024),
        occurred_at      timestamptz   NOT NULL,
        published_at     timestamptz,
        CONSTRAINT outbox_seq_uq UNIQUE (seq),
        CONSTRAINT outbox_status_ck CHECK (status IN ('PENDING', 'PUBLISHED', 'DEAD')),
        CONSTRAINT outbox_published_at_ck CHECK ((status = 'PUBLISHED') = (published_at IS NOT NULL)),
        CONSTRAINT outbox_attempts_ck CHECK (attempts >= 0),
        CONSTRAINT outbox_event_version_ck CHECK (event_version >= 1),
        CONSTRAINT outbox_claim_pair_ck CHECK ((claimed_by IS NULL) = (claim_expires_at IS NULL)),
        CONSTRAINT outbox_claim_only_pending_ck CHECK (status = 'PENDING' OR claimed_by IS NULL),
        CONSTRAINT outbox_payload_object_ck CHECK (jsonb_typeof(payload) = 'object')
      );
    `);
    // Publisher scan in commit order, only over undelivered events.
    this.addSql(`CREATE INDEX outbox_pending_seq_idx ON outbox_messages (seq) WHERE status = 'PENDING';`);
    // Operational queue of events needing intervention.
    this.addSql(`CREATE INDEX outbox_dead_idx ON outbox_messages (occurred_at) WHERE status = 'DEAD';`);
  }

  override down(): void {
    this.addSql('DROP TABLE IF EXISTS outbox_messages;');
    this.addSql('DROP TABLE IF EXISTS inbox_messages;');
  }
}
