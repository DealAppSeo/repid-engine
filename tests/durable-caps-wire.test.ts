/**
 * Durable caps WIRE-IN — the branch exists in checkTransactionAuthority, is gated by
 * DURABLE_CAPS_ENABLED (default OFF), and fails closed when ON.
 *
 * A stub that is not wired gets no branch, so this drives the real x402 gate:
 *   - flag OFF  → decision unchanged, and durable_spend_caps is NEVER queried (inert)
 *   - flag ON, no caps row      → the authorized decision is DENIED (fail closed)
 *   - flag ON, caps table absent → DENIED with caps_table_absent (safe before the migration applies)
 *   - flag ON, signed row below the amount → DENIED (exceeds_durable_cap)
 *   - flag ON, signed row above the amount → still AUTHORIZED (cap permits, decision untouched)
 */

process.env['SUPABASE_URL'] = process.env['SUPABASE_URL'] || 'http://localhost:54321';
process.env['SUPABASE_SERVICE_KEY'] = process.env['SUPABASE_SERVICE_KEY'] || 'dummy';

jest.mock('../src/db', () => ({ db: { from: jest.fn() } }));

import { Wallet } from 'ethers';
import { db } from '../src/db';
import { checkTransactionAuthority } from '../src/services/x402-gate';
import { durableCapGrantMessage } from '../src/services/durable-caps';

const fromCalls: string[] = [];

/** A chainable, thenable Supabase-query stub. Every builder method returns the builder; awaiting the
 *  builder (or calling maybeSingle/single) yields `result`. */
function builder(result: any) {
  const b: any = {
    then: (res: any, rej: any) => Promise.resolve(result).then(res, rej),
  };
  for (const m of ['select', 'eq', 'in', 'gte', 'order', 'limit', 'insert', 'update', 'upsert']) {
    b[m] = jest.fn(() => b);
  }
  b.maybeSingle = jest.fn(async () => result);
  b.single = jest.fn(async () => result);
  return b;
}

/** An AUTONOMOUS agent (requires_stake false → stake_available = repid), so decideAuthority AUTHORIZES
 *  a small amount and the durable cap is the only thing that can then deny it. `id` is present because
 *  the domain-RepID lookup now resolves the slug → repid_agents.id → repid_score_events.agent_id. */
const AUTONOMOUS_AGENT = {
  id: '00000000-0000-0000-0000-0000000000a0',
  tier: 'AUTONOMOUS',
  current_repid: 6000,
  conservator_address: null,
};

/** Build a genuinely signed durable_spend_caps row for (trinity-auto, coding). The wire-in now
 *  verifies the signature cryptographically, so a real EOA signature over the canonical grant
 *  message is required — a placeholder like '0xdeadbeef' fails closed. */
async function signedCapsRow(ownerCeilingUsdc: number) {
  const wallet = Wallet.createRandom();
  const grant_nonce = 'wire-nonce-1';
  const message = durableCapGrantMessage({
    agentId: 'trinity-auto',
    domain: 'coding',
    ownerCeilingUsdc,
    ownerAddress: wallet.address,
    grantNonce: grant_nonce,
  });
  const owner_signature = await wallet.signMessage(message);
  return { owner_ceiling_usdc: ownerCeilingUsdc, owner_address: wallet.address, owner_signature, grant_nonce, active: true };
}

function installDb(capsResult: any, scoreEventsResult: any = { data: { repid_after: 6000, created_at: '2026-10-01T00:00:00Z' }, error: null }) {
  fromCalls.length = 0;
  (db.from as jest.Mock).mockImplementation((table: string) => {
    fromCalls.push(table);
    switch (table) {
      case 'repid_agents': return builder({ data: AUTONOMOUS_AGENT, error: null });
      case 'agent_stakes': return builder({ data: [], error: null });
      case 'sponsorship_records': return builder({ data: [], error: null });
      case 'x402_payment_gates': return builder({ data: [], error: null });
      case 'dispute_claims': return builder({ data: [], error: null });
      case 'durable_spend_caps': return builder(capsResult);
      case 'repid_score_events': return builder(scoreEventsResult);
      default: return builder({ data: null, error: null });
    }
  });
}

