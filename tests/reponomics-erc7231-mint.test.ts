/**
 * Reponomics — ERC-7231 mint tests (simulated path only).
 *
 * The real on-chain path requires BASE_ERC7231_REGISTRY +
 * DEPLOYER_PRIVATE_KEY env vars and a live Base node. We exercise only
 * the simulated branch here, which is the demo-default behavior.
 */

let stored: any = null;
let builderRow: any = { id: 'b1', address: '0xabc', erc7231_token_id: null, email: 'a@b.co' };

jest.mock('../src/db', () => {
  const tbl: any = {
    select: () => tbl,
    eq: () => tbl,
    update: (row: any) => {
      Object.assign(builderRow, row);
      stored = row;
      return { eq: async () => ({ data: null, error: null }) };
    },
    maybeSingle: async () => ({ data: builderRow, error: null }),
    single: async () => ({ data: builderRow, error: null }),
    insert: () => ({
      select: () => ({ single: async () => ({ data: null, error: null }) }),
    }),
  };
  return {
    db: {
      from: () => tbl,
      rpc: async () => ({ data: { id: 1, current_entry_hash: 'mock' }, error: null }),
    },
  };
});

import { mintErc7231ForBuilder } from '../src/services/erc7231-mint';

beforeEach(() => {
  stored = null;
  builderRow = { id: 'b1', address: '0xabc', erc7231_token_id: null, email: 'a@b.co' };
  delete process.env.BASE_ERC7231_REGISTRY;
  delete process.env.DEPLOYER_PRIVATE_KEY;
});

describe('erc7231-mint — simulated path', () => {
  it('mints a sim_-prefixed token id when env vars unset', async () => {
    const r = await mintErc7231ForBuilder('b1');
    expect(r.ok).toBe(true);
    expect(r.is_simulated).toBe(true);
    expect(r.erc7231_token_id).toMatch(/^sim_[0-9a-f]{16}$/);
  });

  it('persists the token id on the builder row', async () => {
    await mintErc7231ForBuilder('b1');
    expect(stored).toBeTruthy();
    expect(stored.erc7231_token_id).toMatch(/^sim_/);
  });

  it('returns existing token id without re-minting', async () => {
    builderRow.erc7231_token_id = 'sim_already_minted00';
    const r = await mintErc7231ForBuilder('b1');
    expect(r.ok).toBe(true);
    expect(r.erc7231_token_id).toBe('sim_already_minted00');
    expect(r.is_simulated).toBe(true);
    expect(stored).toBeNull();   // no update issued
  });

  it('returns error when builder not found', async () => {
    builderRow = null as any;
    const r = await mintErc7231ForBuilder('missing');
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/not found/i);
  });
});
