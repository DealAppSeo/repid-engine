/**
 * Pure-function coverage for principal-to-principal grants (G1-G8,
 * docs/policy/grants-authority.v0.md in trinity-ecosystem). Everything here is a decision
 * function with no database access, matching the split `agent-delegation.ts` already
 * established (pure `decideCoverage` vs DB-touching `recordDelegation`) — these run in any CI
 * without Supabase credentials.
 *
 * The DB-touching round trip (mintGrant -> listGrants -> revokeGrant against a live table) is
 * NOT re-proven here with mocks — see this PR's description for how it was verified directly
 * against the live `principal_grants` table via the Supabase SQL path instead of jest, the same
 * honesty split this repo's own CLAUDE.md already documents for `trinity-swarm-health.test.ts`.
 */
import { permits, isAttenuationOf, excess } from '../src/services/principal-capability';
import {
  type Caveat,
  evaluateCaveats,
  caveatsPermit,
  isCaveatAttenuationOf,
  caveatViolations,
} from '../src/services/principal-caveat';
import { effectiveAuthority, BUILDER_FLOOR, ANTI_WHALE_MULTIPLIER } from '../src/services/effective-authority';
import {
  decideMint,
  decideAuthorization,
  decideRevoke,
  isChainLive,
  MAX_GRANT_DEPTH,
  type GrantRow,
  type MintRequest,
} from '../src/services/principal-grants';

function grantRow(overrides: Partial<GrantRow> = {}): GrantRow {
  const now = Date.now();
  return {
    id: 'g-1',
    grantor_agent_id: 'pai-ceo',
    grantee_agent_id: 'agent-cfo',
    parent_grant_id: null,
    depth: 0,
    grant_class: 'spend',
    capabilities: ['pay:usdc'],
    caveats: [{ type: 'maxValue', asset: 'USDC', amount: 100 }],
    role: 'CFO',
    audit_for: null,
    not_before: new Date(now - 1000).toISOString(),
    expires_at: new Date(now + 60_000).toISOString(),
    revoked_at: null,
    revoked_by: null,
    mint_reason: 'test fixture',
    created_at: new Date(now - 1000).toISOString(),
    ...overrides,
  };
}

const MEASURED_AEFF = (aEff: number) =>
  ({ aEff, outcome: 'MEASURED' as const, bindingTerm: 'r_route' as const, detail: 'fixture', rRouteIsLedgerApproximation: true as const });
const NOT_CHECKED_AEFF = {
  aEff: null,
  outcome: 'NOT_CHECKED' as const,
  bindingTerm: null,
  detail: 'fixture: collateral unmeasured',
  rRouteIsLedgerApproximation: true as const,
};

describe('principal-capability (ported attenuation algebra)', () => {
  test('exact match permits', () => expect(permits('pay:usdc', 'pay:usdc')).toBe(true));
  test('wildcard segment permits deeper', () => expect(permits('pay:*', 'pay:usdc:mainnet')).toBe(true));
  test('wildcard is only a whole final segment', () => expect(permits('pay:usd*', 'pay:usdt')).toBe(false));
  test('more specific parent does not permit less specific child', () => expect(permits('pay:usdc:mainnet', 'pay:usdc')).toBe(false));
  test('isAttenuationOf: empty child set is a valid attenuation', () => expect(isAttenuationOf([], ['pay:usdc'])).toBe(true));
  test('isAttenuationOf: uncovered capability fails', () => expect(isAttenuationOf(['pay:usdt'], ['pay:usdc'])).toBe(false));
  test('excess reports what is not covered', () => expect(excess(['pay:usdc'], ['pay:usdc', 'audit:read'])).toEqual(['audit:read']));
});

