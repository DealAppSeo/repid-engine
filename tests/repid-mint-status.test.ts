/**
 * GET /api/v1/repid/:id carries the ERC-8004 second factor.
 *
 * It returned { score, tier } and nothing else, so every reader (extension, CLI, MCP) showed mint
 * state as unknown "because the endpoint does not return it", while /passport/:id had the data.
 * Now a FOUND agent also carries { erc8004_token_id, registered_onchain, minted }, derived by the
 * same ladder as the passport (identity-state.ts) — one ladder, not a second copy.
 *
 * Properties pinned here:
 *   1. The three states stay three. UNVERIFIED is never flattened into minted:false (the old
 *      boolean's bug, #548): a token id with no mint tx is "we have not looked", not "no identity".
 *   2. An unknown agent is still EXACTLY { score: 'NOT_CHECKED', tier: 'NOT_CHECKED' } — no mint
 *      fields, because "not minted" about an agent that does not exist would be a claim.
 *   3. The default body still has no agent_id (that stays opt-in via ?with=id).
 */
import express from 'express';
import request from 'supertest';
import { repidMintStatus } from '../src/services/repid-mint-status';

const UUID = '11111111-2222-3333-4444-555555555555';
const MINT_TX = '0x' + 'cd'.repeat(32);

let nextRow: Record<string, unknown> | null = null;
let lastSelect = '';

jest.mock('../src/db', () => {
  const makeQuery = () => {
    const q: any = {
      select: (cols: string) => { lastSelect = String(cols); return q; },
      eq: () => q,
      order: () => q,
      limit: () => q,
      not: () => q,
      maybeSingle: async () => ({ data: nextRow, error: null }),
      single: async () => ({ data: nextRow, error: null }),
    };
    return q;
  };
  return { db: { from: () => makeQuery() } };
});

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { repidPublicRouter } = require('../src/routes/repid');
const app = express();
app.use('/api/v1', repidPublicRouter);

const base = { id: UUID, current_repid: 1299, tier: 'ESTABLISHED', last_updated: '2026-10-01T00:00:00.000Z' };

describe('repidMintStatus (pure)', () => {
  it('MINTED: a mint tx is held', () => {
    expect(repidMintStatus({ mint_tx_hash: MINT_TX, erc8004_token_id: '5863' })).toEqual({
      erc8004_token_id: '5863',
      registered_onchain: 'MINTED',
      minted: true,
    });
  });

  it('UNVERIFIED: a token id with no mint tx is minted:null, never false', () => {
    const s = repidMintStatus({ mint_tx_hash: null, erc8004_token_id: '3747' });
    expect(s).toEqual({ erc8004_token_id: '3747', registered_onchain: 'UNVERIFIED', minted: null });
    expect(s.minted).not.toBe(false);
  });

  it('NOT_MINTED: no token id at all', () => {
    expect(repidMintStatus({ mint_tx_hash: null, erc8004_token_id: null })).toEqual({
      erc8004_token_id: null,
      registered_onchain: 'NOT_MINTED',
      minted: false,
    });
  });

  it('an empty-string token id is not a token; a numeric one is stringified', () => {
    expect(repidMintStatus({ erc8004_token_id: '' }).erc8004_token_id).toBeNull();
    expect(repidMintStatus({ erc8004_token_id: 12 }).erc8004_token_id).toBe('12');
  });

  it('the three states are distinguishable in the output', () => {
    const states = new Set([
      repidMintStatus({ mint_tx_hash: MINT_TX, erc8004_token_id: '1' }).registered_onchain,
      repidMintStatus({ mint_tx_hash: null, erc8004_token_id: '1' }).registered_onchain,
      repidMintStatus({ mint_tx_hash: null, erc8004_token_id: null }).registered_onchain,
    ]);
    expect(states.size).toBe(3);
  });
});

describe('GET /api/v1/repid/:id', () => {
  beforeEach(() => { nextRow = null; lastSelect = ''; });

  it('MINTED agent: score, tier and the mint block', async () => {
    nextRow = { ...base, erc8004_token_id: '5863', mint_tx_hash: MINT_TX };
    const res = await request(app).get(`/api/v1/repid/${UUID}`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      score: 1299,
      tier: 'ESTABLISHED',
      erc8004_token_id: '5863',
      registered_onchain: 'MINTED',
      minted: true,
    });
    // The columns were actually asked for (a mock that ignores select() would hide their removal).
    expect(lastSelect).toContain('erc8004_token_id');
    expect(lastSelect).toContain('mint_tx_hash');
  });

  it('UNVERIFIED agent stays UNVERIFIED: token id shown, minted null, not false', async () => {
    nextRow = { ...base, erc8004_token_id: '3747', mint_tx_hash: null };
    const res = await request(app).get(`/api/v1/repid/${UUID}`);
    expect(res.status).toBe(200);
    expect(res.body.registered_onchain).toBe('UNVERIFIED');
    expect(res.body.erc8004_token_id).toBe('3747');
    expect(res.body.minted).toBeNull();
  });

  it('NOT_MINTED agent: token id null, minted false', async () => {
    nextRow = { ...base, erc8004_token_id: null, mint_tx_hash: null };
    const res = await request(app).get(`/api/v1/repid/${UUID}`);
    expect(res.body.registered_onchain).toBe('NOT_MINTED');
    expect(res.body.erc8004_token_id).toBeNull();
    expect(res.body.minted).toBe(false);
  });

  it('a slug resolves the same way and carries the same block', async () => {
    nextRow = { ...base, erc8004_token_id: '5863', mint_tx_hash: MINT_TX };
    const res = await request(app).get('/api/v1/repid/shofet');
    expect(res.status).toBe(200);
    expect(res.body.registered_onchain).toBe('MINTED');
  });

  it('?with=id still adds agent_id, and the default body does not carry it', async () => {
    nextRow = { ...base, erc8004_token_id: '5863', mint_tx_hash: MINT_TX };
    const plain = await request(app).get(`/api/v1/repid/${UUID}`);
    expect(plain.body).not.toHaveProperty('agent_id');
    const withId = await request(app).get(`/api/v1/repid/${UUID}?with=id`);
    expect(withId.body.agent_id).toBe(UUID);
    expect(withId.body.registered_onchain).toBe('MINTED');
  });

  it('an UNKNOWN agent is exactly NOT_CHECKED with no mint fields', async () => {
    nextRow = null; // no row matches
    const res = await request(app).get('/api/v1/repid/trinity-does-not-exist');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ score: 'NOT_CHECKED', tier: 'NOT_CHECKED' });
    expect(res.body).not.toHaveProperty('minted');
    expect(res.body).not.toHaveProperty('registered_onchain');
  });
});
