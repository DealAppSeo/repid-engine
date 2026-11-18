import { mkdtempSync, readFileSync, rmSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { appendRow, readRows, routeLane, summarize, type LedgerRow } from '../src/orchestration/dispatch-ledger';

const row = (over: Partial<LedgerRow> = {}): LedgerRow => ({
  at: '2026-11-18T10:00:00Z', task_id: 't1', task_class: 'test-only', runner: 'groq-lane', model_version: 'm1', packet_version: '1',
  outcome: 'pass', verified_by: 'checker', duration_ms: 1000, cost_usd: 0, ...over,
});

describe('capability ledger', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'ledger-')); });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('appends rows and never rewrites earlier ones', () => {
    const f = join(dir, 'l.jsonl');
    appendRow(f, row());
    const before = readFileSync(f, 'utf8');
    appendRow(f, row({ task_id: 't2' }));
    expect(readFileSync(f, 'utf8').startsWith(before)).toBe(true);
    expect(readRows(f).rows.map((r) => r.task_id)).toEqual(['t1', 't2']);
  });

  it('refuses a malformed row, and a non-pass without a reason', () => {
    const f = join(dir, 'l.jsonl');
    expect(() => appendRow(f, row({ outcome: 'fail' }))).toThrow('failure_reason');
    expect(() => appendRow(f, row({ cost_usd: -1 }))).toThrow('cost_usd');
  });

  it('reports a corrupt line instead of dropping it silently', () => {
    const f = join(dir, 'l.jsonl');
    appendRow(f, row());
    appendFileSync(f, '{not json\n');
    expect(readRows(f)).toMatchObject({ malformed: [2] });
  });

  it('counts only independently verified passes', () => {
    const s = summarize([row(), row({ verified_by: 'groq-lane' }), row({ verified_by: null }), row({ outcome: 'fail', failure_reason: 'tsc', verified_by: 'checker' })]);
    expect(s).toHaveLength(1);
    expect(s[0]).toMatchObject({ n: 4, verified_passes: 1, verified_pass_rate: 0.25, top_failures: [{ reason: 'tsc', count: 1 }] });
  });

  it('keys by runner, model version and packet version', () => {
    expect(summarize([row(), row({ model_version: 'm2' }), row({ packet_version: '2' })])).toHaveLength(3);
  });

  it('median time and mean cost', () => {
    const s = summarize([row({ duration_ms: 1, cost_usd: 0.1 }), row({ duration_ms: 3, cost_usd: 0.3 }), row({ duration_ms: 100, cost_usd: 0.2 })])[0]!;
    expect(s.median_ms).toBe(3);
    expect(s.mean_cost_usd).toBeCloseTo(0.2);
  });

  it('says "no evidence" for a task class with n = 0, rather than guessing', () => {
    expect(routeLane([row()], 'refactor')).toEqual({ lane: null, reason: 'no evidence: n=0 for task class refactor' });
  });

  it('says so when lanes exist but none has demonstrated success', () => {
    const r = routeLane([row({ verified_by: 'groq-lane' }), row({ outcome: 'fail', failure_reason: 'x' })], 'test-only');
    expect(r.lane).toBeNull();
    expect(r.reason).toContain('no demonstrated success: n=2');
  });

  it('routes to the cheapest lane with demonstrated success', () => {
    const rows = [
      row({ runner: 'paid', cost_usd: 0.5 }),
      row({ runner: 'free', cost_usd: 0 }),
      row({ runner: 'free-unproven', cost_usd: 0, verified_by: null }),
    ];
    const r = routeLane(rows, 'test-only');
    expect(r.lane?.runner).toBe('free');
    expect(r.reason).toContain('cheapest proven lane');
  });
});