describe('principal-caveat (ported)', () => {
  test('maxValue within cap verifies', () => {
    const r = evaluateCaveats([{ type: 'maxValue', asset: 'USDC', amount: 100 }], { value: { asset: 'USDC', amount: 50 } });
    expect(caveatsPermit(r)).toBe(true);
    expect(r[0]!.outcome).toBe('VERIFIED');
  });
  test('maxValue over cap fails', () => {
    const r = evaluateCaveats([{ type: 'maxValue', asset: 'USDC', amount: 100 }], { value: { asset: 'USDC', amount: 150 } });
    expect(caveatsPermit(r)).toBe(false);
  });
  test('dropping a caveat entirely is loosening, not attenuation', () => {
    const parent: Caveat[] = [{ type: 'maxValue', asset: 'USDC', amount: 100 }];
    expect(isCaveatAttenuationOf([], parent)).toBe(false);
    expect(caveatViolations([], parent)[0]).toMatch(/drops/);
  });
  test('tightening a caveat is a legal attenuation', () => {
    const parent: Caveat[] = [{ type: 'maxValue', asset: 'USDC', amount: 100 }];
    const child: Caveat[] = [{ type: 'maxValue', asset: 'USDC', amount: 10 }];
    expect(isCaveatAttenuationOf(child, parent)).toBe(true);
  });
  test('loosening a caveat is refused', () => {
    const parent: Caveat[] = [{ type: 'maxValue', asset: 'USDC', amount: 100 }];
    const child: Caveat[] = [{ type: 'maxValue', asset: 'USDC', amount: 1000 }];
    expect(isCaveatAttenuationOf(child, parent)).toBe(false);
  });
});

describe('effectiveAuthority (ported formula, ledger-approximated R_route)', () => {
  test('null collateral is NOT_CHECKED, not zero', () => {
    const r = effectiveAuthority({ rRoute: 1000, stakeUsd: null, builderScore: 1000 });
    expect(r.outcome).toBe('NOT_CHECKED');
    expect(r.aEff).toBeNull();
  });
  test('below builder floor is MEASURED zero', () => {
    const r = effectiveAuthority({ rRoute: 5000, stakeUsd: 1000, builderScore: BUILDER_FLOOR - 1 });
    expect(r.outcome).toBe('MEASURED');
    expect(r.aEff).toBe(0);
    expect(r.bindingTerm).toBe('builder_floor');
  });
  test('anti-whale sqrt term binds when stake is small relative to R_route', () => {
    const r = effectiveAuthority({ rRoute: 100000, stakeUsd: 100, builderScore: BUILDER_FLOOR });
    expect(r.aEff).toBeCloseTo(ANTI_WHALE_MULTIPLIER * Math.sqrt(100));
    expect(r.bindingTerm).toBe('anti_whale_sqrt_stake');
  });
  test('r_route binds when it is the smaller term', () => {
    const r = effectiveAuthority({ rRoute: 50, stakeUsd: 1_000_000, builderScore: BUILDER_FLOOR });
    expect(r.aEff).toBe(50);
    expect(r.bindingTerm).toBe('r_route');
  });
  test('every result is stamped as a ledger approximation of R_route', () => {
    expect(effectiveAuthority({ rRoute: 1, stakeUsd: 1, builderScore: BUILDER_FLOOR }).rRouteIsLedgerApproximation).toBe(true);
  });
});

