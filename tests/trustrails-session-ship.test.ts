/**
 * Ship gate (0.7.0) — the packaged entry point catches the PocketOS chain.
 * This is the proof that the 7 rounds of hardening are now IN the installable package surface,
 * not just the repo's internal loop.
 */
import { SessionGuard } from '../trustrails/session-guard';
import { guard } from '../trustrails/guard';

describe('packaged SessionGuard — PocketOS recon chain', () => {
  it('read→read→read→credential escalates to BLOCK (T2) at the credential step', () => {
    const sg = new SessionGuard('pocketos-ship');
    const seq: string[] = [];
    seq.push(sg.guard({ kind: 'read', description: 'list source', paths: ['src/app.ts'] }).tier);
    seq.push(sg.guard({ kind: 'read', description: 'grep config', paths: ['src/config.ts'] }).tier);
    seq.push(sg.guard({ kind: 'read', description: 'open env loader', paths: ['src/env.ts'] }).tier);
    const cred = sg.guard({ kind: 'read', description: 'read master token', paths: ['config/master.token'] });
    seq.push(cred.tier);

    expect(seq).toEqual(['T0', 'T0', 'T0', 'T2']);
    expect(cred.verdict).toBe('BLOCK');
    expect(cred.perActionTier).not.toBe('T2'); // T0 per-action…
    expect(cred.sessionEscalated).toBe(true);  // …T2 by session
    expect(cred.sessionReason).toMatch(/RECON→CREDENTIAL/);
  });

  it('parity: the SAME credential read via the memoryless guard() is T0 (no false block)', () => {
    expect(guard({ kind: 'read', paths: ['config/master.token'] }).tier).toBe('T0');
  });

  it('packaged guard() still catches single-action T2 (hardened classifier is wired)', () => {
    expect(guard({ kind: 'read', sql: 'DROP TABLE x' }).verdict).toBe('BLOCK'); // r5: DDL in any kind
    expect(guard({ kind: 'git', git: { operation: 'push', targetRef: 'origin/main' } }).verdict).toBe('BLOCK'); // r5: ref canon
  });

  it('packaged guard() applies the r6 FP exemption (README.md write → ALLOW)', () => {
    expect(guard({ kind: 'file_write', paths: ['README.md'] }).verdict).toBe('ALLOW');
  });

  it('emits a session RepID signal from the package', () => {
    const sg = new SessionGuard('emit-ship');
    sg.guard({ kind: 'read', paths: ['a.ts'] });
    sg.guard({ kind: 'read', paths: ['b.ts'] });
    sg.guard({ kind: 'read', paths: ['c.ts'] });
    sg.guard({ kind: 'read', paths: ['secret/master.key'] });
    expect(sg.toRepIdSignal('agent-x').max_final_tier).toBe('T2');
  });
});
