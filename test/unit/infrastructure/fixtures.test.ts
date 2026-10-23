import { expect, test } from 'bun:test';
import { waitFor } from '../../support/fixtures';

test('waitFor keeps polling on null database results as well as undefined and false', async () => {
  const found = { status: 'PROCESSED' };
  const samples: Array<typeof found | null | undefined | false> = [null, undefined, false, found];
  let probes = 0;
  expect(await waitFor(() => Promise.resolve(samples[probes++]), { intervalMs: 1, timeoutMs: 1000 })).toBe(
    found,
  );
  expect(probes).toBe(4);
});
