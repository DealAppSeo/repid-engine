/**
 * Durable per-domain spend cap — the min-of-four, fail closed, and the refuse that holds.
 *
 * Proves, with the pure core and injected sources (no database):
 *   - the effective cap is min(owner ceiling, stake, RepID-in-domain, ethics floor)
 *   - RepID can TIGHTEN the cap but can never RAISE it above the owner ceiling / stake
 *   - a coding-domain RepID never applies to a trade-domain cap
 *   - a missing caps row, a missing table, or any unreadable input fails CLOSED (refuse, cap 0)
 *   - the ethics floor cannot be exceeded, and cannot be disabled or raised by config
 *   - applying the cap to a spend decision can only TIGHTEN it, never widen it
 */

process.env['SUPABASE_URL'] = process.env['SUPABASE_URL'] || 'http://localhost:54321';
process.env['SUPABASE_SERVICE_KEY'] = process.env['SUPABASE_SERVICE_KEY'] || 'dummy';

import { Wallet } from 'ethers';
import {
  ETHICS_FLOOR_USDC,
  computeEffectiveCap,
  resolveEffectiveCap,
  supabaseCapDataSource,
  applyDurableCapToDecision,
  canonicalTierForRepid,
  domainForTransactionType,
  durableCapsEnabled,
  durableCapGrantMessage,
  type CapDataSource,
  type CapInput,
  type DomainRepid,
} from '../src/services/durable-caps';

const readable = (usdc: number): CapInput => ({ readable: true, usdc });
const unreadable = (reason: string): CapInput => ({ readable: false, reason });

/** A fake source. Each input is configured independently so a test can make exactly one unreadable. */
function fakeSource(cfg: {
  owner?: CapInput;
  stake?: CapInput;
  domainRepid?: (domain: string) => DomainRepid;
}): CapDataSource {
  return {
    ownerCeiling: async () => cfg.owner ?? readable(1000),
    stake: async () => cfg.stake ?? readable(1000),
    domainRepid: async (_agent, domain) =>
      cfg.domainRepid ? cfg.domainRepid(domain) : { readable: true, repid: 6000 },
  };
}

// A tier table for the resolver: high RepID → high USDC, so RepID only binds when it is genuinely low.
const tierLimitUsdc = (repid: number): number => {
  const tier = canonicalTierForRepid(repid);
  return { PROBATIONARY: 0, EARNING: 10, ESTABLISHED: 100, AUTONOMOUS: 1000, VETERAN: 5000 }[tier] ?? 0;
};

describe('computeEffectiveCap — min of the four', () => {
  it('is the minimum of owner, stake, repid-in-domain and the ethics floor', () => {
    const r = computeEffectiveCap({
      owner: readable(500),
      stake: readable(800),
      repidInDomain: readable(300),
      agentId: 'trinity-x',
      domain: 'coding',
    });
    expect(r.resolved).toBe(true);
    expect(r.effectiveCapUsdc).toBe(300); // repid-in-domain is the smallest
    expect(r.bindingTerm).toBe('repid_in_domain');
  });

  it('names the owner ceiling when it is the tightest', () => {
    const r = computeEffectiveCap({
      owner: readable(50),
      stake: readable(800),
      repidInDomain: readable(300),
      agentId: 'a',
      domain: 'd',
    });
    expect(r.effectiveCapUsdc).toBe(50);
    expect(r.bindingTerm).toBe('owner_ceiling');
  });
});

describe('RepID may TIGHTEN but can never RAISE the cap above owner / stake', () => {
  it('a low domain RepID tightens the cap below owner and stake', () => {
    const r = computeEffectiveCap({
      owner: readable(1000),
      stake: readable(1000),
      repidInDomain: readable(10), // EARNING-tier allowance
      agentId: 'a',
      domain: 'd',
    });
    expect(r.effectiveCapUsdc).toBe(10);
    expect(r.bindingTerm).toBe('repid_in_domain');
  });

  it('raising the domain RepID can NEVER push the effective cap above the owner ceiling', () => {
    const owner = readable(100);
    const stake = readable(100);
    const low = computeEffectiveCap({ owner, stake, repidInDomain: readable(100), agentId: 'a', domain: 'd' });
    const sky = computeEffectiveCap({ owner, stake, repidInDomain: readable(9_999_999), agentId: 'a', domain: 'd' });
    // Both clamp to the owner/stake ceiling of 100. A larger RepID input does not widen the result.
    expect(low.effectiveCapUsdc).toBe(100);
    expect(sky.effectiveCapUsdc).toBe(100);
    expect(sky.bindingTerm).toBe('owner_ceiling');
    expect(sky.effectiveCapUsdc).toBeLessThanOrEqual((owner as any).usdc);
  });
});

