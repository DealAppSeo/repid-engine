/**
 * wave-admission.test.ts — the wave seam is INERT by default (shadow never blocks a claim, only records), and
 * only 'enforce' turns an abstention into a blocked claim. The record carries the manifest / the named gap so it
 * can be persisted on the task's evidence. The three real 2026-11-03 fabrications are the headline measurement.
 */
import { waveAdmission } from '../wave-admission';
import { ALL_CAPABILITIES, type Capability, type TaskDescriptor } from '../task-admission';

const task = (prompt: string, task_domain?: string): TaskDescriptor => ({ prompt, task_domain });

const REAL: Array<{ name: string; t: TaskDescriptor; missing: Capability[] }> = [
  { name: 'SY-15 security audit', t: task('SY-15 Security Audit. Review the config loader and HAL verifier at src/hal/verifier.js.', 'security_audit'), missing: ['repo_read', 'code_search'] },
  { name: 'disclosure audit', t: task('Audit whether there are any public disclosures of the repid-engine repository.', 'disclosure'), missing: ['web_search', 'github'] },
  { name: 'prior-art search', t: task('Conduct a prior-art search over patents and literature for the mechanism.', 'prior_art'), missing: ['web_search'] },
];

describe('waveAdmission — shadow is inert, enforce blocks, the record is persistable', () => {
  it('shadow (default) NEVER blocks a claim, even when the agent would abstain', () => {
    const r = waveAdmission({ task: REAL[0]!.t, held: [] });
    expect(r.mode).toBe('shadow');
    expect(r.claimAllowed).toBe(true);        // inert: the wave is unchanged
    expect(r.record.accepted).toBe(false);    // but we RECORD that it would have abstained
    expect(r.record.missing.sort()).toEqual([...REAL[0]!.missing].sort());
  });

  it('enforce turns an abstention into a blocked claim', () => {
    const r = waveAdmission({ task: REAL[0]!.t, held: [], mode: 'enforce' });
    expect(r.claimAllowed).toBe(false);
    expect(r.decision.reason).toContain('abstain, do not fabricate');
  });

  it('an equipped agent is allowed and the record carries the equipped manifest (both modes)', () => {
    for (const mode of ['shadow', 'enforce'] as const) {
      const r = waveAdmission({ task: REAL[1]!.t, held: ALL_CAPABILITIES, mode });
      expect(r.claimAllowed).toBe(true);
      expect(r.record.accepted).toBe(true);
      expect(r.record.manifest).toEqual(r.record.required);
      expect(r.record.missing).toEqual([]);
    }
  });

  it('a task needing nothing is allowed by an empty tool-belt, manifest empty', () => {
    const r = waveAdmission({ task: task('Summarize the tradeoffs.'), held: [], mode: 'enforce' });
    expect(r.claimAllowed).toBe(true);
    expect(r.record).toEqual({ required: [], manifest: [], missing: [], accepted: true });
  });

  it('MEASURE: the three real fabrications — shadow records abstention (no block); enforce would block', () => {
    let wouldAbstain = 0, enforceBlocks = 0, equippedAllowed = 0;
    for (const { t, missing } of REAL) {
      const shadow = waveAdmission({ task: t, held: [] });
      expect(shadow.claimAllowed).toBe(true);              // shadow changes nothing
      if (!shadow.record.accepted) wouldAbstain++;         // ...but records the would-be abstention
      expect(shadow.record.missing.sort()).toEqual([...missing].sort());

      const enforce = waveAdmission({ task: t, held: [], mode: 'enforce' });
      if (!enforce.claimAllowed) enforceBlocks++;

      const equipped = waveAdmission({ task: t, held: ALL_CAPABILITIES, mode: 'enforce' });
      if (equipped.claimAllowed) equippedAllowed++;
    }
    expect(wouldAbstain).toBe(REAL.length);     // 3/3 would abstain unequipped
    expect(enforceBlocks).toBe(REAL.length);    // 3/3 blocked under enforce
    expect(equippedAllowed).toBe(REAL.length);  // 3/3 allowed when equipped
  });
});
