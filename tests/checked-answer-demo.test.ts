/**
 * The checked-answer demo (scripts/demo/checked-answer-demo.ts): a panel opinion is not a check.
 *
 * Runs the demo's own `runDemo`, which calls the REAL panel aggregation (`factCheck`) and the REAL
 * answer-key grader. Faked edges only: `fetch` (the demo's own guard), the database client and the
 * provider-call log. All text is made up in the demo file. No network, no Supabase.
 *
 * No grader number is typed here: the expected score is whatever the real scorer returns.
 */
jest.mock('../src/db', () => {
  const g = global as any;
  g.__demoDbCalls = 0;
  const recorder: any = new Proxy(function () { /* callable */ }, {
    get: (_t, p) => (p === 'then' ? undefined : (g.__demoDbCalls += 1, recorder)),
    apply: () => (g.__demoDbCalls += 1, recorder),
  });
  return { db: recorder };
});
jest.mock('../src/billing/log-call', () => ({ logLlmCall: jest.fn(async () => undefined) }));

import { CASES, FIXTURE_ORIGIN, installFetchGuard, renderText, replyOf, runDemo, type DemoResult } from '../scripts/demo/checked-answer-demo';
import { SCORING_VERSIONS, parseKnownAnswer } from '../src/services/experimental-repid';
import { logLlmCall } from '../src/billing/log-call';

const G = global as any;
const fetchBefore = global.fetch;
let r: DemoResult;
const byId = (id: string) => r.cases.find((c) => c.id === id)!;

beforeAll(async () => { r = await runDemo(); });

describe('checked-answer demo', () => {
  test('the three cases give CORRECT, WRONG and NOT CHECKED, and the run is ok', () => {
    expect(r.cases.map((c) => [c.id, c.outcome])).toEqual([['A', 'CHECKED_CORRECT'], ['B', 'CHECKED_WRONG'], ['C', 'NOT_CHECKED']]);
    expect(r.ok).toBe(true);
    expect(r.cases.every((c) => c.repid_change === 0)).toBe(true);
  });

  test('case B: the panel calls the reply clean while the answer key says mismatch', () => {
    const b = byId('B');
    expect(b.panel.decision).toBe('clean');
    expect(b.panel.answers).toHaveLength(3);
    expect(b.panel.saw_task).toBe(false);
    expect(b.independent_check.result).toBe('mismatch');
    expect(b.outcome).toBe('CHECKED_WRONG');
  });

  test('case C: no key means NOT CHECKED, never a pass, whatever the panel thought', () => {
    const c = byId('C');
    expect(c.independent_check.key_available).toBe(false);
    expect(c.independent_check.result).toBe('none available');
    expect(c.independent_check.grader_score).toBeNull();
    expect(c.outcome).toBe('NOT_CHECKED');
    expect(renderText(r, 0)).toContain('Not a pass.');
  });

  test('an abstain is NOT CHECKED too, even with a key', async () => {
    const one = await runDemo([{ ...CASES[0]!, decision: 'abstain', expected: 'NOT_CHECKED' }]);
    expect(one.cases[0]!.outcome).toBe('NOT_CHECKED');
  });

  test('the grader result is what the real scorer returns for the same reply and key', () => {
    for (const c of CASES) {
      const content = { task_id: `demo-${c.id}`, case_id: `demo-case-${c.id}`, claimed_by: 'demo-ai', result: replyOf(c), expected: c.key ?? '' };
      expect(byId(c.id).independent_check.grader_score).toBe(SCORING_VERSIONS['ka-v2-precommitted']!.score(content));
      expect(parseKnownAnswer(content).decision).toBe(c.decision);
    }
    // Direction only, no size: right is above zero, wrong is below.
    expect(byId('A').independent_check.grader_score!).toBeGreaterThan(0);
    expect(byId('B').independent_check.grader_score!).toBeLessThan(0);
  });

  test('no database call, no provider-call log, no network outside the fixture', () => {
    expect(G.__demoDbCalls).toBe(0);
    expect(logLlmCall).not.toHaveBeenCalledWith(expect.objectContaining({ status: 'failed' }));
    expect(r.refused_network_calls).toBe(0);
    expect(r.fixture_panel_calls).toBe(9);
    expect(global.fetch).toBe(fetchBefore); // the guard is removed after the run
  });

  test('the fetch guard refuses every host but the fixture origin', async () => {
    const guard = installFetchGuard(() => 'TRUE');
    try {
      await expect(fetch('https://api.example.com/v1/chat/completions', { method: 'POST', body: '{}' })).rejects.toThrow(/network is off/);
      await expect(fetch('http://localhost:54321/rest/v1/x')).rejects.toThrow(/network is off/);
      expect(guard.refused).toBe(2);
      const res = await fetch(`${FIXTURE_ORIGIN}/v1/chat/completions`, { method: 'POST', body: JSON.stringify({ model: 'm' }) });
      expect(res.ok).toBe(true);
    } finally { guard.uninstall(); }
  });

  test('a wrong expectation makes the run not ok (this is what drives the exit code)', async () => {
    const flipped = await runDemo(CASES.map((c) => (c.id === 'B' ? { ...c, key: 'pass' as const } : c)));
    expect(flipped.cases.find((c) => c.id === 'B')!.outcome).toBe('CHECKED_CORRECT');
    expect(flipped.ok).toBe(false);
  });
});
