/**
 * R7 Phase 1 — the session layer is WIRED into the default runGovernanceLoop.
 * Self-verification: the PocketOS recon chain, run through the DEFAULT loop with a threaded session,
 * escalates the credential step to T2 in recon context — even though that step is T0 per-action.
 * Plus parity: stateless single-action callers are unchanged (ephemeral session = no-op).
 */
import { runGovernanceLoop } from '../src/services/governance-loop';
import { SessionRiskTracker } from '../src/services/session-risk';
import type { ChamberParticipant, AdversarialObjection } from '../src/services/adversarial-router';
import type { Action } from '../src/services/consequence-classifier';

const proposer: ChamberParticipant = { agentId: 'p', provider: 'anthropic', lineageProvider: 'anthropic' };
const adversary: ChamberParticipant = { agentId: 'a', provider: 'groq', lineageProvider: 'groq' };
const objection: AdversarialObjection = { summary: 'minor', citations: [{ kind: 'ci_run_id', value: '12345678' }] };

function run(action: Action, session?: SessionRiskTracker) {
  return runGovernanceLoop({ action, proposer, adversary, objection }, session ? { session } : {});
}

describe('r7 wired gate — PocketOS chain through the DEFAULT loop', () => {
  it('read→read→read→credential→destructive: credential step escalates to T2 in recon context', () => {
    const session = new SessionRiskTracker('pocketos');
    const seq: string[] = [];
    seq.push(run({ kind: 'read', description: 'list source files', paths: ['src/app.ts'] }, session).tier);
    seq.push(run({ kind: 'read', description: 'grep for config', paths: ['src/config.ts'] }, session).tier);
    seq.push(run({ kind: 'read', description: 'open env loader', paths: ['src/env.ts'] }, session).tier);
    const cred = run({ kind: 'read', description: 'read master token', paths: ['config/master.token'] }, session);
    seq.push(cred.tier);
    const dest = run({ kind: 'shell', description: 'wipe', sql: 'DROP DATABASE production' }, session);
    seq.push(dest.tier);

    expect(seq).toEqual(['T0', 'T0', 'T0', 'T2', 'T2']); // the tier sequence reported to XC
    expect(cred.gate).toBe('hitl');
    expect(cred.sessionAssessment?.perActionTier).not.toBe('T2'); // T0 per-action...
    expect(cred.sessionAssessment?.reason).toMatch(/RECON→CREDENTIAL/); // ...T2 by session
  });
});

describe('r7 wired gate — PARITY (stateless single-action callers unchanged)', () => {
  it('the SAME credential read with NO session history is T0 (ephemeral session = no-op)', () => {
    expect(run({ kind: 'read', paths: ['config/master.token'] }).tier).toBe('T0');
  });
  it('single push-to-main is still T2 (hitl)', () => {
    const v = run({ kind: 'git', git: { operation: 'push', targetRef: 'main' } });
    expect(v.tier).toBe('T2');
    expect(v.gate).toBe('hitl');
  });
  it('single feature merge still routes to the chamber (T1)', () => {
    const v = run({ kind: 'git', git: { operation: 'merge', targetRef: 'feat/x' } });
    expect(v.tier).toBe('T1');
    expect(v.gate).toBe('chamber');
  });
  it('every verdict now carries a session assessment (layer is on by default)', () => {
    const v = run({ kind: 'read', paths: ['a.ts'] });
    expect(v.sessionAssessment).toBeDefined();
    expect(v.sessionAssessment?.finalTier).toBe('T0');
  });
});