describe('domain-scoped RepID — a coding score does not apply to a trade cap', () => {
  const codingOnly = (domain: string): DomainRepid =>
    domain === 'coding' ? { readable: true, repid: 9000 } : { readable: false, reason: 'no_domain_repid' };

  it('resolves a cap for the domain the agent has RepID in', async () => {
    const r = await resolveEffectiveCap(
      { agentId: 'trinity-coder', domain: 'coding' },
      fakeSource({ owner: readable(5000), stake: readable(5000), domainRepid: codingOnly }),
      { tierLimitUsdc },
    );
    expect(r.resolved).toBe(true);
    expect(r.effectiveCapUsdc).toBe(5000); // VETERAN allowance for repid 9000, bound by owner/stake 5000
  });

  it('REFUSES a trade cap for an agent whose only RepID is in coding', async () => {
    const r = await resolveEffectiveCap(
      { agentId: 'trinity-coder', domain: 'trade' },
      fakeSource({ owner: readable(5000), stake: readable(5000), domainRepid: codingOnly }),
      { tierLimitUsdc },
    );
    expect(r.resolved).toBe(false);
    expect(r.effectiveCapUsdc).toBe(0);
    expect(r.bindingTerm).toBe('repid_in_domain');
    expect(r.refusalReason).toContain('no_domain_repid');
  });
});

describe('fail closed — missing row, missing table, unreadable input', () => {
  it('a missing caps row refuses (cap 0), it does not default high', () => {
    const r = computeEffectiveCap({
      owner: unreadable('no_cap_row'),
      stake: readable(1000),
      repidInDomain: readable(1000),
      agentId: 'a',
      domain: 'd',
    });
    expect(r.resolved).toBe(false);
    expect(r.effectiveCapUsdc).toBe(0);
    expect(r.bindingTerm).toBe('owner_ceiling');
    expect(r.refusalReason).toContain('no_cap_row');
  });

  it('an unreadable stake refuses', () => {
    const r = computeEffectiveCap({
      owner: readable(1000),
      stake: unreadable('stake_read_threw'),
      repidInDomain: readable(1000),
      agentId: 'a',
      domain: 'd',
    });
    expect(r.resolved).toBe(false);
    expect(r.bindingTerm).toBe('stake');
  });

  it('a malformed (negative / NaN) value is treated as unreadable, never clamped wide', () => {
    const neg = computeEffectiveCap({
      owner: { readable: true, usdc: -5 } as CapInput,
      stake: readable(1000),
      repidInDomain: readable(1000),
      agentId: 'a',
      domain: 'd',
    });
    expect(neg.resolved).toBe(false);
    expect(neg.refusalReason).toContain('owner_ceiling_malformed');

    const nan = computeEffectiveCap({
      owner: readable(1000),
      stake: { readable: true, usdc: Number.NaN } as CapInput,
      repidInDomain: readable(1000),
      agentId: 'a',
      domain: 'd',
    });
    expect(nan.resolved).toBe(false);
    expect(nan.refusalReason).toContain('stake_malformed');
  });

  it('supabaseCapDataSource reports a missing TABLE as unreadable (safe before the migration applies)', async () => {
    const fakeDb: any = {
      from: () => ({
        select: () => ({
          eq: () => ({
            eq: () => ({
              eq: () => ({
                maybeSingle: async () => ({ data: null, error: { code: '42P01', message: 'relation "durable_spend_caps" does not exist' } }),
              }),
            }),
          }),
        }),
      }),
    };
    const src = supabaseCapDataSource(fakeDb);
    const owner = await src.ownerCeiling('trinity-x', 'coding');
    expect(owner.readable).toBe(false);
    expect((owner as any).reason).toBe('caps_table_absent');
  });

  it('supabaseCapDataSource reports an unsigned caps row as unreadable (a ceiling with no signature is not a grant)', async () => {
    const fakeDb: any = {
      from: () => ({
        select: () => ({
          eq: () => ({
            eq: () => ({
              eq: () => ({
                maybeSingle: async () => ({ data: { owner_ceiling_usdc: 500, owner_signature: '', active: true }, error: null }),
              }),
            }),
          }),
        }),
      }),
    };
    const owner = await supabaseCapDataSource(fakeDb).ownerCeiling('trinity-x', 'coding');
    expect(owner.readable).toBe(false);
    expect((owner as any).reason).toBe('cap_row_unsigned');
  });

  it('resolveEffectiveCap fails closed when a loader throws', async () => {
    const throwingSource: CapDataSource = {
      ownerCeiling: async () => { throw new Error('db down'); },
      stake: async () => readable(1000),
      domainRepid: async () => ({ readable: true, repid: 6000 }),
    };
    const r = await resolveEffectiveCap({ agentId: 'a', domain: 'd' }, throwingSource, { tierLimitUsdc });
    expect(r.resolved).toBe(false);
    expect(r.bindingTerm).toBe('owner_ceiling');
  });

  it('a pre-resolved stake that is null/NaN is unreadable, not zero-that-passes', async () => {
    const r = await resolveEffectiveCap(
      { agentId: 'a', domain: 'coding' },
      fakeSource({ owner: readable(1000) }),
      { tierLimitUsdc, stakeUsdc: null },
    );
    expect(r.resolved).toBe(false);
    expect(r.bindingTerm).toBe('stake');
  });
});

