/**
 * Experimental RepID namespace (D-124 revised, 2026-11-02): identity-bound, one-time, non-self-dealing
 * settlement into repid_experimental_events, never into canonical RepID.
 *
 * Every forge/replay attempt below must be REFUSED, and every refusal must write nothing.
 * The Supabase client is an in-memory fake that records every table it is asked about and emulates
 * the migration's two unique indexes and the score chain. No network, no DB.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import express from 'express';
import request from 'supertest';
import {
  EXPERIMENTAL_DOMAIN,
  EXPERIMENTAL_LABEL,
  KNOWN_ANSWER_ORACLE,
  SCORING_VERSIONS,
  eligibilityFor,
  experimentalRepidMode,
  experimentalTier,
  knownAnswerEvidence,
  replayKnownAnswers,
  sealEvidence,
  settleExperimental,
  supabaseExperimentalStore,
  type KnownAnswerRow,
} from '../../src/services/experimental-repid';
import { experimentalScoresRouter } from '../../src/routes/experimental-repid';

beforeAll(() => { jest.spyOn(console, 'warn').mockImplementation(() => undefined); });

// ── fake supabase-js client ─────────────────────────────────────────────────────────────────
type Row = any;
interface Op { table: string; op: 'select' | 'insert' }

function fakeDb(seed: Record<string, Row[]> = {}) {
  const tables: Record<string, Row[]> = { repid_experimental_events: [], ...seed };
  const ops: Op[] = [];
  const rows = (t: string) => (tables[t] ??= []);
  const client = {
    from(table: string) {
      return {
        select(_cols?: string) {
          ops.push({ table, op: 'select' });
          const filters: [string, unknown][] = [];
          const run = () => ({ data: rows(table).filter((r) => filters.every(([c, v]) => r[c] === v)), error: null });
          const q: any = {
            eq(c: string, v: unknown) { filters.push([c, v]); return q; },
            async maybeSingle() { const { data } = run(); return { data: data[0] ?? null, error: null }; },
            then(ok: (v: unknown) => unknown, bad?: (e: unknown) => unknown) { return Promise.resolve(run()).then(ok, bad); },
          };
          return q;
        },
        insert(row: Row) {
          ops.push({ table, op: 'insert' });
          return {
            select() {
              return {
                async single() {
                  const t = rows(table);
                  if (table === 'repid_experimental_events') {
                    const clash = t.some((r) => r.domain === row.domain && r.dimension === row.dimension && r.mode === row.mode &&
                      (r.evidence_id === row.evidence_id || r.evidence_hash === row.evidence_hash));
                    if (clash) return { data: null, error: { code: '23505', message: 'duplicate key value violates unique constraint' } };
                    // the migration's BEFORE INSERT trigger: score_after = previous score_after + delta
                    const prev = t.filter((r) => r.domain === row.domain && r.agent_id === row.agent_id && r.dimension === row.dimension && r.mode === row.mode);
                    const stored = { ...row, score_after: (prev.length ? prev[prev.length - 1].score_after : 0) + row.delta };
                    t.push(stored);
                    return { data: { score_after: stored.score_after }, error: null };
                  }
                  t.push(row);
                  return { data: row, error: null };
                },
              };
            },
          };
        },
      };
    },
  };
  return { client: client as any, ops, tables };
}

const APM = { id: '065ad782-ea58-4078-9414-60a862d67ba1', agent_id: 'trinity-apm', agent_name: 'trinity-apm' };
const MEL = { id: '942860a6-e26f-4334-ae94-b7c1abed1e8c', agent_id: 'trinity-mel', agent_name: 'trinity-mel' };
const answer = (decision: string, confidence?: number) =>
  JSON.stringify(confidence === undefined ? { decision } : { decision, confidence });

function row(over: Partial<KnownAnswerRow> = {}): KnownAnswerRow {
  return { task_id: '435784', claimed_by: 'trinity-apm', case_id: 'case-1', result: answer('pass', 0.9), expected: 'pass', subject_agent_id: APM.id, ...over };
}
const setup = () => fakeDb({ repid_agents: [APM, MEL] });
const V = 'ka-v2-precommitted';

describe('settleExperimental: anti-forgery', () => {
  test('replaying the same evidence twice is refused', async () => {
    const { client, tables } = setup();
    const store = supabaseExperimentalStore(client);
    const ev = knownAnswerEvidence(row());
    const first = await settleExperimental({ agentId: APM.id, evidence: ev, version: V }, { store, mode: 'shadow' });
    const second = await settleExperimental({ agentId: APM.id, evidence: ev, version: V }, { store, mode: 'shadow' });
    expect(first.status).toBe('settled');
    expect(second).toEqual({ status: 'refused', reason: 'already_consumed' });
    expect(tables.repid_experimental_events).toHaveLength(1);
  });

  test('evidence about agent X settled for agent Y is refused', async () => {
    const { client, tables } = setup();
    const store = supabaseExperimentalStore(client);
    const aboutApm = knownAnswerEvidence(row());
    expect(await settleExperimental({ agentId: MEL.id, evidence: aboutApm, version: V }, { store, mode: 'shadow' }))
      .toEqual({ status: 'refused', reason: 'subject_mismatch' });
    // a forger who re-points the subject and re-seals the hash is still caught: the source row names apm
    const repointed = sealEvidence({ ...aboutApm, subjectAgentId: MEL.id });
    expect(await settleExperimental({ agentId: MEL.id, evidence: repointed, version: V }, { store, mode: 'shadow' }))
      .toEqual({ status: 'refused', reason: 'subject_mismatch' });
    expect(tables.repid_experimental_events).toHaveLength(0);
  });

  test('evidence whose oracle/validator is the subject is refused', async () => {
    const { client, tables } = setup();
    const store = supabaseExperimentalStore(client);
    for (const oracleId of [APM.id, APM.agent_id]) {
      const selfGraded = sealEvidence({ ...knownAnswerEvidence(row()), oracleId });
      expect(await settleExperimental({ agentId: APM.id, evidence: selfGraded, version: V }, { store, mode: 'active' }))
        .toEqual({ status: 'refused', reason: 'self_dealing' });
    }
    // a known answer is graded by the answer key, never by a model or another agent
    const peerGraded = sealEvidence({ ...knownAnswerEvidence(row()), oracleId: MEL.agent_id });
    expect(await settleExperimental({ agentId: APM.id, evidence: peerGraded, version: V }, { store, mode: 'active' }))
      .toEqual({ status: 'refused', reason: 'oracle_not_answer_key' });
    expect(tables.repid_experimental_events).toHaveLength(0);
  });

  test('tampered content (a wrong answer rewritten as right) is refused', async () => {
    const { client, tables } = setup();
    const ev = knownAnswerEvidence(row({ result: answer('veto', 0.9) }));
    const tampered = { ...ev, content: { ...ev.content, result: answer('pass', 0.9) } };
    expect(await settleExperimental({ agentId: APM.id, evidence: tampered, version: V }, { store: supabaseExperimentalStore(client), mode: 'shadow' }))
      .toEqual({ status: 'refused', reason: 'hash_mismatch' });
    expect(tables.repid_experimental_events).toHaveLength(0);
  });

  test('wrong domain is refused', async () => {
    const { client, tables } = setup();
    const ev = sealEvidence({ ...knownAnswerEvidence(row()), domain: 'canonical' });
    expect(await settleExperimental({ agentId: APM.id, evidence: ev, version: V }, { store: supabaseExperimentalStore(client), mode: 'active' }))
      .toEqual({ status: 'refused', reason: 'wrong_domain' });
    expect(tables.repid_experimental_events).toHaveLength(0);
  });

  test('an unknown agent is refused', async () => {
    const { client } = fakeDb({ repid_agents: [MEL] });
    expect(await settleExperimental({ agentId: APM.id, evidence: knownAnswerEvidence(row()), version: V }, { store: supabaseExperimentalStore(client), mode: 'shadow' }))
      .toEqual({ status: 'refused', reason: 'unknown_agent' });
  });

  test('same-controller evidence cannot be labelled independent_counterparty through any input', async () => {
    const { client, tables } = setup();
    const store = supabaseExperimentalStore(client);
    const independent = jest.fn(async () => 'independent' as const);
    // 1) an eligibility field on the input is ignored
    const claimed = { ...knownAnswerEvidence(row()), eligibility: 'independent_counterparty' } as any;
    // 2) a counterparty that IS a different owner, on a known answer (which has no counterparty)
    const withCp = sealEvidence({ ...knownAnswerEvidence(row({ task_id: '2' })), counterpartyAgentId: MEL.id });
    for (const evidence of [claimed, withCp]) {
      const r = await settleExperimental({ agentId: APM.id, evidence, version: V }, { store, mode: 'active', independence: independent });
      expect(r).toMatchObject({ status: 'settled', eligibility: 'same_controller_measured' });
    }
    expect(tables.repid_experimental_events.map((r: Row) => r.eligibility)).toEqual(['same_controller_measured', 'same_controller_measured']);
    // 3) the one function that can say independent: only on a POSITIVE different-owner answer
    expect(await eligibilityFor(APM.id, null, independent)).toBe('same_controller_measured');
    expect(await eligibilityFor(APM.id, APM.id, independent)).toBe('same_controller_measured');
    expect(await eligibilityFor(APM.id, MEL.id, async () => 'same_owner')).toBe('same_controller_measured');
    expect(await eligibilityFor(APM.id, MEL.id, async () => 'owner_unknown')).toBe('same_controller_measured');
    expect(await eligibilityFor(APM.id, MEL.id, async () => { throw new Error('resolver down'); })).toBe('same_controller_measured');
    expect(await eligibilityFor(APM.id, MEL.id, independent)).toBe('independent_counterparty');
  });

  test('mode off writes nothing and reads nothing', async () => {
    const { client, ops } = setup();
    const r = await settleExperimental({ agentId: APM.id, evidence: knownAnswerEvidence(row()), version: V }, { store: supabaseExperimentalStore(client), mode: 'off' });
    expect(r).toEqual({ status: 'off' });
    expect(ops).toEqual([]);
  });

  test('shadow and active from the same evidence produce identical deltas', async () => {
    const { client, tables } = setup();
    const store = supabaseExperimentalStore(client);
    for (const result of [answer('pass', 0.9), answer('veto', 0.7), answer('abstain')]) {
      const ev = knownAnswerEvidence(row({ task_id: result, result }));
      const shadow = await settleExperimental({ agentId: APM.id, evidence: ev, version: V }, { store, mode: 'shadow' });
      const active = await settleExperimental({ agentId: APM.id, evidence: ev, version: V }, { store, mode: 'active' });
      expect(shadow.status).toBe('settled');
      expect(active.status).toBe('settled');
      expect((active as any).delta).toBe((shadow as any).delta);
    }
    const byMode = (m: string) => tables.repid_experimental_events.filter((r: Row) => r.mode === m).map((r: Row) => r.delta);
    expect(byMode('active')).toEqual(byMode('shadow'));
    expect(byMode('shadow')).toEqual([1, -1.7, 0]);
  });

  test('canonical tables are never written (repid_agents is only read; repid_score_events never touched)', async () => {
    const { client, ops } = setup();
    const store = supabaseExperimentalStore(client);
    for (const [i, r] of [row(), row({ task_id: '9', claimed_by: 'trinity-mel', subject_agent_id: MEL.id, result: answer('veto', 1) })].entries()) {
      const ev = knownAnswerEvidence(r);
      await settleExperimental({ agentId: r.subject_agent_id, evidence: ev, version: V }, { store, mode: i ? 'active' : 'shadow' });
      await settleExperimental({ agentId: r.subject_agent_id, evidence: ev, version: 'brier-v1' }, { store, mode: 'active' });
    }
    expect(ops.filter((o) => o.op === 'insert').every((o) => o.table === 'repid_experimental_events')).toBe(true);
    expect(ops.filter((o) => o.table === 'repid_agents').every((o) => o.op === 'select')).toBe(true);
    expect(ops.some((o) => o.table === 'repid_score_events')).toBe(false);
    expect(new Set(ops.map((o) => o.table))).toEqual(new Set(['repid_agents', 'repid_experimental_events']));
  });

  test('every movement records its evidence, eligibility class and scoring version', async () => {
    const { client, tables } = setup();
    const store = supabaseExperimentalStore(client);
    const ev = knownAnswerEvidence(row({ result: answer('veto', 0.8) }));
    await settleExperimental({ agentId: APM.id, evidence: ev, version: V }, { store, mode: 'shadow' });
    await settleExperimental({ agentId: APM.id, evidence: ev, version: 'brier-v1' }, { store, mode: 'shadow' });
    const [v, c] = tables.repid_experimental_events;
    expect(v).toMatchObject({
      domain: EXPERIMENTAL_DOMAIN, agent_id: APM.id, dimension: 'validator', evidence_kind: 'known_answer',
      evidence_id: 'trinity_tasks:435784', evidence_hash: ev.hash, oracle_id: KNOWN_ANSWER_ORACLE,
      eligibility: 'same_controller_measured', scoring_version: V, mode: 'shadow', delta: -1.8, score_after: -1.8,
    });
    expect(v.evidence_ref).toContain('435784');
    expect(c).toMatchObject({ dimension: 'calibration', scoring_version: 'brier-v1', evidence_hash: ev.hash });
    expect(await settleExperimental({ agentId: APM.id, evidence: ev, version: 'ka-v9-made-up' }, { store, mode: 'shadow' }))
      .toEqual({ status: 'refused', reason: 'unknown_version' });
  });
});

describe('scoring versions (pure)', () => {
  const content = (result: string, expected = 'pass') => knownAnswerEvidence(row({ result, expected })).content;
  test("ka-v2-precommitted is the grader's rule: correct +1, abstain 0, wrong -(1+confidence), missing confidence = 1", () => {
    const s = SCORING_VERSIONS['ka-v2-precommitted']!.score;
    expect(s(content(answer('pass', 0.3)))).toBe(1);
    expect(s(content(answer('abstain', 0.9)))).toBe(0);
    expect(s(content(answer('veto', 0.8)))).toBeCloseTo(-1.8);
    expect(s(content(answer('veto')))).toBe(-2);
    expect(s(content('I think it is fine'))).toBeNull(); // unparseable is not scored
  });
  test('brier-v1 calibration is a separate dimension: 0.25 - (confidence - correct)^2', () => {
    const b = SCORING_VERSIONS['brier-v1']!;
    expect(b.dimension).toBe('calibration');
    expect(b.score(content(answer('pass', 1)))).toBeCloseTo(0.25);
    expect(b.score(content(answer('pass', 0.5)))).toBeCloseTo(0);
    expect(b.score(content(answer('veto', 1)))).toBeCloseTo(-0.75);
    expect(b.score(content(answer('abstain', 0.4)))).toBeNull();
  });
});

describe('mode, tier, replay', () => {
  test('EXPERIMENTAL_REPID_MODE: unset = off, unknown = loud + shadow', () => {
    const err = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    expect(experimentalRepidMode(undefined)).toBe('off');
    expect(experimentalRepidMode('off')).toBe('off');
    expect(experimentalRepidMode(' Active ')).toBe('active');
    expect(experimentalRepidMode('enforce')).toBe('shadow');
    expect(err).toHaveBeenCalled();
    err.mockRestore();
  });

  test('experimentalTier: only ACTIVE rows count; shadow never changes a tier', () => {
    const shadowStar = [{ dimension: 'validator', mode: 'shadow', n: 500, score: 480 }];
    expect(experimentalTier(shadowStar)).toBe('exp-unproven');
    expect(experimentalTier([{ dimension: 'validator', mode: 'active', n: 10, score: 10 }])).toBe('exp-unproven');
    expect(experimentalTier([{ dimension: 'validator', mode: 'active', n: 40, score: 10 }])).toBe('exp-measured');
    expect(experimentalTier([{ dimension: 'validator', mode: 'active', n: 120, score: 90 }])).toBe('exp-proficient');
    expect(experimentalTier([
      { dimension: 'validator', mode: 'active', n: 120, score: 90 },
      { dimension: 'calibration', mode: 'active', n: 120, score: -3 },
    ])).toBe('exp-probation');
  });

  test('replay scores the same evidence under several versions and writes nothing', () => {
    const rows = [
      row({ task_id: '1', result: answer('pass', 0.9) }),
      row({ task_id: '2', result: answer('veto', 0.5) }),
      row({ task_id: '3', result: answer('abstain') }),
      row({ task_id: '4', result: 'garbled' }),
    ];
    const out = replayKnownAnswers(rows, ['ka-v2-precommitted', 'ka-v1-symmetric']);
    const apm = (v: string) => out.find((l) => l.version === v && l.agent === 'trinity-apm')!;
    expect(apm('ka-v2-precommitted')).toMatchObject({ n: 3, score: -0.5, skipped: 1 });
    expect(apm('ka-v1-symmetric')).toMatchObject({ n: 3, score: 0, skipped: 1 });
    expect(apm('ka-v2-precommitted').ci95).toHaveLength(2);
    expect(() => replayKnownAnswers(rows, ['nope'])).toThrow(/unknown scoring version/);
  });
});

describe('GET /api/v1/experimental/agents/:id/scores', () => {
  const app = (client: any) => express().use('/api/v1/experimental', experimentalScoresRouter(client));

  test('returns per-dimension scores, mode, n, eligibility and the fixed experimental label', async () => {
    const { client } = fakeDb({
      repid_experimental_scores: [
        { domain: EXPERIMENTAL_DOMAIN, agent_id: APM.id, dimension: 'validator', mode: 'shadow', n: 12, score: '6.15',
          n_same_controller_measured: 12, n_independent_counterparty: 0, scoring_versions: [V], last_event_at: '2026-11-02T20:00:00Z' },
        { domain: 'other', agent_id: APM.id, dimension: 'validator', mode: 'active', n: 1, score: 1 },
      ],
    });
    const res = await request(app(client)).get(`/api/v1/experimental/agents/${APM.id}/scores`);
    expect(res.status).toBe(200);
    expect(res.body.label).toBe(EXPERIMENTAL_LABEL);
    expect(res.body.independent_reputation).toBe(false);
    expect(res.body.scores).toEqual([{
      dimension: 'validator', mode: 'shadow', n: 12, score: 6.15,
      eligibility: { same_controller_measured: 12, independent_counterparty: 0 }, scoring_versions: [V], last_event_at: '2026-11-02T20:00:00Z',
    }]);
  });

  test('a non-uuid id is 400; a failed read is 503 NOT_CHECKED, never zero', async () => {
    expect((await request(app(setup().client)).get('/api/v1/experimental/agents/trinity-apm/scores')).status).toBe(400);
    const broken = { from: () => ({ select: () => ({ eq() { return this; }, then: (ok: any) => Promise.resolve({ data: null, error: { message: 'relation does not exist' } }).then(ok) }) }) };
    const res = await request(app(broken)).get(`/api/v1/experimental/agents/${APM.id}/scores`);
    expect(res.status).toBe(503);
    expect(res.body).toMatchObject({ status: 'NOT_CHECKED', scores: null, label: EXPERIMENTAL_LABEL });
  });
});

describe('migration', () => {
  const sql = readFileSync(join(__dirname, '../../supabase/migrations/20261102140000_repid_experimental_events.sql'), 'utf8').toLowerCase();
  test('one-time consumption, append-only, service-role only, no independent label without a counterparty', () => {
    expect(sql).toMatch(/unique \(domain, dimension, evidence_id, mode\)/);
    expect(sql).toMatch(/unique \(domain, dimension, evidence_hash, mode\)/);
    expect(sql).toMatch(/before update or delete on public\.repid_experimental_events/);
    expect(sql).toMatch(/before truncate on public\.repid_experimental_events/);
    expect(sql).toMatch(/revoke all on public\.repid_experimental_events from anon, authenticated/);
    expect(sql).toMatch(/eligibility = 'same_controller_measured'\s+or \(counterparty_agent_id is not null and counterparty_agent_id <> agent_id/);
    expect(sql).not.toMatch(/(insert into|update) public\.(repid_agents|repid_score_events)/);
  });
});
