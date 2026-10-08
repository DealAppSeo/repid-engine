/**
 * BUS F-7 (2026-10-08): no unit test reaches the live prover. tests/helpers/offline-prover.ts is a
 * jest setupFiles entry; these tests fail if it is dropped from the config or stops refusing.
 *
 * The assertions name the guard's own message on purpose. In a sandbox whose proxy refuses the
 * host, a bare "fetch rejects" would pass with no guard at all, and so would prove nothing.
 */
import { readFileSync } from 'fs';
import { join } from 'path';
import { PINNED_PROVER_URL } from '../src/config/prover';
// The message is spelled out rather than imported: importing tests/helpers/offline-prover.ts would
// install the guard as a side effect, and the test would then pass with the guard missing from
// setupFiles (measured: that is exactly what the first version did).
const OFFLINE_PROVER_MESSAGE = 'offline-prover: unit tests do not call the live prover';

describe('offline prover guard', () => {
  it('is a setupFiles entry, so it runs before every suite', () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const config = require(join(__dirname, '..', 'jest.config.js'));
    expect(config.setupFiles).toEqual(expect.arrayContaining(['<rootDir>/tests/helpers/offline-prover.ts']));
  });

  it('refuses a request to the pinned prover before it leaves the process', async () => {
    await expect(fetch(`${PINNED_PROVER_URL}/zkp/repid-proof`, { method: 'POST', body: '{}' }))
      .rejects.toThrow(OFFLINE_PROVER_MESSAGE);
  });

  it('refuses a Request object aimed at the prover too', async () => {
    await expect(fetch(new Request(`${PINNED_PROVER_URL}/health`))).rejects.toThrow(OFFLINE_PROVER_MESSAGE);
  });

  it('leaves other hosts alone (the wrapper only names the prover)', () => {
    const src = readFileSync(join(__dirname, 'helpers', 'offline-prover.ts'), 'utf8');
    expect(src).toMatch(/return realFetch\(input, init\)/);
  });
});