describe('the ethics floor cannot be exceeded, disabled, or raised by config', () => {
  it('clamps the cap no matter how large the other three inputs are', () => {
    const r = computeEffectiveCap({
      owner: readable(1_000_000_000),
      stake: readable(1_000_000_000),
      repidInDomain: readable(1_000_000_000),
      agentId: 'a',
      domain: 'd',
    });
    expect(r.effectiveCapUsdc).toBe(ETHICS_FLOOR_USDC);
    expect(r.bindingTerm).toBe('ethics_floor');
  });

  it('is a fixed constant — no env var changes it', () => {
    expect(ETHICS_FLOOR_USDC).toBe(10_000);
    // Try to "disable" or "raise" it via the environment. It is a const, so these do nothing.
    process.env['ETHICS_FLOOR_USDC'] = '999999999';
    process.env['DURABLE_CAPS_ETHICS_FLOOR'] = '0';
    const r = computeEffectiveCap({
      owner: readable(1e9),
      stake: readable(1e9),
      repidInDomain: readable(1e9),
      agentId: 'a',
      domain: 'd',
    });
    expect(r.effectiveCapUsdc).toBe(10_000);
    delete process.env['ETHICS_FLOOR_USDC'];
    delete process.env['DURABLE_CAPS_ETHICS_FLOOR'];
  });

  it('computeEffectiveCap takes no parameter that could pass a higher floor', () => {
    // The only way to reach the floor value is the module constant; there is no input field for it.
    // Two independent huge-input calls both clamp to the same constant, so nothing in the call can
    // lift it.
    const a = computeEffectiveCap({ owner: readable(1e8), stake: readable(1e8), repidInDomain: readable(1e8), agentId: 'a', domain: 'd' });
    const b = computeEffectiveCap({ owner: readable(1e7), stake: readable(1e7), repidInDomain: readable(1e7), agentId: 'b', domain: 'e' });
    expect(a.effectiveCapUsdc).toBe(ETHICS_FLOOR_USDC);
    expect(b.effectiveCapUsdc).toBe(ETHICS_FLOOR_USDC);
  });
});