describe('decideMint — G1, G2, G3, G4, G7', () => {
  const baseReq = (overrides: Partial<MintRequest> = {}): MintRequest => ({
    grantorAgentId: 'pai-ceo',
    granteeAgentId: 'agent-cfo',
    grantClass: 'spend',
    capabilities: ['pay:usdc'],
    caveats: [{ type: 'maxValue', asset: 'USDC', amount: 100 }],
    ttlSeconds: 3600,
    parent: null,
    ...overrides,
  });

  test('G1: refuses a never-expiring grant (ttlSeconds <= 0)', () => {
    const d = decideMint(baseReq({ ttlSeconds: 0 }), MEASURED_AEFF(1000));
    expect(d.allowed).toBe(false);
  });
  test('refuses a self-grant', () => {
    const d = decideMint(baseReq({ granteeAgentId: 'pai-ceo' }), MEASURED_AEFF(1000));
    expect(d.allowed).toBe(false);
  });
  test('G1: spend grant denied when grantor A_eff is NOT_CHECKED', () => {
    const d = decideMint(baseReq(), NOT_CHECKED_AEFF);
    expect(d.allowed).toBe(false);
    expect((d as any).reason).toMatch(/NOT_CHECKED/);
  });
  test('G1: spend grant denied when budget exceeds grantor A_eff', () => {
    const d = decideMint(baseReq({ caveats: [{ type: 'maxValue', asset: 'USDC', amount: 500 }] }), MEASURED_AEFF(100));
    expect(d.allowed).toBe(false);
  });
  test('G1: spend grant allowed when budget is within grantor A_eff', () => {
    const d = decideMint(baseReq({ caveats: [{ type: 'maxValue', asset: 'USDC', amount: 50 }] }), MEASURED_AEFF(100));
    expect(d.allowed).toBe(true);
  });
  test('spend grant requires a maxValue caveat', () => {
    const d = decideMint(baseReq({ caveats: [] }), MEASURED_AEFF(1000));
    expect(d.allowed).toBe(false);
  });
  test('hot routing requires A_eff >= 2000', () => {
    expect(decideMint(baseReq({ grantClass: 'hot', capabilities: ['route:hot'], caveats: [] }), MEASURED_AEFF(1999)).allowed).toBe(false);
    expect(decideMint(baseReq({ grantClass: 'hot', capabilities: ['route:hot'], caveats: [] }), MEASURED_AEFF(2000)).allowed).toBe(true);
  });
  test('warm routing requires A_eff >= 500', () => {
    expect(decideMint(baseReq({ grantClass: 'warm', capabilities: ['route:warm'], caveats: [] }), MEASURED_AEFF(499)).allowed).toBe(false);
    expect(decideMint(baseReq({ grantClass: 'warm', capabilities: ['route:warm'], caveats: [] }), MEASURED_AEFF(500)).allowed).toBe(true);
  });
  test('cold/auditor grant has no A_eff floor but requires auditFor != grantee (G7)', () => {
    const cold = baseReq({ grantClass: 'cold', capabilities: ['audit:read'], caveats: [], auditFor: 'agent-cfo' });
    expect(decideMint(cold, NOT_CHECKED_AEFF).allowed).toBe(false); // auditFor === grantee
    const ok = baseReq({ grantClass: 'cold', capabilities: ['audit:read'], caveats: [], auditFor: 'agent-cto' });
    expect(decideMint(ok, NOT_CHECKED_AEFF).allowed).toBe(true); // theta_cold = 0, unaffected by A_eff
  });
  test('cold grant with a non-read capability is refused (coarse checker_must_not_be_doer companion)', () => {
    const d = decideMint(baseReq({ grantClass: 'cold', capabilities: ['pay:usdc'], caveats: [], auditFor: 'agent-cto' }), NOT_CHECKED_AEFF);
    expect(d.allowed).toBe(false);
  });

  describe('against a parent grant', () => {
    // Long-lived on purpose: these fixtures test capability/budget/depth attenuation, not time
    // attenuation (that has its own dedicated test below) — a short parent expiry would trip
    // the time bound instead of the thing each test actually means to check.
    const farFuture = new Date(Date.now() + 24 * 3600_000).toISOString();
    const parent = grantRow({ id: 'parent-1', depth: 0, capabilities: ['pay:usdc'], caveats: [{ type: 'maxValue', asset: 'USDC', amount: 100 }], expires_at: farFuture });

    test('G2: child capability not covered by parent is refused', () => {
      const d = decideMint(baseReq({ capabilities: ['pay:usdt'], parent }), MEASURED_AEFF(1000));
      expect(d.allowed).toBe(false);
    });
    test('G2: child capability that narrows the parent is allowed', () => {
      const d = decideMint(baseReq({ capabilities: ['pay:usdc'], caveats: [{ type: 'maxValue', asset: 'USDC', amount: 10 }], parent }), MEASURED_AEFF(1000));
      expect(d.allowed).toBe(true);
    });
    test('G3: child budget exceeding the parent stated cap is refused even if grantor A_eff is high', () => {
      const d = decideMint(baseReq({ caveats: [{ type: 'maxValue', asset: 'USDC', amount: 500 }], parent }), MEASURED_AEFF(10000));
      expect(d.allowed).toBe(false);
    });
    test('dropping the parent maxValue caveat entirely is refused (loosening)', () => {
      const d = decideMint(baseReq({ caveats: [], capabilities: ['pay:usdc'], grantClass: 'hot', parent: grantRow({ grant_class: 'hot', caveats: [{ type: 'maxValue', asset: 'USDC', amount: 100 }] }) }), MEASURED_AEFF(10000));
      expect(d.allowed).toBe(false);
    });
    test('child expiry beyond the parent is refused', () => {
      const shortParent = grantRow({ expires_at: new Date(Date.now() + 10_000).toISOString() });
      const d = decideMint(baseReq({ ttlSeconds: 3600, parent: shortParent }), MEASURED_AEFF(1000));
      expect(d.allowed).toBe(false);
    });
    test('G4: depth beyond MAX_GRANT_DEPTH is refused', () => {
      const deepParent = grantRow({ depth: MAX_GRANT_DEPTH, expires_at: farFuture });
      const d = decideMint(baseReq({ parent: deepParent }), MEASURED_AEFF(1000));
      expect(d.allowed).toBe(false);
    });
    test('depth exactly at MAX_GRANT_DEPTH is the last one allowed', () => {
      const almostDeepParent = grantRow({ depth: MAX_GRANT_DEPTH - 1, caveats: [{ type: 'maxValue', asset: 'USDC', amount: 100 }], expires_at: farFuture });
      const d = decideMint(baseReq({ caveats: [{ type: 'maxValue', asset: 'USDC', amount: 10 }], parent: almostDeepParent }), MEASURED_AEFF(1000));
      expect(d.allowed).toBe(true);
      expect((d as any).depth).toBe(MAX_GRANT_DEPTH);
    });
  });
});

