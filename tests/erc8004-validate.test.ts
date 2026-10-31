/**
 * GET /api/v1/erc8004/validate/:agent_id — honest rewrite (2026-07-29).
 *
 * This public endpoint (auth-bypassed in src/middleware/auth.ts) used to
 * FABRICATE validation_status:"verified" + conservator_bonded:true with zero
 * chain reads, plus a meaningless sha256(agent_id) "identity_hash" — on the
 * exact surface a counterparty would use to decide whether to authorize an
 * agent. These tests pin the honest contract:
 *   - validation_status is derived from recorded mint state
 *     ('registered_onchain' | 'offchain_only'), never a bare "verified";
 *   - the fabricated fields are GONE, not renamed;
 *   - live verification is a linked endpoint, not a claim;
 *   - passport service failures surface as 500, not a fake 200.
 *
 * The endpoint had ZERO test coverage before this file.
 */
import request from 'supertest';
import express from 'express';

jest.mock('../src/services/agent-passport', () => {
  const actual = jest.requireActual('../src/services/agent-passport');
  return {
    ...actual,
    buildAgentPassport: jest.fn(),
  };
});

// v1.ts pulls in the whole service surface; mock db so nothing touches Supabase.
jest.mock('../src/db', () => ({
  db: { from: jest.fn() },
}));

import v1Router from '../src/routes/v1';
import {
  buildAgentPassport,
  PassportQueryError,
} from '../src/services/agent-passport';

const app = express();
app.use(express.json());
app.use('/api/v1', v1Router);

const AGENT_ID = '11111111-2222-3333-4444-555555555555';

/** The real enum (services/agent-passport.ts), not a boolean: a boolean fixture hid the bug. */
type MintState = 'MINTED' | 'UNVERIFIED' | 'NOT_MINTED';
function passportFixture(overrides: { registered_onchain: MintState }) {
  const minted = overrides.registered_onchain !== 'NOT_MINTED';
  return {
    passport_version: '1',
    as_of: '2026-07-29T00:00:00.000Z',
    agent: {
      agent_id: AGENT_ID,
      agent_name: 'trinity-shofet',
      display_name: 'trinity-shofet',
      created_at: '2026-04-01T00:00:00.000Z',
    },
    reputation: { repid_score: 1390, tier: 'ESTABLISHED', activity_30d: 12 },
    identity_erc8004: {
      registered_onchain: overrides.registered_onchain,
      token_id: minted ? '5863' : null,
      contract_address: minted
        ? '0x8004A818BFB912233c491871b3d84c89A494BD9e'
        : null,
      chain_id: minted ? 84532 : null,
      network: minted ? 'base-sepolia' : null,
      mint_tx_hash: minted ? '0xminttx' : null,
      mint_basescan_url: minted
        ? 'https://sepolia.basescan.org/tx/0xminttx'
        : null,
      minted_at: null,
      conservator_address: null,
      live_verification_endpoint: `/api/v1/agents/${AGENT_ID}/onchain`,
    },
  } as any;
}

afterEach(() => jest.clearAllMocks());

describe('GET /api/v1/erc8004/validate/:agent_id', () => {
  test('minted agent → registered_onchain, no fabricated fields', async () => {
    (buildAgentPassport as jest.Mock).mockResolvedValue(
      passportFixture({ registered_onchain: 'MINTED' })
    );
    const res = await request(app).get(`/api/v1/erc8004/validate/${AGENT_ID}`);

    expect(res.status).toBe(200);
    expect(res.body.validation_status).toBe('registered_onchain');
    expect(res.body.reputation_score).toBe(1390);
    expect(res.body.tier).toBe('ESTABLISHED');
    expect(res.body.identity.token_id).toBe('5863');
    expect(res.body.identity.live_verification_endpoint).toBe(
      `/api/v1/agents/${AGENT_ID}/onchain`
    );
    expect(res.body.passport_url).toBe(`/api/v1/passport/${AGENT_ID}`);

    // The fabricated fields must be gone, not renamed.
    expect(res.body).not.toHaveProperty('identity_hash');
    expect(res.body).not.toHaveProperty('conservator_bonded');
    expect(res.body.validation_status).not.toBe('verified');
  });

  test('unminted agent → offchain_only (never "verified")', async () => {
    (buildAgentPassport as jest.Mock).mockResolvedValue(
      passportFixture({ registered_onchain: 'NOT_MINTED' })
    );
    const res = await request(app).get(`/api/v1/erc8004/validate/${AGENT_ID}`);
    expect(res.status).toBe(200);
    expect(res.body.validation_status).toBe('offchain_only');
    expect(res.body.identity.token_id).toBeNull();
  });

  test('a recorded mint that was not confirmed on chain is not "registered_onchain"', async () => {
    (buildAgentPassport as jest.Mock).mockResolvedValue(
      passportFixture({ registered_onchain: 'UNVERIFIED' })
    );
    const res = await request(app).get(`/api/v1/erc8004/validate/${AGENT_ID}`);
    expect(res.status).toBe(200);
    expect(res.body.validation_status).toBe('mint_recorded_unverified');
  });

  test('unknown agent → 404', async () => {
    (buildAgentPassport as jest.Mock).mockResolvedValue(null);
    const res = await request(app).get(`/api/v1/erc8004/validate/${AGENT_ID}`);
    expect(res.status).toBe(404);
  });

  test('passport query failure → 500 query_failed, never a fake 200', async () => {
    (buildAgentPassport as jest.Mock).mockRejectedValue(
      new PassportQueryError('x402_real_count', 'boom')
    );
    const res = await request(app).get(`/api/v1/erc8004/validate/${AGENT_ID}`);
    expect(res.status).toBe(500);
    expect(res.body.error).toBe('query_failed');
    expect(res.body.step).toBe('x402_real_count');
  });
});
