// Tests for the thin canonical-writer adapter.
//
// After the 2026-07-06 conformance fix, writeRepIDCanonical delegates to the
// canonical erc8004-reputation writer (canonical registry 0x8004B663…,
// dedicated attestor key — never the agent's own key). These tests exercise
// the adapter's own logic: the test short-circuit, the "no writer configured"
// path, and successful delegation.

import { writeRepIDCanonical } from '../src/services/erc8004-canonical-writer';
import * as reputation from '../src/services/erc8004-reputation';
import { db } from '../src/db';

jest.mock('../src/services/erc8004-reputation');
jest.mock('../src/db', () => ({
  db: { from: jest.fn() },
}));

describe('ERC-8004 Canonical Writer (adapter)', () => {
  let originalNodeEnv: string | undefined;

  beforeEach(() => {
    originalNodeEnv = process.env.NODE_ENV;
    jest.clearAllMocks();
  });

  afterEach(() => {
    process.env.NODE_ENV = originalNodeEnv;
  });

  it('short-circuits under NODE_ENV=test without touching chain or DB', async () => {
    process.env.NODE_ENV = 'test';
    const result = await writeRepIDCanonical('APM', 85.5);
    expect(result.status).toBe('skipped_in_test');
    expect(result.tx_hash).toBe('0xtest');
    expect(reputation.getReputationWriter).not.toHaveBeenCalled();
  });

  it('returns failed when no reputation writer is configured', async () => {
    process.env.NODE_ENV = 'development';
    (reputation.getReputationWriter as jest.Mock).mockReturnValue(null);

    const result = await writeRepIDCanonical('APM', 85.5);

    expect(result.status).toBe('failed');
    expect(result.error).toContain('No reputation writer configured');
  });

  it('delegates to the canonical writer and never uses the agent key', async () => {
    process.env.NODE_ENV = 'development';

    const writeRepIDFeedback = jest
      .fn()
      .mockResolvedValue({ txHash: '0xabc123', blockNumber: 1, gasUsed: '21000' });
    (reputation.getReputationWriter as jest.Mock).mockReturnValue({
      writeRepIDFeedback,
    });

    (db.from as jest.Mock).mockReturnValue({
      select: jest.fn().mockReturnThis(),
      eq: jest.fn().mockReturnThis(),
      maybeSingle: jest.fn().mockResolvedValue({
        data: { erc8004_token_id: '1585', current_repid: 1000, tier: 'ESTABLISHED' },
        error: null,
      }),
    });

    const result = await writeRepIDCanonical('APM', 85.5);

    expect(result.status).toBe('success');
    expect(result.tx_hash).toBe('0xabc123');
    expect(result.basescan_url).toBe('https://sepolia.basescan.org/tx/0xabc123');
    // Delegation carries the tokenId, not a private key.
    expect(writeRepIDFeedback).toHaveBeenCalledWith(
      expect.objectContaining({ agentTokenId: '1585', tier: 'ESTABLISHED' })
    );
  });

  it('reports failed when the agent is missing an erc8004_token_id', async () => {
    process.env.NODE_ENV = 'development';
    (reputation.getReputationWriter as jest.Mock).mockReturnValue({
      writeRepIDFeedback: jest.fn(),
    });

    (db.from as jest.Mock).mockReturnValue({
      select: jest.fn().mockReturnThis(),
      eq: jest.fn().mockReturnThis(),
      maybeSingle: jest.fn().mockResolvedValue({
        data: { erc8004_token_id: null, current_repid: 1000, tier: 'ESTABLISHED' },
        error: null,
      }),
    });

    const result = await writeRepIDCanonical('APM', 85.5);
    expect(result.status).toBe('failed');
    expect(result.error).toContain('no erc8004_token_id');
  });
});
