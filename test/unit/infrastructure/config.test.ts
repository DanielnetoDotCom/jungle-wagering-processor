import { describe, expect, test } from 'bun:test';
import { ReferenceRetryPolicy } from '../../../src/domain/wagering/reference-retry-policy';
import { ConfigurationError, loadConfig } from '../../../src/infrastructure/configuration/config';

const REQUIRED = { DB_HOST: 'db', DB_NAME: 'wagering', DB_USER: 'user', DB_PASSWORD: 'secret' };

describe('configuration', () => {
  test('pending references: with the defaults the 1h TTL is the limit that applies, attempts are only a cap', () => {
    const { reference } = loadConfig(REQUIRED);
    const policy = ReferenceRetryPolicy.create(reference);
    const acceptedAt = new Date('2026-10-23T00:00:00Z');
    const expiresAt = policy.expiresAt(acceptedAt);

    let at = policy.firstAttemptAt(acceptedAt);
    let attempts = 0;
    while (!policy.isExhausted(attempts, at, expiresAt)) {
      attempts += 1;
      at = policy.nextAttemptAt(attempts, at);
    }
    expect(attempts).toBeLessThan(reference.maxAttempts);
    expect(at.getTime()).toBeGreaterThanOrEqual(expiresAt.getTime());
    // A late reference that does not wake its dependents is noticed within the backoff cap.
    expect(policy.delayAfter(attempts)).toBeLessThanOrEqual(5 * 60_000);
  });

  test('the SQS redrive cannot dead-letter a message before the consumer could try it', () => {
    expect(loadConfig(REQUIRED).sqs.maxReceiveCount).toBeGreaterThanOrEqual(
      loadConfig(REQUIRED).consumer.maxAttempts * loadConfig(REQUIRED).sqs.maxMessages,
    );
    expect(() =>
      loadConfig({
        ...REQUIRED,
        CONSUMER_MAX_ATTEMPTS: '5',
        SQS_MAX_MESSAGES: '10',
        SQS_MAX_RECEIVE_COUNT: '49',
      }),
    ).toThrow(ConfigurationError);
    expect(
      loadConfig({
        ...REQUIRED,
        CONSUMER_MAX_ATTEMPTS: '5',
        SQS_MAX_MESSAGES: '10',
        SQS_MAX_RECEIVE_COUNT: '50',
      }).sqs.maxReceiveCount,
    ).toBe(50);
  });
});
