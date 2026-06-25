/**
 * TrustRails guard() — packaged governance API (round 4 Phase 1).
 * Proves the public contract: guard(action) → { tier, verdict, reason, log } across
 * T0/T1/T2, the fail-safe, and the T1 adversarial-chamber outcomes.
 */
import { guard, isAllowed } from '../trustrails/guard';
import type { ChamberInputs } from '../trustrails/guard';
import type { ChamberParticipant, AdversarialObjection } from '../src/services/adversarial-router';

const proposer: ChamberParticipant = { agentId: 'p1', provider: 'anthropic', lineageProvider: 'anthropic' };
const adversaryDiverse: ChamberParticipant = { agentId: 'a1', provider: 'groq', lineageProvider: 'groq' };

function chamberFor(objection: AdversarialObjection, adversary = adversaryDiverse): ChamberInputs {
  return { actionClass: 'merge', proposer, adversary, objection };
}

describe('guard() — deterministic tiers', () => {
  it('T0 local write → ALLOW', () => {
    const r = guard({ kind: 'file_write', paths: ['scratch/x.md'], localOnly: true });
    expect(r.tier).toBe('T0');
    expect(r.verdict).toBe('ALLOW');
    expect(isAllowed(r)).toBe(true);
  });

  it('T2 DDL on migrations path → BLOCK + human sign-off', () => {
    const r = guard({ kind: 'db', sql: 'DROP TABLE x', paths: ['migrations/1.sql'] });
    expect(r.tier).toBe('T2');
    expect(r.verdict).toBe('BLOCK');
    expect(isAllowed(r)).toBe(false);
    expect(r.log.humanSignOffRequired).toBe(true);
    expect(r.log.rulesFired.map((x) => x.ruleId)).toEqual(expect.arrayContaining(['T2_DDL', 'T2_CRITICAL_PATH']));
  });

  it('T2 push to main → BLOCK', () => {
    const r = guard({ kind: 'git', git: { operation: 'push', targetRef: 'main' } });
    expect(r.verdict).toBe('BLOCK');
  });

  it('unmatched action → T2 fail-safe BLOCK (no fail-open)', () => {
    const r = guard({ kind: 'totally_unknown' });
    expect(r.tier).toBe('T2');
    expect(r.log.failSafe).toBe(true);
    expect(r.verdict).toBe('BLOCK');
  });
});

describe('guard() — T1 routing', () => {
  it('T1 with no chamber inputs → REVIEW (stopped, needs scrutiny)', () => {
    const r = guard({ kind: 'git', git: { operation: 'merge', targetRef: 'feat/x' } });
    expect(r.tier).toBe('T1');
    expect(r.verdict).toBe('REVIEW');
    expect(isAllowed(r)).toBe(false);
  });

  it('T1 + substantive VERIFIED objection → ESCALATE (chamber landed an attack)', () => {
    const objection: AdversarialObjection = {
      summary: 'this merge breaks the build per the cited CI run',
      citations: [{ kind: 'ci_run_id', value: '12345678' }],
    };
    const r = guard(
      { kind: 'git', git: { operation: 'merge', targetRef: 'feat/x' }, description: 'merge feature' },
      { chamber: chamberFor(objection) },
    );
    expect(r.tier).toBe('T1');
    expect(r.verdict).toBe('ESCALATE');
    expect(r.log.chamber?.objectionScore).toBe('substantive');
    expect(r.log.chamber?.outcome).toBe('escalate');
  });

  it('T1 + weak (short-summary) verified objection → PROCEED (survived scrutiny)', () => {
    const objection: AdversarialObjection = {
      summary: 'eh',
      citations: [{ kind: 'ci_run_id', value: '12345678' }],
    };
    const r = guard(
      { kind: 'git', git: { operation: 'merge', targetRef: 'feat/x' }, description: 'merge feature' },
      { chamber: chamberFor(objection) },
    );
    expect(r.verdict).toBe('PROCEED');
    expect(isAllowed(r)).toBe(true);
  });

  it('T1 + unverified objection → ESCALATE', () => {
    const objection: AdversarialObjection = {
      summary: 'this is bad but with no real evidence',
      citations: [{ kind: 'ci_run_id', value: 'not-a-real-id' }],
    };
    const r = guard(
      { kind: 'git', git: { operation: 'merge', targetRef: 'feat/x' } },
      { chamber: chamberFor(objection) },
    );
    expect(r.verdict).toBe('ESCALATE');
    expect(r.log.chamber?.objectionScore).toBe('unverified');
  });

  it('T1 + same-lineage adversary → ESCALATE (lineage violation caught, never crashes)', () => {
    const objection: AdversarialObjection = { summary: 'whatever', citations: [{ kind: 'ci_run_id', value: '12345678' }] };
    const sameLineage: ChamberParticipant = { agentId: 'a2', provider: 'anthropic', lineageProvider: 'anthropic' };
    const r = guard(
      { kind: 'git', git: { operation: 'merge', targetRef: 'feat/x' } },
      { chamber: chamberFor(objection, sameLineage) },
    );
    expect(r.verdict).toBe('ESCALATE');
    expect(r.reason).toMatch(/lineage/i);
  });

  it('T1 + adversary agrees action is wrong → REVIEW (tie-break, third lineage)', () => {
    const objection: AdversarialObjection = {
      summary: 'I agree this is wrong',
      citations: [{ kind: 'ci_run_id', value: '12345678' }],
      agreesActionIsWrong: true,
    };
    const r = guard(
      { kind: 'git', git: { operation: 'merge', targetRef: 'feat/x' } },
      { chamber: chamberFor(objection) },
    );
    expect(r.verdict).toBe('REVIEW');
    expect(r.log.chamber?.outcome).toBe('tie-break');
  });
});
