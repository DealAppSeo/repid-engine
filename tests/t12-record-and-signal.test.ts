/** The daily work record and the missed-run signal. Pure logic; no database and no network. */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildDailyRecord, makerRefusalCode, plainReason } from '../src/orchestration/t12-daily-record';
import { judgeRuns, type RunRow } from '../src/orchestration/t12-missed-run';
import { validateSpec, type DecisionReceipt, type LaneState } from '../src/orchestration/t12-lane-store';

const receipt = (event: string, at: string, evidence: unknown = {}, reason = ''): DecisionReceipt => ({ seq: 0, at, actor: 'trinity-lane-1', origin: 'scheduled', event, from: 'a', to: 'b', epoch: 1, reason, evidence, prev: '0', hash: `h-${event}` });
const row = (id: string, receipts: DecisionReceipt[]) => ({ state: { spec: { id }, receipts } as unknown as LaneState });
const DAY = '2026-11-09';
const at = `${DAY}T03:00:00.000Z`;

describe('daily record', () => {
  it('counts the work from receipts', () => {
    const r = buildDailyRecord([
      row('a', [receipt('claimed', at), receipt('belt_checked_out', at), receipt('route_attempt', at, { provider: 'groq', status: 200, reason: 'answered' }), receipt('stage_claimed', at), receipt('check_approved', at, { commit: 'abc', exit: 0, controls: [{}, {}] }), receipt('integrated', at)]),
      row('b', [receipt('claimed', at), receipt('lease_reaped', at), receipt('route_attempt', at, { provider: 'groq', status: 429, reason: 'rate_limited' }), receipt('check_rejected', at, {}, 'wrote outside its lease')]),
    ], DAY, 'synthetic');
    expect(r.tasks).toMatchObject({ attempted: 2, accepted: 1, rejected: 1, integrated: 1 });
    expect(r.leases).toMatchObject({ claims: 2, stage_claims: 1, expired_and_recovered: 1 });
    expect(r.belts.checked_out).toBe(1);
    expect(r.providers).toEqual([expect.objectContaining({ host: 'groq', attempts: 2, answered: 1, rate_limited: 1 })]);
    expect(r.tests[0]).toMatchObject({ task: 'a', verdict: 'approved', exit: 0, controls: 2 });
    expect(r.tests[1]).toMatchObject({ task: 'b', verdict: 'rejected', reason: 'wrote outside its lease' });
  });

  it('publishes a short plain reason, never what a model-written test printed', () => {
    const hostile = 'verify failed with exit 1: ![x](https://evil.test/p.png) [click](https://evil.test) <img src=x>';
    const r = buildDailyRecord([row('a', [receipt('check_rejected', at, {}, hostile), receipt('check_not_checked', at, {}, 'verify did not finish: `rm` <b>')])], DAY, 'real');
    expect(r.tests.map((t) => t.reason)).toEqual(['verify failed with exit 1', 'verify did not finish']);
    expect(JSON.stringify(r)).not.toMatch(/evil\.test|<img|<b>/);
  });

  it('strips markup from the short reason too', () => {
    expect(plainReason('![x](u) `a` <b> done')).toBe('x u a b done');
    expect(plainReason('   ')).toBeNull();
  });

  it('never calls usage free without provider-side evidence', () => {
    const rows = [row('a', [receipt('route_attempt', at, { provider: 'groq', status: 200, reason: 'answered' })])];
    expect(buildDailyRecord(rows, DAY, 'real').providers[0]).toMatchObject({ verified_free: null, free_basis: expect.stringContaining('NOT_CHECKED') });
    expect(buildDailyRecord(rows, DAY, 'real', [{ host: 'groq', verified: true, evidence: 'billing page, 2026-11-09' }]).providers[0]).toMatchObject({ verified_free: true, free_basis: 'billing page, 2026-11-09' });
  });

  // Study T12-CTX-AB-2026-11-10-v2, pair 2: two outputs were refused before any check and the record could not say why.
  it('says why the lane refused an output, as a code, never the model text inside the reason', () => {
    const set = 'model output was not a valid file set inside the lease: ';
    const hostilePath = `${set}![x](https://evil.test/p.png)<img src=x> is outside the lease`;
    const hostileJson = `${set}invalid JSON: Unexpected token 'S', "SECRET=abc <b>" is not valid JSON`;
    const r = buildDailyRecord([
      row('a', [receipt('claimed', at), receipt('maker_failed', at, {}, hostilePath)]),
      row('b', [receipt('claimed', at), receipt('maker_failed', at, {}, hostileJson)]),
      row('c', [receipt('claimed', at), receipt('maker_failed', at, {}, 'the model produced no change')]),
      row('d', [receipt('claimed', at), receipt('released', at, {}, 'NOT_CHECKED: tried local')]),
    ], DAY, 'real');
    expect(r.tasks.maker_refused).toBe(3);
    expect(r.leases.released).toBe(1);
    expect(r.refusals).toEqual([{ task: 'a', code: 'path_outside_lease' }, { task: 'b', code: 'invalid_json' }, { task: 'c', code: 'no_change' }]); // a: the format before path_code
    expect(JSON.stringify(r)).not.toMatch(/evil\.test|<img|SECRET|<b>/);
  });

  it('maps every lane refusal phrase to its own code', () => {
    const set = 'model output was not a valid file set inside the lease: ';
    expect(makerRefusalCode(`${set}no JSON object in the reply`)).toEqual({ code: 'no_json' });
    expect(makerRefusalCode(`${set}no files in the reply`)).toEqual({ code: 'no_files' });
    expect(makerRefusalCode(`${set}a file is missing its path or content`)).toEqual({ code: 'file_missing_path_or_content' });
    expect(makerRefusalCode('belt denied: no grant')).toEqual({ code: 'belt_denied' });
    expect(makerRefusalCode('something new')).toEqual({ code: 'other' });
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

  it('gives each job its own database secret, for its own Postgres role', () => {
    const db = (j: string) => j.match(/secrets\.T12_\w*DATABASE_URL/g);
    expect(db(maker)).toEqual(['secrets.T12_MAKER_DATABASE_URL']);
    expect(db(checker)).toEqual(['secrets.T12_CHECKER_DATABASE_URL']);
    expect(db(integrator)).toEqual(['secrets.T12_INTEGRATOR_DATABASE_URL']);
    expect(code).not.toContain('T12_WORKER_DATABASE_URL');
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

  it('the G2.5 workflow cannot publish, and only the maker can hold a model key', () => {
    const g25 = read('t12-g25-dogfood.yml').split('\n').filter((l) => !l.trim().startsWith('#')).join('\n');
    expect(g25).not.toMatch(/^\s*schedule:/m);
    expect(g25).toContain("vars.T12_G25_ENABLED == 'true'");
    expect(g25).not.toMatch(/T12_LANES_PUBLISH|GH_TOKEN|T12_PR_TOKEN|--role integrator|contents: write/);
    expect(g25.match(/secrets\./g)).toHaveLength(1);
    const checker = g25.slice(g25.indexOf('name: Checker'), g25.indexOf("name: The day's work record"));
    expect(checker).not.toMatch(/_API_KEY|secrets\.|T12_FREE_WAVE/);
  });

  it('the G2.5 workflow keeps only the sanitized work record and the deliverable bundle', () => {
    const g25 = read('t12-g25-dogfood.yml').split('\n').filter((l) => !l.trim().startsWith('#')).join('\n');
    const paths = [...g25.matchAll(/^\s*path:\s*(.+)$/gm)].map((m) => m[1]!.trim());
    // Raw maker/checker output can hold what a model-written test printed, so it is never kept. The bundle
    // is different: it is the deliverable (the maker's one commit, no output), whose sha256 the task row and
    // receipt chain record, and without it nothing can be bound to the bytes once the job's database is gone.
    // The supervisor already carries the same bundles between jobs as an artifact. This test used to forbid
    // every transfer path; it now allows exactly the bundle glob and still refuses the rest.
    expect(paths).toEqual(['${{ runner.temp }}/daily-record.json', '${{ runner.temp }}/transfer/*.bundle']);
    expect(g25).not.toMatch(/path:.*(maker\.json|checker\.json|\.log)/);
    expect(paths.filter((p) => p.includes('transfer'))).toEqual(['${{ runner.temp }}/transfer/*.bundle']);
  });

  it('the G2.5 task is valid, low risk and has a control that applies to the seed', () => {
    const root = join(__dirname, '..', 'ops', 't12', 'g25');
    const spec = JSON.parse(readFileSync(join(root, 'specs.jsonl'), 'utf8').trim());
    expect(validateSpec(spec)).toEqual([]);
    expect(spec.risk).toBe('LOW');
    const seed = readFileSync(join(root, 'seed', spec.verify.controls[0].file), 'utf8').replace(/\r\n/g, '\n');
    expect(seed).toContain(spec.verify.controls[0].find);
  });

  it('a work record can only reach a job summary as a code block', () => {
    for (const f of ['t12-g25-dogfood.yml', 't12-supervisor-synthetic.yml']) {
      const lines = read(f).split('\n').filter((l) => l.includes('GITHUB_STEP_SUMMARY') && !l.trim().startsWith('#'));
      expect(lines.length).toBeGreaterThan(0);
      for (const l of lines) expect(l).toContain("echo '```json'");
    }
  });

  it('the synthetic workflow holds no secrets at all', () => {
    expect(read('t12-supervisor-synthetic.yml')).not.toMatch(/secrets\./);
  });
});
