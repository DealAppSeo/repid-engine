/**
 * Agent Trust Passport (2026-07-29).
 *
 * Verifies the composite public surface TrustShell.dev / TrustMarket.dev
 * render for "should I authorize this agent?":
 *   - buildAgentPassport composes ONLY recorded facts: RepID + DB-derived tier
 *     (never recomputed app-side), ERC-8004 mint metadata, x402 real-vs-
 *     simulated settlement counts, on-chain reputation write count, latest
 *     ZKP proof labeled honestly (D-019: range proof, not behavior attestation).
 *   - No fabricated fields: nothing says "verified" without a chain read —
 *     live verification is a linked endpoint, not a claim.
 *   - Sub-query failures throw PassportQueryError (fail-loud, never a
 *     silently-zeroed passport) → route maps to 500 query_failed.
 *   - GET /api/v1/passport/:agentId is public (mounted pre-auth in index.ts).
 */
import request from 'supertest';
import express from 'express';
import {
  buildAgentPassport,
  PassportQueryError,
} from '../src/services/agent-passport';

jest.mock('../src/db', () => ({
  get db() {
    return (global as any).__passportDb;
  },
}));

// eslint-disable-next-line import/first
import agentPassportRouter from '../src/routes/v1/agent-passport';

/* ------------------------------ scripted db ------------------------------ */

/** Chainable thenable: every builder method returns the chain; awaiting the
 *  chain (or .maybeSingle()) resolves to the scripted result. */
function chainResult(result: any) {
  const chain: any = {};
  for (const m of ['select', 'eq', 'or', 'order', 'limit', 'not']) {
    chain[m] = () => chain;
  }
  chain.maybeSingle = () => Promise.resolve(result);
  chain.then = (onF: any, onR: any) => Promise.resolve(result).then(onF, onR);
  return chain;
}

/** db.from(table) pops the next scripted result for that table, in order. */
function makeDb(script: Record<string, any[]>) {
  const queues: Record<string, any[]> = Object.fromEntries(
    Object.entries(script).map(([k, v]) => [k, [...v]])
  );
  return {
    from: (table: string) => {
      const q = queues[table];
      if (!q || q.length === 0) {
        throw new Error(`unexpected query on table ${table}`);
      }
      return chainResult(q.shift());
    },
  } as any;
}

const MINTED_AGENT = {
  id: '11111111-2222-3333-4444-555555555555',
  agent_name: 'trinity-shofet',
  display_name: null,
  current_repid: 1390,
  tier: 'ESTABLISHED',
  activity_30d: 12,
  created_at: '2026-04-01T00:00:00.000Z',
  erc8004_token_id: '5863',
  erc8004_address: '0x8004A818BFB912233c491871b3d84c89A494BD9e',
  mint_tx_hash: '0xminttx',
  mint_chain_id: 84532,
  minted_at: '2026-05-10T00:00:00.000Z',
  conservator_address: '0xdf6b82150000000000000000000000000000271d',
};

/** The standard scripted sequence for one successful buildAgentPassport call
 *  on a minted agent. Order matters: real count, sim count, last real. */
function happyScript(agentRow: any = MINTED_AGENT) {
  return {
    repid_agents: [{ data: agentRow, error: null }],
    x402_settlements: [
      { count: 7, error: null },
      { count: 3, error: null },
      {
        data: {
          tx_hash: '0xrealsettle',
          created_at: '2026-07-23T04:33:00.000Z',
          amount: 10000,
          asset: 'USDC',
        },
        error: null,
      },
    ],
    erc8004_reputation_writes: [
      { count: 5, error: null },
      { data: { tx_hash: '0xfeedback', created_at: '2026-07-22T00:00:00.000Z' }, error: null },
    ],
    repid_zkp_proofs: [
      {
        data: {
          scheme: 'plonky3_range_check',
          proof_bytes: 'AAAA',
          eas_attestation_uid: '0xeas',
          // `is_real` and `zk_commitment` ADDED 2026-09-03. This fixture claims to be a MINTED
          // agent's proof and omitted both, so it did not satisfy the anchoring eligibility rule
          // it was standing in for. It passed anyway, because `deriveAnchorStatus` returned
          // ANCHORED on the uid before it looked at eligibility — a fixture that did not meet
          // its own description, green because the code never checked. Production has five rows
          // in exactly that shape; see `src/services/anchor-status.ts`.
          is_real: true,
          zk_commitment: '0xcommitment',
          created_at: '2026-07-01T00:00:00.000Z',
        },
        error: null,
      },
    ],
  };
}

/* --------------------------- service-level tests -------------------------- */