afterEach(() => {
  delete process.env['DURABLE_CAPS_ENABLED'];
  jest.clearAllMocks();
});

describe('durable caps wire-in — flag OFF is inert', () => {
  it('leaves the decision unchanged and never queries durable_spend_caps', async () => {
    delete process.env['DURABLE_CAPS_ENABLED'];
    installDb({ data: null, error: null });
    const r = await checkTransactionAuthority({ agent: 'trinity-auto', transaction_type: 'coding', amount: 50 });
    expect(r.authorized).toBe(true);
    expect(r.denial_reason).toBeNull();
    // Inert, not merely quiet: NONE of the durable-cap reads run when the flag is off.
    expect(fromCalls).not.toContain('durable_spend_caps');
    expect(fromCalls).not.toContain('repid_score_events');
  });
});

describe('durable caps wire-in — flag ON fails closed', () => {
  it('DENIES when there is no caps row (and proves the branch was reached)', async () => {
    process.env['DURABLE_CAPS_ENABLED'] = 'true';
    installDb({ data: null, error: null });
    const r = await checkTransactionAuthority({ agent: 'trinity-auto', transaction_type: 'coding', amount: 50 });
    expect(r.authorized).toBe(false);
    expect(r.denial_reason).toContain('durable_cap_refused');
    expect(r.denial_reason).toContain('no_cap_row');
    expect(fromCalls).toContain('durable_spend_caps'); // the branch actually ran
  });

  it('DENIES with caps_table_absent when the table does not exist yet (safe before migration)', async () => {
    process.env['DURABLE_CAPS_ENABLED'] = 'true';
    installDb({ data: null, error: { code: '42P01', message: 'relation "durable_spend_caps" does not exist' } });
    const r = await checkTransactionAuthority({ agent: 'trinity-auto', transaction_type: 'coding', amount: 50 });
    expect(r.authorized).toBe(false);
    expect(r.denial_reason).toContain('caps_table_absent');
  });

  it('DENIES an amount over a present, CRYPTOGRAPHICALLY VERIFIED owner ceiling', async () => {
    process.env['DURABLE_CAPS_ENABLED'] = 'true';
    installDb({ data: await signedCapsRow(10), error: null });
    const r = await checkTransactionAuthority({ agent: 'trinity-auto', transaction_type: 'coding', amount: 50 });
    expect(r.authorized).toBe(false);
    expect(r.denial_reason).toContain('exceeds_durable_cap');
  });

  it('DENIES a present but INVALID signature (verification is load-bearing end-to-end, fail closed)', async () => {
    process.env['DURABLE_CAPS_ENABLED'] = 'true';
    // A real owner_address, but a garbage signature that does not recover to it: not a grant.
    const row = await signedCapsRow(100);
    row.owner_signature = '0xdeadbeef';
    installDb({ data: row, error: null });
    const r = await checkTransactionAuthority({ agent: 'trinity-auto', transaction_type: 'coding', amount: 50 });
    expect(r.authorized).toBe(false);
    expect(r.denial_reason).toContain('durable_cap_refused');
    expect(r.denial_reason).toContain('cap_row_sig_');
  });

  it('still AUTHORIZES an amount under a present, verified owner ceiling (cap permits — decision untouched)', async () => {
    process.env['DURABLE_CAPS_ENABLED'] = 'true';
    installDb({ data: await signedCapsRow(100), error: null });
    const r = await checkTransactionAuthority({ agent: 'trinity-auto', transaction_type: 'coding', amount: 50 });
    expect(r.authorized).toBe(true);
    expect(r.denial_reason).toBeNull();
  });
});