describe('applyDurableCapToDecision — can only tighten', () => {
  it('denies an amount over the resolved cap', () => {
    const cap = computeEffectiveCap({ owner: readable(100), stake: readable(100), repidInDomain: readable(100), agentId: 'a', domain: 'd' });
    const decision = { authorized: true, denial_reason: null as string | null };
    applyDurableCapToDecision(decision, 150, cap);
    expect(decision.authorized).toBe(false);
    expect(decision.denial_reason).toContain('exceeds_durable_cap');
  });

  it('denies on a refusal', () => {
    const cap = computeEffectiveCap({ owner: unreadable('no_cap_row'), stake: readable(100), repidInDomain: readable(100), agentId: 'a', domain: 'd' });
    const decision = { authorized: true, denial_reason: null as string | null };
    applyDurableCapToDecision(decision, 1, cap);
    expect(decision.authorized).toBe(false);
    expect(decision.denial_reason).toContain('durable_cap_refused');
  });

  it('NEVER turns a denial into an authorization, even when the cap would allow the amount', () => {
    const cap = computeEffectiveCap({ owner: readable(1000), stake: readable(1000), repidInDomain: readable(1000), agentId: 'a', domain: 'd' });
    const denied = { authorized: false, denial_reason: 'insufficient_stake' as string | null };
    applyDurableCapToDecision(denied, 1, cap); // amount well under the cap
    expect(denied.authorized).toBe(false);
    expect(denied.denial_reason).toBe('insufficient_stake'); // original reason preserved, not widened
  });

  it('leaves an authorized decision alone when the amount is under the cap', () => {
    const cap = computeEffectiveCap({ owner: readable(1000), stake: readable(1000), repidInDomain: readable(1000), agentId: 'a', domain: 'd' });
    const decision = { authorized: true, denial_reason: null as string | null };
    applyDurableCapToDecision(decision, 50, cap);
    expect(decision.authorized).toBe(true);
    expect(decision.denial_reason).toBeNull();
  });
});

describe('helpers', () => {
  it('canonicalTierForRepid matches the published 5-tier ladder', () => {
    expect(canonicalTierForRepid(0)).toBe('PROBATIONARY');
    expect(canonicalTierForRepid(499)).toBe('PROBATIONARY');
    expect(canonicalTierForRepid(500)).toBe('EARNING');
    expect(canonicalTierForRepid(1000)).toBe('ESTABLISHED');
    expect(canonicalTierForRepid(5000)).toBe('AUTONOMOUS');
    expect(canonicalTierForRepid(8000)).toBe('VETERAN');
    expect(canonicalTierForRepid(Number.NaN)).toBe('PROBATIONARY'); // fail closed on a bad score
  });

  it('domainForTransactionType is lowercased and never empty', () => {
    expect(domainForTransactionType('Trade')).toBe('trade');
    expect(domainForTransactionType('  CODING ')).toBe('coding');
    expect(domainForTransactionType(null)).toBe('unknown');
    expect(domainForTransactionType('')).toBe('unknown');
  });
});

// ──────────────────────────────────────────────────────────────────────────────────────────────
// BEFORE-ARMING FIX (1): the domain-RepID lookup resolves by the CORRECT key.
//
// repid_score_events.agent_id is a uuid FK to repid_agents.id; the resolver is handed the agent
// SLUG (agent_name). Querying agent_id by the slug matches nothing (or errors as an invalid uuid),
// so every domain RepID read failed closed and the cap refused EVERY spend. The fix resolves
// slug -> repid_agents.id first, then queries repid_score_events.agent_id by that uuid.
// ──────────────────────────────────────────────────────────────────────────────────────────────

/** A chainable Supabase-query stub, per table, that RECORDS every .eq(col,val) so a test can prove
 *  which key the query actually used. Awaiting the builder, or maybeSingle/single, yields the row. */
function recordingDbByTable(
  map: Record<string, any>,
  eqCalls: Record<string, Array<[string, unknown]>>,
): any {
  return {
    from: (table: string) => {
      const b: any = {};
      for (const m of ['select', 'order', 'limit']) b[m] = () => b;
      b.eq = (col: string, val: unknown) => {
        (eqCalls[table] ??= []).push([col, val]);
        return b;
      };
      const result = map[table] ?? { data: null, error: null };
      b.maybeSingle = async () => result;
      b.single = async () => result;
      b.then = (res: any, rej: any) => Promise.resolve(result).then(res, rej);
      return b;
    },
  };
}