describe('buildAgentPassport', () => {
  test('a new agent\'s vacuous threshold is labelled, not presented as a cleared bar', async () => {
    // The state this exists for. The threshold IS the tier floor and the lowest tier's
    // floor is zero, so a probationary agent proves `score >= 0` — unfalsifiable, since
    // scores are clamped at 10. Measured 2026-09-03: a large minority of agents holding
    // a real proof are in exactly this position. The proof still binds the agent to an
    // exact score; what it does not do is discriminate, and the response has to say so.
    const script = happyScript();
    script.repid_zkp_proofs = [
      {
        data: {
          scheme: 'plonky3_range_check',
          proof_bytes: 'AAAA',
          eas_attestation_uid: '0xeas',
          is_real: true,
          zk_commitment: '0xcommitment',
          statement: { threshold: 0, repid_score: 200, tier: 'PROBATIONARY' },
          created_at: '2026-07-01T00:00:00.000Z',
        },
        error: null,
      },
    ];
    const p = await buildAgentPassport(makeDb(script), MINTED_AGENT.id);
    expect(p!.zkp.latest_proof!.claim.claim).toBe('VACUOUS');
    expect(p!.zkp.latest_proof!.claim.statement).toBe('score >= 0');
    // Still verifiable — a vacuous threshold is not a broken proof, and the response
    // must not imply it is.
    expect(p!.zkp.latest_proof!.cryptographically_verifiable).toBe(true);
  });

  test('a real threshold is reported as BINDING', async () => {
    const script = happyScript();
    script.repid_zkp_proofs = [
      {
        data: {
          scheme: 'plonky3_range_check',
          proof_bytes: 'AAAA',
          is_real: true,
          zk_commitment: '0xcommitment',
          statement: { threshold: 999, repid_score: 1772, tier: 'ESTABLISHED' },
          created_at: '2026-07-01T00:00:00.000Z',
        },
        error: null,
      },
    ];
    const p = await buildAgentPassport(makeDb(script), MINTED_AGENT.id);
    expect(p!.zkp.latest_proof!.claim.claim).toBe('BINDING');
    expect(p!.zkp.latest_proof!.claim.statement).toBe('score >= 999');
  });

  test('a held balance is reported, so an unmoved score is not read as nothing happening', async () => {
    // The MVP journey this protects: a stranger creates an agent, earns, and `current_repid`
    // does not move because the reward is vesting. The passport used to show only the unmoved
    // number. MATURED is the sharper case — measured 2026-09-03, nothing releases the balance
    // when the cliff ends, so a passed cliff is a real gap and must not read as a countdown.
    const script = happyScript();
    const past = new Date(Date.now() - 90 * 86_400_000).toISOString();
    script.repid_agents = script.repid_agents.map((r: any, i: number) =>
      i === 0 && r.data ? { ...r, data: { ...r.data, vested_repid: 500, vesting_cliff_ends_at: past } } : r,
    );
    const p = await buildAgentPassport(makeDb(script), MINTED_AGENT.id);
    expect(p!.reputation.vesting.state).toBe('MATURED');
    expect(p!.reputation.vesting.vested_repid).toBe(500);
    expect(p!.reputation.vesting.score_including_vested).toBe(p!.reputation.repid_score + 500);
    expect(p!.reputation.vesting.note.toLowerCase()).not.toMatch(/will be released/);
  });

  test('a real attestation over an ineligible proof does not read as ANCHORED', async () => {
    // The five production rows in this shape (real uid, `is_real = false`) previously reported
    // identically to a genuine anchored proof on the public passport. The uid stays visible and
    // `anchored` stays true — the attestation IS real — but the status now says what it is.
    const script = happyScript();
    script.repid_zkp_proofs = [
      {
        data: {
          scheme: 'plonky3_range_check',
          proof_bytes: 'AAAA',
          eas_attestation_uid: '0xeas',
          is_real: false,
          zk_commitment: '0xcommitment',
          created_at: '2026-07-01T00:00:00.000Z',
        },
        error: null,
      },
    ];
    const p = await buildAgentPassport(makeDb(script), MINTED_AGENT.id);
    expect(p!.zkp.latest_proof!.eas_attestation_uid).toBe('0xeas');
    expect(p!.zkp.latest_proof!.anchor_status).toBe('ANCHORED_INELIGIBLE');
    expect(p!.zkp.latest_proof!.anchor_note.toLowerCase()).toMatch(/did not meet/);
  });

  test('composes the honest passport for a minted agent', async () => {
    const p = await buildAgentPassport(makeDb(happyScript()), MINTED_AGENT.id);
    expect(p).not.toBeNull();

    expect(p!.agent.agent_id).toBe(MINTED_AGENT.id);
    // tier is passed through from the DB (trg_sync_tier is source of truth).
    expect(p!.reputation).toEqual({
      repid_score: 1390,
      tier: 'ESTABLISHED',
      activity_30d: 12,
      // This agent withholds nothing, so the block must say so rather than be absent —
      // a missing field and "nothing is withheld" are different claims, and the second
      // is the one a reader needs to distinguish an unmoved score from a held balance.
      vesting: {
        state: 'NONE',
        vested_repid: 0,
        cliff_ends_at: null,
        score_including_vested: 1390,
        note: expect.stringContaining('whole score'),
      },
    });

    expect(p!.identity_erc8004.registered_onchain).toBe('MINTED');
    expect(p!.identity_erc8004.token_id).toBe('5863');
    expect(p!.identity_erc8004.network).toBe('base-sepolia');
    expect(p!.identity_erc8004.mint_basescan_url).toBe(
      'https://sepolia.basescan.org/tx/0xminttx'
    );
    expect(p!.identity_erc8004.live_verification_endpoint).toBe(
      `/api/v1/agents/${MINTED_AGENT.id}/onchain`
    );

    expect(p!.payments_x402.real_settlements).toBe(7);
    expect(p!.payments_x402.simulated_settlements).toBe(3);
    expect(p!.payments_x402.last_real_settlement).toEqual({
      tx_hash: '0xrealsettle',
      basescan_url: 'https://sepolia.basescan.org/tx/0xrealsettle',
      amount_base_units: 10000,
      asset: 'USDC',
      at: '2026-07-23T04:33:00.000Z',
    });

    expect(p!.reputation_onchain.writes).toBe(5);
    expect(p!.reputation_onchain.last_write!.tx_hash).toBe('0xfeedback');

    expect(p!.zkp.latest_proof).toEqual({
      scheme: 'plonky3_range_check',
      cryptographically_verifiable: true,
      eas_attestation_uid: '0xeas',
      // An ELIGIBLE row with a uid is ANCHORED. (This comment used to read "whatever
      // the row's age" — see the ANCHORED_INELIGIBLE tests; eligibility is checked.)
      anchor_status: 'ANCHORED',
      anchor_note: expect.stringContaining('on-chain receipt'),
      created_at: '2026-07-01T00:00:00.000Z',
      // WHAT was proven, not merely that something verifies. The threshold was absent
      // from this response entirely until 2026-09-03, which left no way to tell a
      // cleared bar from one no score could trip on.
      claim: {
        threshold: null,
        statement: null,
        claim: 'UNKNOWN',
        note: expect.stringContaining('cannot say'),
      },
    });
    // D-019: the disclosure must scope the proof to a score range claim.
    expect(p!.zkp.disclosure).toMatch(/range proofs over the RepID score/);
    expect(p!.zkp.disclosure).toMatch(/do not yet bind agent execution/);
    // …and it must NOT claim score privacy. The gate MEASURED the score as a public circuit
    // input on 2026-08-30; this exact sentence said the opposite on the live passport, and the
    // same false claim was shipping in three other places (badge SVG, /meta/trust glossary,
    // the public receipt page). A claim removed in one surface reappears through the others
    // unless something fails, so this assertion is the thing that fails.
    expect(p!.zkp.disclosure).not.toMatch(/without revealing the score/i);
    expect(p!.zkp.disclosure).toMatch(/PUBLIC circuit inputs/);
  });

  test('never fabricates: unminted agent reads offchain-honest, empty history reads zero', async () => {
    const unminted = {
      ...MINTED_AGENT,
      erc8004_token_id: null,
      erc8004_address: null,
      mint_tx_hash: null,
      mint_chain_id: null,
      minted_at: null,
      conservator_address: null,
    };
    const script = {
      repid_agents: [{ data: unminted, error: null }],
      x402_settlements: [
        { count: 0, error: null },
        { count: 0, error: null },
        { data: null, error: null },
      ],
      erc8004_reputation_writes: [
        { count: 0, error: null },
        { data: null, error: null },
      ],
      repid_zkp_proofs: [{ data: null, error: null }],
    };
    const p = await buildAgentPassport(makeDb(script), MINTED_AGENT.id);

    expect(p!.identity_erc8004.registered_onchain).toBe('NOT_MINTED');
    expect(p!.identity_erc8004.token_id).toBeNull();
    expect(p!.identity_erc8004.mint_basescan_url).toBeNull();
    expect(p!.payments_x402.real_settlements).toBe(0);
    expect(p!.payments_x402.last_real_settlement).toBeNull();
    expect(p!.reputation_onchain.writes).toBe(0);
    expect(p!.reputation_onchain.last_write).toBeNull();
    expect(p!.zkp.latest_proof).toBeNull();

    // The old validate stub's fabricated fields must not exist anywhere.
    const flat = JSON.stringify(p);
    expect(flat).not.toContain('conservator_bonded');
    expect(flat).not.toContain('identity_hash');
    expect(flat).not.toContain('"verified"');
  });

  test('a stub/HMAC proof row is NOT labeled cryptographically verifiable', async () => {
    const script = happyScript();
    script.repid_zkp_proofs = [
      {
        data: {
          scheme: 'plonky3-babybear-stub-v1',
          proof_bytes: 'AAAA',
          eas_attestation_uid: null,
          created_at: '2026-06-01T00:00:00.000Z',
        },
        error: null,
      },
    ];
    const p = await buildAgentPassport(makeDb(script), MINTED_AGENT.id);
    expect(p!.zkp.latest_proof!.cryptographically_verifiable).toBe(false);
  });

  test('returns null for an unknown agent (UUID form)', async () => {
    const db = makeDb({ repid_agents: [{ data: null, error: null }] });
    expect(await buildAgentPassport(db, '99999999-9999-9999-9999-999999999999')).toBeNull();
  });

  test('resolves a numeric token id via erc8004_token_id', async () => {
    const p = await buildAgentPassport(makeDb(happyScript()), '5863');
    expect(p!.agent.agent_id).toBe(MINTED_AGENT.id);
  });

  test('resolves a bare slug via the trinity- prefix fallback', async () => {
    const script = happyScript();
    // exact-name lookup misses, trinity-prefixed lookup hits
    script.repid_agents = [
      { data: null, error: null },
      { data: MINTED_AGENT, error: null },
    ];
    const p = await buildAgentPassport(makeDb(script), 'shofet');
    expect(p!.agent.agent_id).toBe(MINTED_AGENT.id);
  });

  test('last-real-settlement query skips hash-less rows and pins nulls last', async () => {
    // Live-prod finding (trinity-shofet, 2026-07-30): 47 real settlements but
    // last_real_settlement=null, because the newest real row had a null
    // tx_hash and DESC sorts nulls first. Pin the query shape that fixes it.
    const calls: Array<{ method: string; args: any[] }> = [];
    const script = happyScript();
    let x402Query = 0;
    const db: any = {
      from: (table: string) => {
        const q = (script as any)[table];
        if (!q || q.length === 0) throw new Error(`unexpected query on ${table}`);
        const result = q.shift();
        if (table === 'x402_settlements') x402Query++;
        const chain: any = {};
        for (const m of ['select', 'eq', 'or', 'order', 'limit', 'not']) {
          chain[m] = (...args: any[]) => {
            if (table === 'x402_settlements' && x402Query === 3) calls.push({ method: m, args });
            return chain;
          };
        }
        chain.maybeSingle = () => Promise.resolve(result);
        chain.then = (onF: any, onR: any) => Promise.resolve(result).then(onF, onR);
        return chain;
      },
    };
    const p = await buildAgentPassport(db, MINTED_AGENT.id);
    expect(p!.payments_x402.last_real_settlement!.tx_hash).toBe('0xrealsettle');
    expect(calls).toContainEqual({ method: 'not', args: ['tx_hash', 'is', null] });
    expect(calls).toContainEqual({
      method: 'order',
      args: ['created_at', { ascending: false, nullsFirst: false }],
    });
  });

  test('fails loud with PassportQueryError when a sub-query errors', async () => {
    const script = happyScript();
    script.x402_settlements = [{ count: null, error: { message: 'boom' } }];
    await expect(
      buildAgentPassport(makeDb(script), MINTED_AGENT.id)
    ).rejects.toThrow(PassportQueryError);
  });
});

