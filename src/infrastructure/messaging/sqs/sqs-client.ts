import { GetQueueUrlCommand, SQSClient } from '@aws-sdk/client-sqs';
import type { AppConfig } from '../../configuration/config';

export function createSqsClient(config: AppConfig): SQSClient {
  return new SQSClient({
    region: config.aws.region,
    ...(config.aws.endpoint ? { endpoint: config.aws.endpoint } : {}),
    maxAttempts: 3,
    // Must exceed the long-poll wait (20s) so ReceiveMessage is never cut short.
    requestHandler: { requestTimeout: config.sqs.requestTimeoutMs, connectionTimeout: 3000 },
  });
}

/** Resolves and caches queue URLs by name (failed lookups are not cached). */
export class QueueUrlResolver {
  private readonly cache = new Map<string, Promise<string>>();

  constructor(private readonly sqs: SQSClient) {}

  resolve(queueName: string): Promise<string> {
    const cached = this.cache.get(queueName);
    if (cached) return cached;
    const lookup = this.sqs.send(new GetQueueUrlCommand({ QueueName: queueName })).then((response) => {
      if (!response.QueueUrl) throw new Error(`Queue ${queueName} has no URL`);
      return response.QueueUrl;
    });
    lookup.catch(() => this.cache.delete(queueName));
    this.cache.set(queueName, lookup);
    return lookup;
  }
}
