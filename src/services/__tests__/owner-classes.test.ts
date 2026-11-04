/**
 * owner-classes.test.ts — designation labels experimental independence but can NEVER be mistaken for verified,
 * and a real same-owner pair is never laundered into independent. Pure; the guardrail is the headline.
 */
import {
  designatedOwnerForSquad,
  assessIndependence,
  type IndependenceAssurance,
} from '../owner-classes';
import type { PartyIndependence } from '../../scoring/grounding';

const ORCH = '550e8400-e29b-41d4-a716-446655440004'; // Sean, real
const ALPHA = '550e8400-e29b-41d4-a716-446655440001'; // Matthew, designated
const BETA = '550e8400-e29b-41d4-a716-446655440002'; // Mark, designated

describe('designatedOwnerForSquad', () => {
  it('maps Orchestration to Sean (real) and Alpha to Matthew (designated)', () => {
    expect(designatedOwnerForSquad(ORCH)).toEqual({ principal: 'owner:sean', kind: 'real', squad: 'orchestration' });
    expect(designatedOwnerForSquad(ALPHA)).toEqual({ principal: 'owner:matthew', kind: 'designated', squad: 'alpha' });
  });

  it('returns null for an unknown or unset squad (no designation — fail closed)', () => {
    expect(designatedOwnerForSquad(null)).toBeNull();
    expect(designatedOwnerForSquad(undefined)).toBeNull();
    expect(designatedOwnerForSquad('not-a-squad')).toBeNull();
  });
});

describe('assessIndependence — evidence always wins', () => {
  it('real independence is the ONLY source of verified', () => {
    const d = assessIndependence('independent', { squadId: ALPHA }, { squadId: BETA });
    expect(d).toEqual({ independent: true, assurance: 'verified', reason: 'evidence_distinct_owner' });
  });

  it('a real same-owner pair is NEVER laundered into independent by a squad split (the guardrail)', () => {
    const d = assessIndependence('same_owner', { squadId: ALPHA }, { squadId: BETA });
    expect(d.independent).toBe(false);
    expect(d.assurance).toBe('none');
    expect(d.reason).toBe('same_real_owner');
  });

  it('owner_unknown + two different designated squads → independent, tagged designated', () => {
    const d = assessIndependence('owner_unknown', { squadId: ALPHA }, { squadId: BETA });
    expect(d.independent).toBe(true);
    expect(d.assurance).toBe('designated');
    expect(d.reason).toContain('distinct_designated_owner');
  });

  it('kind:real on one side does NOT upgrade a designated verdict to verified', () => {
    const d = assessIndependence('owner_unknown', { squadId: ORCH }, { squadId: ALPHA });
    expect(d.independent).toBe(true);
    expect(d.assurance).toBe('designated'); // Sean(real) vs Matthew(designated) is still only designated
  });

  it('owner_unknown + same squad → not independent', () => {
    const d = assessIndependence('owner_unknown', { squadId: ALPHA }, { squadId: ALPHA });
    expect(d).toEqual({ independent: false, assurance: 'none', reason: 'same_designated_owner' });
  });

  it('owner_unknown + an undesignated squad → not independent', () => {
    const d = assessIndependence('owner_unknown', { squadId: ALPHA }, { squadId: null });
    expect(d).toEqual({ independent: false, assurance: 'none', reason: 'owner_unknown_undesignated' });
  });

  it('PROPERTY: assurance is never "verified" unless the evidence verdict is "independent"', () => {
    const reals: PartyIndependence[] = ['same_owner', 'owner_unknown'];
    const squads = [ORCH, ALPHA, BETA, null];
    for (const real of reals) {
      for (const sa of squads) {
        for (const sb of squads) {
          const got: IndependenceAssurance = assessIndependence(real, { squadId: sa }, { squadId: sb }).assurance;
          expect(got).not.toBe('verified');
        }
      }
    }
  });
});