/* ---------------------------- route-level tests --------------------------- */

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/v1', agentPassportRouter);
  return app;
}

describe('GET /api/v1/passport/:agentId', () => {
  test('200 with the passport + cache header', async () => {
    (global as any).__passportDb = makeDb(happyScript());
    const res = await request(makeApp()).get(`/api/v1/passport/${MINTED_AGENT.id}`);
    expect(res.status).toBe(200);
    expect(res.body.passport_version).toBe('1');
    expect(res.body.identity_erc8004.registered_onchain).toBe('MINTED');
    expect(res.headers['cache-control']).toBe('public, max-age=30');
  });

  test('404 for an unknown agent', async () => {
    (global as any).__passportDb = makeDb({
      repid_agents: [{ data: null, error: null }],
    });
    const res = await request(makeApp()).get(
      '/api/v1/passport/99999999-9999-9999-9999-999999999999'
    );
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('agent_not_found');
  });

  test('500 query_failed (with the failing step) on a sub-query error', async () => {
    const script = happyScript();
    script.erc8004_reputation_writes = [{ count: null, error: { message: 'boom' } }];
    (global as any).__passportDb = makeDb(script);
    const res = await request(makeApp()).get(`/api/v1/passport/${MINTED_AGENT.id}`);
    expect(res.status).toBe(500);
    expect(res.body.error).toBe('query_failed');
    expect(res.body.step).toBe('reputation_writes_count');
  });
});
