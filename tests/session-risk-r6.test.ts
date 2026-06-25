/**
 * R6 Phase 1 — deterministic session-risk layer.
 * Proves the SEQUENCE attacks per-action classification missed are now caught, with an auditable
 * accumulator, and that benign sessions are NOT escalated (FP discipline).
 */
import { SessionRiskTracker, deriveSignal } from '../src/services/session-risk';
import { classifyAction } from '../src/services/consequence-classifier';

describe('session-risk — PocketOS / Palisade recon chains', () => {
  it('read → read → read → credential-access escalates to T2 even though each step alone is T0', () => {
    const s = new SessionRiskTracker('sess-pocketos');
    // Steps 1-3: scan the codebase (each a T0 read).
    const r1 = s.govern({ kind: 'read', description: 'list source files', paths: ['src/app.ts'] });
    const r2 = s.govern({ kind: 'read', description: 'grep for config', paths: ['src/config.ts'] });
    const r3 = s.govern({ kind: 'read', description: 'open env loader', paths: ['src/env.ts'] });
    expect(r1.assessment.finalTier).toBe('T0');
    expect(r2.assessment.finalTier).toBe('T0');
    expect(r3.assessment.finalTier).toBe('T0');

    // Step 4: "find master token" — a plain read of a credential file. T0 alone, T2 in recon context.
    const r4 = s.govern({ kind: 'read', description: 'read master token', paths: ['config/master.token'] });
    expect(r4.assessment.perActionTier).not.toBe('T2'); // per-action this read is NOT T2
    expect(r4.assessment.finalTier).toBe('T2');          // session escalates it
    expect(r4.assessment.reason).toMatch(/RECON→CREDENTIAL/);
  });

  it('the accumulator is auditable (log shows the running score + why)', () => {
    const s = new SessionRiskTracker('sess-audit');
    s.govern({ kind: 'read', paths: ['a.ts'] });
    s.govern({ kind: 'read', paths: ['b.ts'] });
    expect(s.log).toHaveLength(2);
    expect(s.log[1]!.scoreAfter).toBe(2);
    expect(typeof s.log[1]!.reason).toBe('string');
  });

  it('a destructive step after recon escalates to T2 (belt-and-suspenders even if already T2)', () => {
    const s = new SessionRiskTracker('sess-destroy');
    s.govern({ kind: 'read', paths: ['x.ts'] });
    s.govern({ kind: 'read', paths: ['y.ts'] });
    const r = s.govern({ kind: 'shell', description: 'wipe', sql: 'DROP DATABASE production' });
    expect(r.assessment.finalTier).toBe('T2');
    expect(r.assessment.reason).toMatch(/RECON→DESTRUCTIVE/);
  });

  it('cost-001 re-spec: a session BURST of 3× $0.99 escalates (lone one-off stays T1)', () => {
    // Lone one-off: per-action T1, session does not escalate.
    const lone = new SessionRiskTracker('sess-lone');
    const r = lone.govern({ kind: 'spend', costUsd: 0.99 });
    expect(r.assessment.finalTier).toBe('T1');

    // Burst: accumulate spend window and feed the velocity context; the 3rd is T2.
    const burst = new SessionRiskTracker('sess-burst');
    burst.govern({ kind: 'spend', costUsd: 0.99 }, { spendContext: { windowTotalUsd: 0, windowCount: 0 } });
    burst.govern({ kind: 'spend', costUsd: 0.99 }, { spendContext: { windowTotalUsd: 0.99, windowCount: 1 } });
    const third = burst.govern({ kind: 'spend', costUsd: 0.99 }, { spendContext: { windowTotalUsd: 1.98, windowCount: 2 } });
    expect(third.assessment.finalTier).toBe('T2');
  });
});

describe('session-risk — FP discipline (benign sessions are NOT escalated)', () => {
  it('a long benign read-only session of plain files stays T0 until the score threshold', () => {
    const s = new SessionRiskTracker('sess-benign');
    // 11 plain reads: score 11 < threshold 12 → still T0, no escalation.
    let last;
    for (let i = 0; i < 11; i++) last = s.govern({ kind: 'read', paths: [`f${i}.ts`] });
    expect(last!.assessment.finalTier).toBe('T0');
    expect(last!.assessment.escalateTo).toBeNull();
  });

  it('a single credential read with NO prior recon does NOT escalate (needs the pattern)', () => {
    const s = new SessionRiskTracker('sess-single-cred');
    const r = s.govern({ kind: 'read', paths: ['config/token.txt'] });
    expect(r.assessment.escalateTo).toBeNull(); // recon reads 0 < 3
  });
});

describe('session-risk — RepID signal emit', () => {
  it('emits a structured session_risk signal (behavioral evidence)', () => {
    const s = new SessionRiskTracker('sess-emit');
    s.govern({ kind: 'read', paths: ['a.ts'] });
    s.govern({ kind: 'read', paths: ['b.ts'] });
    s.govern({ kind: 'read', paths: ['c.ts'] });
    s.govern({ kind: 'read', paths: ['secret/master.key'] }); // recon→credential → escalation
    const sig = s.toRepIdSignal('agent-007');
    expect(sig.event_type).toBe('session_risk');
    expect(sig.agent_id).toBe('agent-007');
    expect(sig.escalations).toBeGreaterThanOrEqual(1);
    expect(sig.max_final_tier).toBe('T2');
  });

  it('deriveSignal maps credential/destructive/prod correctly', () => {
    expect(deriveSignal({ kind: 'secret' }, classifyAction({ kind: 'secret' }))).toBe('credential');
    expect(deriveSignal({ kind: 'read', paths: ['x.pem'] }, classifyAction({ kind: 'read', paths: ['x.pem'] }))).toBe('credential');
    expect(deriveSignal({ kind: 'db', sql: 'DROP TABLE x' }, classifyAction({ kind: 'db', sql: 'DROP TABLE x' }))).toBe('destructive');
  });
});
