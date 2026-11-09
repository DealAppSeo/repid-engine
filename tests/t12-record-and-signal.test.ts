/** The daily work record and the missed-run signal. Pure logic; no database and no network. */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildDailyRecord } from '../src/orchestration/t12-daily-record';
import { judgeRuns, type RunRow } from '../src/orchestration/t12-missed-run';
import type { DecisionReceipt, LaneState } from '../src/orchestration/t12-lane-store';

const receipt = (event: string, at: string, evidence: unknown = {}, reason = ''): DecisionReceipt => ({ seq: 0, at, actor: 'trinity-lane-1', origin: 'scheduled', event, from: 'a', to: 'b', epoch: 1, reason, evidence, prev: '0', hash: `h-${event}` });
const row = (id: string, receipts: DecisionReceipt[]) => ({ state: { spec: { id }, receipts } as unknown as LaneState });
const DAY = '2026-11-09';
const at = `${DAY}T03:00:00.000Z`;

describe('daily record', () => {
  it('counts the work from receipts', () => {
    const r = buildDailyRecord([
      row('a', [receipt('claimed', at), receipt('belt_checked_out', at), receipt('route_attempt', at, { provider: 'groq', status: 200 }), receipt('stage_claimed', at), receipt('check_approved', at, { commit: 'abc', exit: 0, controls: [{}, {}] }), receipt('integrated', at)]),
      row('b', [receipt('claimed', at), receipt('lease_reaped', at), receipt('route_attempt', at, { provider: 'groq', status: 429 }), receipt('check_rejected', at, {}, 'wrote outside its lease')]),
    ], DAY, 'synthetic');
    expect(r.tasks).toMatchObject({ attempted: 2, accepted: 1, rejected: 1, integrated: 1 });
    expect(r.leases).toMatchObject({ claims: 2, stage_claims: 1, expired_and_recovered: 1 });
    expect(r.belts.checked_out).toBe(1);
    expect(r.providers).toEqual([expect.objectContaining({ host: 'groq', attempts: 2, answered: 1, rate_limited: 1 })]);
    expect(r.tests[0]).toMatchObject({ task: 'a', verdict: 'approved', exit: 0, controls: 2 });
    expect(r.tests[1]).toMatchObject({ task: 'b', verdict: 'rejected', reason: 'wrote outside its lease' });
  });

  it('never calls usage free without provider-side evidence', () => {
    const rows = [row('a', [receipt('route_attempt', at, { provider: 'groq', status: 200 })])];
    expect(buildDailyRecord(rows, DAY, 'real').providers[0]).toMatchObject({ verified_free: null, free_basis: expect.stringContaining('NOT_CHECKED') });
    expect(buildDailyRecord(rows, DAY, 'real', [{ host: 'groq', verified: true, evidence: 'billing page, 2026-11-09' }]).providers[0]).toMatchObject({ verified_free: true, free_basis: 'billing page, 2026-11-09' });
  });

  it('does not score anyone for being busy', () => {
    const r = buildDailyRecord([row('a', [receipt('claimed', at)])], DAY, 'real');
    expect(r.reputation).toMatchObject({ scored: false, anchored: false });
    expect(JSON.stringify(r)).not.toMatch(/repid_delta|score_delta/);
  });

  it('counts a receipt only on its own day', () => {
    expect(buildDailyRecord([row('a', [receipt('claimed', '2026-11-08T23:59:59.000Z')])], DAY, 'real').tasks.attempted).toBe(0);
  });

  it('reports a broken receipt chain instead of hiding it', () => {
    expect(buildDailyRecord([row('a', [receipt('claimed', at)])], DAY, 'real').receipts[0]).toMatchObject({ task: 'a', chain_ok: false });
  });
});

describe('missed-run signal', () => {
  const now = Date.parse('2026-11-09T12:00:00Z');
  const run = (minsAgo: number, conclusion: string | null = 'success', status = 'completed'): RunRow => ({ status, conclusion, created_at: new Date(now - minsAgo * 60_000).toISOString() });

  it.each<[string, RunRow[] | null, boolean, string, number]>([
    ['a recent good run', [run(30)], true, 'OK', 0],
    ['the last run is too old', [run(400)], true, 'MISSED', 1],
    ['armed but never run', [], true, 'MISSED', 1],
    ['three failures in a row', [run(30, 'failure'), run(90, 'failure'), run(150, 'failure')], true, 'FAILING', 1],
    ['two failures then a success', [run(30, 'failure'), run(90, 'failure'), run(150)], true, 'OK', 0],
    ['GitHub unreachable', null, true, 'NOT_CHECKED', 2],
    ['not armed', [], false, 'NOT_ARMED', 0],
    ['unreachable beats not armed', null, false, 'NOT_CHECKED', 2],
  ])('%s', (_name, rows, armed, verdict, exit) => {
    expect(judgeRuns(rows, now, 150, armed)).toMatchObject({ verdict, exit });
  });
});

describe('the workflows stay inert and least-privilege', () => {
  const read = (f: string) => readFileSync(join(__dirname, '..', '.github', 'workflows', f), 'utf8').replace(/\r\n/g, '\n');
  const live = read('t12-supervisor.yml');
  const code = live.split('\n').filter((l) => !l.trim().startsWith('#')).join('\n');
  const job = (name: string, next?: string) => code.slice(code.indexOf(`\n  ${name}:\n`), next ? code.indexOf(`\n  ${next}:\n`) : undefined);
  const maker = job('maker', 'checker');
  const checker = job('checker', 'integrator');
  const integrator = job('integrator');

  it('has no schedule, and every job is behind the off-by-default variable', () => {
    expect(code).not.toMatch(/^\s*schedule:/m);
    expect(code).not.toMatch(/\bcron:/);
    for (const j of [maker, checker, integrator]) expect(j).toContain("vars.T12_SUPERVISOR_ENABLED == 'true'");
  });

  it('gives each job only its own credentials', () => {
    expect(maker).not.toMatch(/ALLOW_EXEC|T12_LANES_PUBLISH|T12_PR_TOKEN/);
    expect(checker).not.toMatch(/_API_KEY|T12_LANES_PUBLISH|T12_PR_TOKEN|T12_FREE_WAVE/);
    expect(integrator).not.toMatch(/_API_KEY|ALLOW_EXEC|T12_FREE_WAVE/);
    expect(code).toMatch(/permissions:\n\s+contents: read/);
    expect(code).not.toMatch(/contents: write|id-token: write/);
  });

  it('moves commits by artifact id and fails on a digest mismatch', () => {
    for (const j of [checker, integrator]) {
      expect(j).toContain('artifact-ids: ${{ needs.maker.outputs.artifact-id }}');
      expect(j).toContain('digest-mismatch: error');
      expect(j).toContain('--transfer-in');
    }
    expect(maker).toContain('--transfer-out');
  });

  it('never uploads or prints raw runner output', () => {
    expect(code).not.toMatch(/path:\s*\S*(run|lane)\.log/);
    for (const [j, role] of [[maker, 'maker'], [checker, 'checker'], [integrator, 'integrator']] as const) expect(j).toContain(`--role ${role}`);
  });

  it('the synthetic workflow holds no secrets at all', () => {
    expect(read('t12-supervisor-synthetic.yml')).not.toMatch(/secrets\./);
  });
});