describe('FIX 1 — domainRepid resolves the agent slug to its uuid before reading score events', () => {
  it('resolves a seeded domain RepID by the CORRECT key (slug -> repid_agents.id -> score_events.agent_id)', async () => {
    const eqCalls: Record<string, Array<[string, unknown]>> = {};
    const agentUuid = '11111111-2222-3333-4444-555555555555';
    const src = supabaseCapDataSource(
      recordingDbByTable(
        {
          repid_agents: { data: { id: agentUuid }, error: null },
          repid_score_events: { data: { repid_after: 7200, created_at: '2026-10-01T00:00:00Z' }, error: null },
        },
        eqCalls,
      ),
    );
    const r = await src.domainRepid('trinity-coder', 'coding');
    expect(r.readable).toBe(true);
    expect((r as any).repid).toBe(7200);

    // The slug was used to look up the agent row...
    expect(eqCalls['repid_agents']).toContainEqual(['agent_name', 'trinity-coder']);
    // ...and the score-events query used the RESOLVED UUID, never the slug. This is the whole bug.
    expect(eqCalls['repid_score_events']).toContainEqual(['agent_id', agentUuid]);
    expect(eqCalls['repid_score_events']).toContainEqual(['task_domain', 'coding']);
    expect(eqCalls['repid_score_events']).not.toContainEqual(['agent_id', 'trinity-coder']);
  });

  it('fail-closes with no_domain_repid when the agent resolves but has no RepID in that domain', async () => {
    const eqCalls: Record<string, Array<[string, unknown]>> = {};
    const src = supabaseCapDataSource(
      recordingDbByTable(
        {
          repid_agents: { data: { id: '11111111-2222-3333-4444-555555555555' }, error: null },
          repid_score_events: { data: null, error: null }, // genuinely no row for this (agent, domain)
        },
        eqCalls,
      ),
    );
    const r = await src.domainRepid('trinity-coder', 'trade');
    expect(r.readable).toBe(false);
    expect((r as any).reason).toBe('no_domain_repid');
  });

  it('fail-closes when the agent slug resolves to no agent at all (no permissive default)', async () => {
    const eqCalls: Record<string, Array<[string, unknown]>> = {};
    const src = supabaseCapDataSource(
      recordingDbByTable({ repid_agents: { data: null, error: null } }, eqCalls),
    );
    const r = await src.domainRepid('trinity-ghost', 'coding');
    expect(r.readable).toBe(false);
    // Never reaches the score-events query when the agent cannot be resolved.
    expect(eqCalls['repid_score_events']).toBeUndefined();
  });
});

// ──────────────────────────────────────────────────────────────────────────────────────────────
// BEFORE-ARMING FIX (2): owner_signature is VERIFIED cryptographically, not merely present.
//
// A ceiling row's signature is recovered (EIP-191 personal_sign, via wallet-signature.ts) and the
// signer must equal owner_address over the canonical grant message. A bad, mismatched, absent, or
// replayed-for-a-different-ceiling signature fails CLOSED. The offline jest signature chain treats
// every address as a plain EOA, so these run with no network.
// ──────────────────────────────────────────────────────────────────────────────────────────────

/** A caps-table stub returning one row from durable_spend_caps. */
function capsDb(row: any): any {
  return {
    from: () => {
      const b: any = {};
      for (const m of ['select', 'eq']) b[m] = () => b;
      b.maybeSingle = async () => ({ data: row, error: null });
      return b;
    },
  };
}