describe('isChainLive / decideAuthorization — G5', () => {
  test('a live, unexpired, unrevoked grant is live', () => {
    expect(isChainLive(grantRow(), []).live).toBe(true);
  });
  test('G5: an expired grant is deny, not soft-allow', () => {
    const expired = grantRow({ expires_at: new Date(Date.now() - 1000).toISOString() });
    const r = isChainLive(expired, []);
    expect(r.live).toBe(false);
    expect(r.reason).toMatch(/expired/);
  });
  test('a not-yet-valid grant (before notBefore) is not live', () => {
    const future = grantRow({ not_before: new Date(Date.now() + 60_000).toISOString(), expires_at: new Date(Date.now() + 120_000).toISOString() });
    expect(isChainLive(future, []).live).toBe(false);
  });
  test('a revoked grant is not live', () => {
    const revoked = grantRow({ revoked_at: new Date().toISOString(), revoked_by: 'pai-ceo' });
    expect(isChainLive(revoked, []).live).toBe(false);
  });
  test('a revoked ANCESTOR denies the whole chain even though the child row itself is untouched', () => {
    const child = grantRow({ id: 'child-1', parent_grant_id: 'parent-1', depth: 1 });
    const revokedParent = grantRow({ id: 'parent-1', revoked_at: new Date().toISOString(), revoked_by: 'root' });
    const r = isChainLive(child, [revokedParent]);
    expect(r.live).toBe(false);
    expect(r.reason).toMatch(/ancestor/);
  });
  test('an expired ancestor denies the whole chain', () => {
    const child = grantRow({ id: 'child-1', parent_grant_id: 'parent-1', depth: 1 });
    const expiredParent = grantRow({ id: 'parent-1', expires_at: new Date(Date.now() - 1000).toISOString() });
    expect(isChainLive(child, [expiredParent]).live).toBe(false);
  });

  test('decideAuthorization: FAILED (not a soft-allow) on an expired grant', () => {
    const expired = grantRow({ expires_at: new Date(Date.now() - 1000).toISOString() });
    const d = decideAuthorization(expired, [], 'pay:usdc', { value: { asset: 'USDC', amount: 10 } });
    expect(d.authorized).toBe(false);
    expect(d.outcome).toBe('FAILED');
  });
  test('decideAuthorization: FAILED when the requested capability is not covered', () => {
    const d = decideAuthorization(grantRow(), [], 'pay:eth', { value: { asset: 'ETH', amount: 1 } });
    expect(d.authorized).toBe(false);
  });
  test('decideAuthorization: authorized + MEASURED when live, covered, and caveats verify', () => {
    const d = decideAuthorization(grantRow(), [], 'pay:usdc', { value: { asset: 'USDC', amount: 10 } });
    expect(d.authorized).toBe(true);
    expect(d.outcome).toBe('MEASURED');
  });
  test('decideAuthorization: authorized but NOT_CHECKED when a caveat cannot be evaluated from this context', () => {
    const d = decideAuthorization(grantRow(), [], 'pay:usdc', {});
    expect(d.authorized).toBe(true);
    expect(d.outcome).toBe('NOT_CHECKED');
  });
});

describe('decideRevoke — G6: always allowed to the grantor, never to the grantee', () => {
  test('grantor may revoke', () => {
    expect(decideRevoke(grantRow(), 'pai-ceo').allowed).toBe(true);
  });
  test('grantee-initiated revoke is refused', () => {
    const d = decideRevoke(grantRow(), 'agent-cfo');
    expect(d.allowed).toBe(false);
  });
  test('a third party cannot revoke', () => {
    expect(decideRevoke(grantRow(), 'some-other-agent').allowed).toBe(false);
  });
  test('an already-revoked grant refuses a second revoke (idempotency guard)', () => {
    const revoked = grantRow({ revoked_at: new Date().toISOString(), revoked_by: 'pai-ceo' });
    expect(decideRevoke(revoked, 'pai-ceo').allowed).toBe(false);
  });
});
