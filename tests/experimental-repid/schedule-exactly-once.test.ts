/**
 * The scheduled shadow settle (scripts/exp-repid/schedule.ts): default OFF, shadow only, and EXACTLY ONE
 * application per eligible evidence under two overlapping ticks plus a replay.
 *
 * Runs twice: over the in-memory store (always), and over the REAL migration on a throwaway Postgres when
 * EXP_REPID_PG_URL is set (loopback only). Without it the Postgres block reports NOT_CHECKED and skips.
 * The Postgres block also records one canonical transition on the ledger: score before -> delta -> after,
 * read back from the table and from the repid_experimental_scores view.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Pool } from 'pg';
import { scheduledSettleTick, type TickResult } from '../../scripts/exp-repid/schedule';
import { ACTIVE_VERSIONS, knownAnswerEvidence, SCORING_VERSIONS, type ExperimentalStore, type KnownAnswerRow } from '../../src/services/experimental-repid';
import { freshPgDatabase, memoryStore, pgStore, PG_URL } from './helpers/stores';

beforeAll(() => { jest.spyOn(console, 'warn').mockImplementation(() => undefined); });

const fixtures = JSON.parse(readFileSync(join(__dirname, 'fixtures/settlement-fixtures.json'), 'utf8')) as {
  agents: { id: string; agent_id: string; agent_name: string }[];
  graded: { fixture: string; row: KnownAnswerRow }[];
};
const AGENTS = fixtures.agents;
// Five eligible rows: the three fixtures plus two more positives, so the chain has more than one link.
const ROWS: KnownAnswerRow[] = [
  ...fixtures.graded.map((g) => g.row),
  { ...fixtures.graded[0]!.row, task_id: 'fx-task-pos-2', case_id: 'fx-case-veto-2' },
  { ...fixtures.graded[0]!.row, task_id: 'fx-task-pos-3', case_id: 'fx-case-veto-3' },
];
/** The movements one complete pass should write: every (row, version) the scorer can score. */
const EXPECTED = ROWS.flatMap((r) => ACTIVE_VERSIONS
  .filter((v) => SCORING_VERSIONS[v]!.score(knownAnswerEvidence(r).content) !== null)
  .map((v) => `${SCORING_VERSIONS[v]!.dimension}|trinity_tasks:${r.task_id}`)).sort();

const tick = (store: ExperimentalStore) => scheduledSettleTick({ enabled: '1', mode: 'shadow', loadRows: async () => ROWS, store });
const settledCount = (t: TickResult) => (t.status === 'ran' ? Object.entries(t.tally).filter(([k]) => k.endsWith(':settled')).reduce((a, [, n]) => a + n, 0) : -1);
const consumedCount = (t: TickResult) => (t.status === 'ran' ? Object.entries(t.tally).filter(([k]) => k.endsWith('already_consumed')).reduce((a, [, n]) => a + n, 0) : -1);

describe('schedule gates (nothing read, nothing written)', () => {
  const { store, events } = memoryStore(AGENTS);
  const loadRows = jest.fn(async () => ROWS);
  it.each([
    ['flag unset', { enabled: undefined, mode: 'shadow' }, 'disabled'],
    ['flag "true" is not "1"', { enabled: 'true', mode: 'shadow' }, 'disabled'],
    ['mode unset', { enabled: '1', mode: undefined }, 'mode_refused'],
    ['mode active', { enabled: '1', mode: 'active' }, 'mode_refused'],
    ['mode typo (manual path would treat it as shadow)', { enabled: '1', mode: 'shadwo' }, 'mode_refused'],
  ] as const)('%s -> %s', async (_n, env, status) => {
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
    expect((await scheduledSettleTick({ ...env, loadRows, store })).status).toBe(status);
    expect(loadRows).not.toHaveBeenCalled();
    expect(events).toHaveLength(0);
  });
});

function assertExactlyOnce(events: { dimension: string; evidence_id: string; mode: string }[]) {
  expect(events.map((e) => `${e.dimension}|${e.evidence_id}`).sort()).toEqual(EXPECTED);
  expect(new Set(events.map((e) => `${e.dimension}|${e.evidence_id}|${e.mode}`)).size).toBe(events.length);
  expect(events.every((e) => e.mode === 'shadow')).toBe(true);
}