describe('FIX 2 — ownerCeiling verifies the signature cryptographically (fail closed)', () => {
  const AGENT = 'trinity-x';
  const DOMAIN = 'coding';
  const CEILING = 500;

  async function signedRow(
    wallet: Wallet,
    overrides: { ceiling?: number; nonce?: string | null } = {},
  ) {
    const ceiling = overrides.ceiling ?? CEILING;
    const nonce = overrides.nonce ?? 'nonce-1';
    const message = durableCapGrantMessage({
      agentId: AGENT,
      domain: DOMAIN,
      ownerCeilingUsdc: ceiling,
      ownerAddress: wallet.address,
      grantNonce: nonce,
    });
    const signature = await wallet.signMessage(message);
    return { owner_ceiling_usdc: ceiling, owner_address: wallet.address, owner_signature: signature, grant_nonce: nonce, active: true };
  }

  it('accepts a genuinely signed ceiling (signer == owner_address over the canonical message)', async () => {
    const wallet = Wallet.createRandom() as unknown as Wallet;
    const row = await signedRow(wallet);
    const owner = await supabaseCapDataSource(capsDb(row)).ownerCeiling(AGENT, DOMAIN);
    expect(owner.readable).toBe(true);
    expect((owner as any).usdc).toBe(CEILING);
  });

  it('REFUSES a signature from a different key (signer != owner_address)', async () => {
    const owner = Wallet.createRandom() as unknown as Wallet;
    const impostor = Wallet.createRandom() as unknown as Wallet;
    const row = await signedRow(owner);
    row.owner_address = impostor.address; // signed by `owner`, but the row claims `impostor` signed it
    const result = await supabaseCapDataSource(capsDb(row)).ownerCeiling(AGENT, DOMAIN);
    expect(result.readable).toBe(false);
    expect((result as any).reason).toContain('cap_row_sig_invalid');
  });

  it('REFUSES when the ceiling was tampered after signing (the amount is bound into the signature)', async () => {
    const wallet = Wallet.createRandom() as unknown as Wallet;
    const row = await signedRow(wallet, { ceiling: 500 });
    row.owner_ceiling_usdc = 5000; // raise the ceiling the row claims, keeping the 500-ceiling signature
    const result = await supabaseCapDataSource(capsDb(row)).ownerCeiling(AGENT, DOMAIN);
    expect(result.readable).toBe(false);
    expect((result as any).reason).toContain('cap_row_sig_invalid');
  });

  it('REFUSES a present-but-garbage signature (0xdeadbeef is no longer a grant)', async () => {
    const wallet = Wallet.createRandom() as unknown as Wallet;
    const row = await signedRow(wallet);
    row.owner_signature = '0xdeadbeef';
    const result = await supabaseCapDataSource(capsDb(row)).ownerCeiling(AGENT, DOMAIN);
    expect(result.readable).toBe(false);
    expect((result as any).reason).toContain('cap_row_sig_');
  });

  it('REFUSES a signed row with no owner_address to verify against', async () => {
    const wallet = Wallet.createRandom() as unknown as Wallet;
    const row = await signedRow(wallet);
    delete (row as any).owner_address;
    const result = await supabaseCapDataSource(capsDb(row)).ownerCeiling(AGENT, DOMAIN);
    expect(result.readable).toBe(false);
    expect((result as any).reason).toBe('cap_row_no_owner_address');
  });

  it('still REFUSES an unsigned row (empty signature) — presence is still required first', async () => {
    const wallet = Wallet.createRandom() as unknown as Wallet;
    const row = await signedRow(wallet);
    row.owner_signature = '';
    const result = await supabaseCapDataSource(capsDb(row)).ownerCeiling(AGENT, DOMAIN);
    expect(result.readable).toBe(false);
    expect((result as any).reason).toBe('cap_row_unsigned');
  });
});

// ──────────────────────────────────────────────────────────────────────────────────────────────
// BEFORE-ARMING SAFETY: the flag stays default-OFF and the feature is inert until armed.
// (The wire-in's inertness — that durable_spend_caps is never queried when OFF — is proven
// end-to-end through the x402 gate in durable-caps-wire.test.ts.)
// ──────────────────────────────────────────────────────────────────────────────────────────────

describe('FIX 3 — DURABLE_CAPS_ENABLED is default-OFF', () => {
  const prior = process.env['DURABLE_CAPS_ENABLED'];
  afterEach(() => {
    if (prior === undefined) delete process.env['DURABLE_CAPS_ENABLED'];
    else process.env['DURABLE_CAPS_ENABLED'] = prior;
  });

  it('is OFF when the env var is unset', () => {
    delete process.env['DURABLE_CAPS_ENABLED'];
    expect(durableCapsEnabled()).toBe(false);
  });

  it('is OFF for any value other than the exact string "true"', () => {
    for (const v of ['', '0', 'false', 'FALSE', 'yes', '1', 'on', 'TRUE ']) {
      process.env['DURABLE_CAPS_ENABLED'] = v;
      expect(durableCapsEnabled()).toBe(false);
    }
  });

  it('is ON only for "true" (case-insensitive) — so arming is a deliberate, explicit act', () => {
    for (const v of ['true', 'TRUE', 'True']) {
      process.env['DURABLE_CAPS_ENABLED'] = v;
      expect(durableCapsEnabled()).toBe(true);
    }
  });
});
