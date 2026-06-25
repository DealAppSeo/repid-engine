/**
 * TrustRails decision trace (round 4 Phase 3) — every gated action emits a structured,
 * locally-persisted record of WHY it was gated.
 */
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import { guard } from '../trustrails/guard';
import { fileTraceSink, readTraces } from '../trustrails/trace-sink';

function tmpTracePath(name: string): string {
  return path.join(os.tmpdir(), `trustrails-trace-${name}-${process.pid}.jsonl`);
}

describe('decision trace', () => {
  it('guard() returns a complete trace in result.log', () => {
    const r = guard({ kind: 'db', sql: 'TRUNCATE x', paths: ['migrations/x.sql'], description: 'wipe' });
    const t = r.log;
    expect(t.tier).toBe('T2');
    expect(t.verdict).toBe('BLOCK');
    expect(t.rulesFired.length).toBeGreaterThan(0);
    expect(t.action.kind).toBe('db');
    expect(typeof t.ts).toBe('string');
    expect(t.trustrailsVersion).toBeDefined();
  });

  it('the local file sink persists one JSON line per decision, readable back', () => {
    const p = tmpTracePath('sink');
    if (fs.existsSync(p)) fs.unlinkSync(p);
    const sink = fileTraceSink(p);

    guard({ kind: 'read' }, { sink });                                   // T0 ALLOW
    guard({ kind: 'git', git: { operation: 'push', targetRef: 'main' } }, { sink }); // T2 BLOCK

    const traces = readTraces(p);
    expect(traces).toHaveLength(2);
    expect(traces[0]!.verdict).toBe('ALLOW');
    expect(traces[1]!.verdict).toBe('BLOCK');
    expect(traces[1]!.rulesFired.map((x) => x.ruleId)).toContain('T2_PROTECTED_GIT');
    fs.unlinkSync(p);
  });

  it('a T1 chamber decision is captured in the trace', () => {
    const p = tmpTracePath('chamber');
    if (fs.existsSync(p)) fs.unlinkSync(p);
    guard(
      { kind: 'git', git: { operation: 'merge', targetRef: 'feat/x' }, description: 'merge feature branch' },
      {
        sink: fileTraceSink(p),
        chamber: {
          actionClass: 'merge',
          proposer: { agentId: 'p', provider: 'anthropic', lineageProvider: 'anthropic' },
          adversary: { agentId: 'a', provider: 'groq', lineageProvider: 'groq' },
          objection: { summary: 'breaks the build per CI run cited', citations: [{ kind: 'ci_run_id', value: '12345678' }] },
        },
      },
    );
    const [t] = readTraces(p);
    expect(t!.chamber).toBeDefined();
    expect(t!.chamber!.outcome).toBe('escalate');
    expect(t!.chamber!.verifiedCitations[0]!.verified).toBe(true);
    fs.unlinkSync(p);
  });

  it('a throwing sink never breaks the gate', () => {
    expect(() =>
      guard({ kind: 'read' }, { sink: () => { throw new Error('sink boom'); } }),
    ).not.toThrow();
  });
});
