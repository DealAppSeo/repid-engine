/**
 * ROLES ARE CEILINGS. The property that matters is that naming one can never ADD anything.
 *
 * The failure this guards against is a role layer that reads as governance and acts as a
 * privilege source: name yourself CFO, receive spend authority. `principal-capability.ts`'s own
 * header calls that "a privilege-escalation primitive wearing a delegation costume". A ceiling
 * cannot do it by construction — it appears only on the narrowing side of an intersection — and
 * these tests hold that construction in place.
 *
 * The second property is honesty about the unknown. `principal_grants.role` is free text today
 * and live rows carry values like "Researcher / Data". An unrecognised string must be reported
 * as decorating rather than constraining — never silently treated as a ceiling (which would
 * refuse capabilities nobody meant to refuse) and never silently treated as permission (which
 * would be the fifth "looks like a control, isn't" in this codebase in one day).
 */
import {
  resolveRole,
  applyRoleCeiling,
  rolePermits,
  roleCatalog,
  ROLE_NAMES,
} from '../src/services/principal-roles';

describe('a role can only ever narrow — the escalation property', () => {
  it('naming CFO does not conjure spend authority out of an empty request', () => {
    // The whole hazard in one case: the role has pay:* in its ceiling, and that must NOT
    // become a grant. A ceiling bounds; it does not supply.
    const out = applyRoleCeiling([], 'cfo');
    expect(out.allowed).toEqual([]);
    expect(out.refused).toEqual([]);
  });

  it('a role never returns a capability that was not requested', () => {
    for (const role of ROLE_NAMES) {
      const out = applyRoleCeiling(['read:activity'], role);
      for (const cap of out.allowed) expect(['read:activity']).toContain(cap);
    }
  });

  it('CTO CANNOT CARRY SPEND — at any denomination, however it is asked for', () => {
    for (const asked of ['pay:usdc', 'pay:usdt', 'pay:eth', 'pay:*', 'pay:usdc:mainnet']) {
      const out = applyRoleCeiling([asked], 'cto');
      expect({ asked, allowed: out.allowed }).toEqual({ asked, allowed: [] });
      expect(out.refused).toEqual([asked]);
      expect(out.detail).toMatch(/NO SPEND/i);
    }
  });

  it('CMO cannot carry spend either', () => {
    const out = applyRoleCeiling(['pay:usdc'], 'cmo');
    expect(out.allowed).toEqual([]);
    expect(out.refused).toEqual(['pay:usdc']);
  });

  it('CFO may carry spend that was actually requested', () => {
    const out = applyRoleCeiling(['pay:usdc'], 'cfo');
    expect(out.allowed).toEqual(['pay:usdc']);
    expect(out.refused).toEqual([]);
  });

  it('CEO is NOT a root capability — a non-pay verb is still refused', () => {
    // A root `*` held by a running agent is the thing the algebra exists to prevent.
    const out = applyRoleCeiling(['pay:usdc', 'admin:everything'], 'ceo');
    expect(out.allowed).toEqual(['pay:usdc']);
    expect(out.refused).toEqual(['admin:everything']);
  });

  it('a mixed request is split, not wholly refused or wholly allowed', () => {
    const out = applyRoleCeiling(['pay:usdc', 'read:activity'], 'cfo');
    expect(out.allowed).toEqual(['pay:usdc']);
    expect(out.refused).toEqual(['read:activity']);
  });
});

describe('three states, because two would lie', () => {
  it('absent: unchanged behaviour, and says it constrains nothing', () => {
    for (const raw of [null, undefined, '', '   ']) {
      const r = resolveRole(raw);
      expect(r.status).toBe('ABSENT');
      expect(r.constrains).toBe(false);
    }
    expect(applyRoleCeiling(['pay:usdc'], null).allowed).toEqual(['pay:usdc']);
  });

  it('LABEL_ONLY passes the request through UNCHANGED and says so out loud', () => {
    // Both wrong answers are worth naming: treating it as a ceiling would refuse capabilities
    // nobody meant to refuse; treating it as permission would be an unenforced label read as
    // a control. It does neither, and the detail string tells the caller which.
    const out = applyRoleCeiling(['pay:usdc'], 'Researcher / Data');
    expect(out.allowed).toEqual(['pay:usdc']);
    expect(out.refused).toEqual([]);
    expect(out.resolution.status).toBe('LABEL_ONLY');
    expect(out.resolution.constrains).toBe(false);
    expect(out.detail).toMatch(/constrains nothing/i);
  });

  it('does NOT fuzzy-match — "treasurer" is not quietly a CFO', () => {
    const r = resolveRole('treasurer');
    expect(r.status).toBe('LABEL_ONLY');
    expect(applyRoleCeiling(['pay:usdc'], 'treasurer').allowed).toEqual(['pay:usdc']);
  });

  it('IS case- and whitespace-insensitive on the known names', () => {
    for (const raw of ['CTO', ' cto ', 'Cto']) {
      expect(resolveRole(raw).status).toBe('RECOGNIZED');
      expect(applyRoleCeiling(['pay:usdc'], raw).allowed).toEqual([]);
    }
  });
});

