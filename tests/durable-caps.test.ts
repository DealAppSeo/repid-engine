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

import {
  ETHICS_FLOOR_USDC,
  computeEffectiveCap,
  resolveEffectiveCap,
  supabaseCapDataSource,
  applyDurableCapToDecision,
  canonicalTierForRepid,
  domainForTransactionType,
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
