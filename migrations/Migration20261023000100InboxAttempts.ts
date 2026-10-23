import { Migration } from '@mikro-orm/migrations';

/**
 * Failed processing attempts per (consumer, message), counted in their own
 * transaction because the failed one rolled back. SQS `ApproximateReceiveCount`
 * cannot be the retry budget: in a FIFO group the messages behind a failing
 * head are received (and counted) with it on every retry without ever being
 * processed, so the queue redrive would dead-letter them untouched.
 */
export class Migration20261023000100InboxAttempts extends Migration {
  override up(): void {
    this.addSql(`
      CREATE TABLE inbox_attempts (
        consumer_name   varchar(128) NOT NULL,
        message_id      varchar(256) NOT NULL,
        attempts        integer      NOT NULL,
        last_error_code varchar(64)  NOT NULL,
        last_attempt_at timestamptz  NOT NULL,
        CONSTRAINT inbox_attempts_pk PRIMARY KEY (consumer_name, message_id),
        CONSTRAINT inbox_attempts_count_ck CHECK (attempts >= 0)
      );
    `);
    this.addSql('REVOKE ALL ON inbox_attempts FROM PUBLIC;');
    this.addSql('GRANT SELECT, INSERT, UPDATE ON inbox_attempts TO wagering_app;');
  }

  override down(): void {
    this.addSql('DROP TABLE IF EXISTS inbox_attempts;');
  }
}