describe('rolePermits returns null, not true, when it has no opinion', () => {
  it('an unknown or absent role answers null — "no opinion" is not "permitted"', () => {
    expect(rolePermits(null, 'pay:usdc')).toBeNull();
    expect(rolePermits('treasurer', 'pay:usdc')).toBeNull();
  });

  it('a known role answers a real boolean', () => {
    expect(rolePermits('cfo', 'pay:usdc')).toBe(true);
    expect(rolePermits('cto', 'pay:usdc')).toBe(false);
  });
});

describe('the catalog is honest about itself', () => {
  it('every role carries a rationale a reader can argue with', () => {
    for (const d of roleCatalog()) {
      expect(d.rationale.length).toBeGreaterThan(20);
      expect(d.label.length).toBeGreaterThan(0);
    }
  });

  it('NO role holds the root capability', () => {
    // If this ever fails, the layer has become the escalation primitive it was written to avoid.
    for (const d of roleCatalog()) expect(d.ceiling).not.toContain('*');
  });
});

/**
 * THE SEAM. Everything above proves the ceiling module is right. None of it proves decideMint
 * USES it — and a control that is correct in its own module and dropped on the way to the caller
 * is the exact failure this codebase shipped and then found four times in one day.
 *
 * So this drives the real decision function with the same fixture shape the existing
 * principal-grants suite uses, rather than testing applyRoleCeiling twice.
 */
import { decideMint, type MintRequest } from '../src/services/principal-grants';
import type { EffectiveAuthority } from '../src/services/effective-authority';

const MEASURED_AEFF = (aEff: number): EffectiveAuthority => ({
  aEff, outcome: 'MEASURED', bindingTerm: 'r_route', detail: 'test', rRouteIsLedgerApproximation: false,
});
const NOT_CHECKED_SIG = { status: 'NOT_CHECKED', detail: 'no wallet on record' } as any;

const req = (o: Partial<MintRequest> = {}): MintRequest => ({
  grantorAgentId: 'pai-ceo',
  granteeAgentId: 'agent-worker',
  grantClass: 'spend',
  capabilities: ['pay:usdc'],
  caveats: [{ type: 'maxValue', asset: 'USDC', amount: 50 }],
  ttlSeconds: 3600,
  parent: null,
  ...o,
} as MintRequest);

describe('decideMint actually applies the role ceiling', () => {
  it('REFUSES a CTO grant carrying spend — the ceiling reaches the real decision', () => {
    const d = decideMint(req({ role: 'cto' } as any), MEASURED_AEFF(1000), NOT_CHECKED_SIG);
    expect(d.allowed).toBe(false);
    expect((d as any).reason).toMatch(/role ceiling refuses pay:usdc/);
    // The refusal must name the ROLE, not some later gate. A refusal whose reason points at the
    // wrong control is how the next reader loosens the wrong thing.
    expect((d as any).reason).toMatch(/NO SPEND/i);
  });

  it('ALLOWS the same grant as CFO — the ceiling narrows, it does not blanket-deny', () => {
    const d = decideMint(req({ role: 'cfo' } as any), MEASURED_AEFF(1000), NOT_CHECKED_SIG);
    expect(d.allowed).toBe(true);
  });

  it('a FREE-TEXT role still mints — live rows carry labels like "Researcher / Data"', () => {
    const d = decideMint(req({ role: 'Researcher / Data' } as any), MEASURED_AEFF(1000), NOT_CHECKED_SIG);
    expect(d.allowed).toBe(true);
  });

  it('no role at all is unchanged behaviour', () => {
    const d = decideMint(req(), MEASURED_AEFF(1000), NOT_CHECKED_SIG);
    expect(d.allowed).toBe(true);
  });

  it('the role refusal fires BEFORE the A_eff gate, so the reason names the role', () => {
    // Both would refuse this. The role must be the one that speaks, because it is the specific
    // reason — "your A_eff is too low" would send someone to top up collateral for a grant their
    // role can never carry at any balance.
    const d = decideMint(req({ role: 'cto' } as any), MEASURED_AEFF(0), NOT_CHECKED_SIG);
    expect(d.allowed).toBe(false);
    expect((d as any).reason).toMatch(/role ceiling/);
    expect((d as any).reason).not.toMatch(/A_eff/);
  });
});
