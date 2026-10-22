import { createCore, type Core, type CoreOverrides } from '../../src/bootstrap/core';
import type { TestDatabase } from './database';
import { testConfig, type TestQueueNames } from './environment';

/** The production composition root, pointed at a test database (and optional test queues). */
export function createTestCore(
  db: TestDatabase,
  options: { queues?: TestQueueNames; overrides?: CoreOverrides; env?: Record<string, string> } = {},
): Promise<Core> {
  const config = testConfig({ dbName: db.name, queues: options.queues, extra: options.env });
  return createCore(config, options.overrides);
}