describe('exactly once: two overlapping ticks + a replay (in-memory store)', () => {
  it('applies each eligible movement once', async () => {
    const { store, events } = memoryStore(AGENTS);
    const [t1, t2] = await Promise.all([tick(store), tick(store)]);
    const t3 = await tick(store);
    assertExactlyOnce(events);
    expect(settledCount(t1) + settledCount(t2)).toBe(EXPECTED.length);
    expect(settledCount(t3)).toBe(0);
    expect(consumedCount(t3)).toBe(EXPECTED.length);
    for (const t of [t1, t2, t3]) expect(t).toMatchObject({ status: 'ran', failed: false });
  });
});

const describePg = PG_URL ? describe : describe.skip;
if (!PG_URL) console.warn('[exp-repid schedule] NOT_CHECKED: the real-migration block needs EXP_REPID_PG_URL (a throwaway loopback Postgres).');

describePg('exactly once on the REAL migration (throwaway Postgres)', () => {
  let db: Awaited<ReturnType<typeof freshPgDatabase>>;
  let read: Pool;
  beforeAll(async () => {
    db = await freshPgDatabase(AGENTS);
    read = new Pool({ connectionString: db.url, max: 1 });
  });
  afterAll(async () => {
    await read?.end();
    await db?.drop();
  });

  it('one canonical ledger transition: before -> delta -> after, read back', async () => {
    const A = AGENTS[0]!.id;
    const score = async () => (await read.query(
      `select score from public.repid_experimental_scores where agent_id = $1 and dimension = 'validator' and mode = 'shadow'`, [A])).rows[0]?.score ?? null;
    const before = await score();
    const one = pgStore(db.url);
    const res = await scheduledSettleTick({ enabled: '1', mode: 'shadow', loadRows: async () => [fixtures.graded[0]!.row], store: one.store });
    await one.pool.end();
    const row = (await read.query(`select id, delta, score_after, evidence_id, mode from public.repid_experimental_events where agent_id = $1 and dimension = 'validator'`, [A])).rows;
    const after = await score();
    console.log(JSON.stringify({ transition: { before, delta: Number(row[0].delta), after: Number(after), score_after: Number(row[0].score_after), evidence_id: row[0].evidence_id, mode: row[0].mode, tick: res } }));
    expect(before).toBeNull();
    expect(row).toHaveLength(1);
    expect(Number(after)).toBe(0 + Number(row[0].delta));
    expect(Number(row[0].score_after)).toBe(Number(after));
    // a writer cannot set score_after: the store sent 0, the trigger wrote the chain value
    expect(Number(row[0].delta)).toBeGreaterThan(0);
  });

  it('two overlapping ticks on separate connection pools + a replay apply each movement once', async () => {
    const p1 = pgStore(db.url);
    const p2 = pgStore(db.url);
    const [t1, t2] = await Promise.all([tick(p1.store), tick(p2.store)]);
    const t3 = await tick(p1.store);
    await p1.pool.end();
    await p2.pool.end();
    const events = (await read.query('select dimension, evidence_id, mode, agent_id, delta, score_after from public.repid_experimental_events order by id')).rows;
    console.log(JSON.stringify({ overlap: { t1: t1.status === 'ran' ? t1.tally : t1, t2: t2.status === 'ran' ? t2.tally : t2, replay: t3.status === 'ran' ? t3.tally : t3, rows: events.length, expected: EXPECTED.length } }));
    assertExactlyOnce(events);
    for (const t of [t1, t2, t3]) expect(t).toMatchObject({ status: 'ran', failed: false });
    expect(settledCount(t3)).toBe(0);
    // the chain is serialised: each dimension's last score_after equals its sum of deltas
    for (const dim of ['validator', 'calibration']) {
      const d = events.filter((e) => e.dimension === dim);
      const sum = d.reduce((a, e) => a + Number(e.delta), 0);
      expect(Number(d[d.length - 1].score_after)).toBeCloseTo(sum, 9);
    }
  });
});
