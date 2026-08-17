/**
 * The shadow's two load-bearing properties:
 *   attenuation can only ever NARROW, and
 *   the shadow can never change the live decision.
 *
 * The second one is the reason the module exists, so it is asserted against the
 * real `checkTransactionAuthority` path rather than only against the pure
 * comparison — a shadow that is safe in isolation and unsafe when wired is the
 * failure mode worth catching (LESSONS 3: name the caller).
 */
/**
 * The db is mocked to FAIL, deliberately. The wiring test below asserts what
 * happens on the payment path when the owner lookup is broken, and an
 * unreachable database is the honest simulation of that. Mocking a working one
 * would test the mock.
 */
jest.mock('../src/db', () => ({
  db: {
    from() {
      throw new Error('db_unavailable_in_unit_test');
    },
  },
}));

import {
  attenuateCeiling,
  compareCeilings,
  observeOwnerCeiling,
  ownerCeilingShadowEnabled,
} from '../src/services/owner-ceiling-shadow';
import { reconcileOwner, type OwnerClaim, type SourceProbe } from '../src/services/agent-owner-resolver';

const ownerWithCap = (cap: number | null): SourceProbe => {
  const claim: OwnerClaim = {
    source: 'agent_delegations',
    assurance: 'attested_unverified',
    ownerKey: 'builder-1',
    ownerKeyKind: 'builder_id',
    capUsdcPerTx: cap,
    capUsdcTotal: null,
  };
  return { source: 'agent_delegations', status: 'claim', claim };
};

const resolved = (cap: number | null) => reconcileOwner([ownerWithCap(cap)], 'agent-uuid');
const noOwner = () => reconcileOwner([{ source: 'repid_agents.builder_id', status: 'empty' }], 'agent-uuid');
const unknownOwner = () =>
  reconcileOwner([{ source: 'agent_delegations', status: 'indeterminate', reason: 'ambiguous' }], 'agent-uuid');

describe('attenuateCeiling — narrowing only, in both directions', () => {
  it('an owner limit BELOW the tier ceiling binds', () => {
    expect(attenuateCeiling(100, 25)).toEqual({ ceiling: 25, narrowed: true, boundBy: 'owner_limit' });
  });

  it('an owner limit ABOVE the tier ceiling does NOT promote the agent', () => {
    expect(attenuateCeiling(100, 250_000)).toEqual({ ceiling: 100, narrowed: false, boundBy: 'agent_tier' });
  });

  it('no owner limit leaves the tier ceiling exactly as it was', () => {
    expect(attenuateCeiling(100, null)).toEqual({ ceiling: 100, narrowed: false, boundBy: 'agent_tier' });
    expect(attenuateCeiling(100, undefined).ceiling).toBe(100);
  });

  it('a malformed or negative limit fails CLOSED at zero, never open to the wider ceiling', () => {
    expect(attenuateCeiling(100, Number.NaN).ceiling).toBe(0);
    expect(attenuateCeiling(100, -5).ceiling).toBe(0);
  });

  it('is monotone: for any inputs the attenuated ceiling is never above the agent ceiling', () => {
    const ceilings = [0, 10, 100, 1000, 5000];
    const caps = [null, undefined, -1, 0, 1, 99.5, 100, 1e9, Number.NaN, Number.POSITIVE_INFINITY];
    for (const c of ceilings) {
      for (const cap of caps) {
        expect(attenuateCeiling(c, cap as number | null | undefined).ceiling).toBeLessThanOrEqual(c);
      }
    }
  });
});

describe('compareCeilings — the verdicts, and what must never be one', () => {
  const base = { agent: 'trinity-test', amount: 50, realAuthorized: true, realPerTxLimit: 100 };

  it('agrees when the owner is known and their limit does not bind', () => {
    const o = compareCeilings({ ...base, resolution: resolved(250_000) });
    expect(o.verdict).toBe('agree');
    expect(o.shadowAuthorized).toBe(true);
    expect(o.wouldDenyIfOwnerRequired).toBe(false);
  });

  it('reports shadow_stricter — and still leaves the real decision authorised', () => {
    const o = compareCeilings({ ...base, resolution: resolved(25) });
    expect(o.verdict).toBe('shadow_stricter');
    expect(o.shadowAuthorized).toBe(false);
    expect(o.realAuthorized).toBe(true);
  });

  it('never grants what the live gate refused — the shadow is a subset, never looser', () => {
    const o = compareCeilings({ ...base, realAuthorized: false, resolution: resolved(250_000) });
    expect(o.shadowAuthorized).toBe(false);
  });

  it('keeps no_owner and owner_unknown apart, and counts both as the cost of enforcement', () => {
    const none = compareCeilings({ ...base, resolution: noOwner() });
    const unknown = compareCeilings({ ...base, resolution: unknownOwner() });
    expect(none.verdict).toBe('no_owner');
    expect(unknown.verdict).toBe('owner_unknown');
    expect(none.verdict).not.toBe(unknown.verdict);
    expect(none.wouldDenyIfOwnerRequired).toBe(true);
    expect(unknown.wouldDenyIfOwnerRequired).toBe(true);
  });

  it('does not charge enforcement for a transaction the gate already denied', () => {
    const o = compareCeilings({ ...base, realAuthorized: false, resolution: noOwner() });
    expect(o.wouldDenyIfOwnerRequired).toBe(false);
  });
});

describe('wiring — inert by default, and harmless when it fails', () => {
  const flag = process.env['OWNER_CEILING_SHADOW_ENABLED'];
  afterEach(() => {
    if (flag === undefined) delete process.env['OWNER_CEILING_SHADOW_ENABLED'];
    else process.env['OWNER_CEILING_SHADOW_ENABLED'] = flag;
  });

  it('is OFF unless explicitly enabled', () => {
    delete process.env['OWNER_CEILING_SHADOW_ENABLED'];
    expect(ownerCeilingShadowEnabled()).toBe(false);
    process.env['OWNER_CEILING_SHADOW_ENABLED'] = 'true';
    expect(ownerCeilingShadowEnabled()).toBe(true);
  });

  it('reads nothing and writes nothing while disabled, and says so rather than reporting agreement', async () => {
    delete process.env['OWNER_CEILING_SHADOW_ENABLED'];
    const o = await observeOwnerCeiling({
      agent: 'trinity-test',
      amount: 10,
      decision: { authorized: true, per_tx_limit: 100 },
    });
    expect(o.verdict).toBe('disabled');
    // The distinction that matters: 'disabled' must not be mistaken for 'agree'.
    expect(o.verdict).not.toBe('agree');
    expect(o.ownerStatus).toBeNull();
  });

  it('turns a broken owner lookup into owner_unknown, never into an exception or a false no_owner', async () => {
    process.env['OWNER_CEILING_SHADOW_ENABLED'] = 'true';
    const o = await observeOwnerCeiling({
      agent: 'trinity-test',
      amount: 10,
      decision: { authorized: true, per_tx_limit: 100 },
    });
    expect(o.verdict).toBe('owner_unknown');
    expect(o.verdict).not.toBe('no_owner');
    // The live decision is carried through untouched — that is the whole contract.
    expect(o.realAuthorized).toBe(true);
    expect(o.realPerTxLimit).toBe(100);
  });
});
