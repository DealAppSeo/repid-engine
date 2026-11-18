/**
 * Settlement fixtures (positive, negative, abstention) and Vaccine canaries for experimental RepID.
 *
 * Axes are the scoring dimensions in src/services/experimental-repid.ts: `validator` (ka-v2-precommitted)
 * and `calibration` (brier-v1). This file asserts SIGNS, and that the written delta is exactly what the
 * versioned scorer returns; it never restates a scoring magnitude.
 *
 * Every canary must be REFUSED with its reason code and must write nothing.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { memoryStore } from './helpers/stores';
import {
  ACTIVE_VERSIONS,
  SCORING_VERSIONS,
  knownAnswerEvidence,
  sealEvidence,
  settleExperimental,
  type KnownAnswerRow,
} from '../../src/services/experimental-repid';

beforeAll(() => { jest.spyOn(console, 'warn').mockImplementation(() => undefined); });

interface Fixtures {
  agents: { id: string; agent_id: string; agent_name: string }[];
  graded: { fixture: string; kind: string; row: KnownAnswerRow; expect: Record<string, 'positive' | 'negative' | 'zero' | 'not_scorable'> }[];
}
const fixtures: Fixtures = JSON.parse(readFileSync(join(__dirname, 'fixtures/settlement-fixtures.json'), 'utf8'));
const AGENTS = fixtures.agents;
const [A, B] = AGENTS as [typeof AGENTS[0], typeof AGENTS[0]];
const graded = Object.fromEntries(fixtures.graded.map((g) => [g.fixture, g])) as Record<string, typeof fixtures.graded[0]>;
const dimOf = (v: string) => SCORING_VERSIONS[v]!.dimension;

async function settleAll(row: KnownAnswerRow, store = memoryStore(AGENTS)) {
  const evidence = knownAnswerEvidence(row);
  const out: Record<string, Awaited<ReturnType<typeof settleExperimental>>> = {};
  for (const v of ACTIVE_VERSIONS) out[dimOf(v)] = await settleExperimental({ agentId: row.subject_agent_id, evidence, version: v }, { mode: 'shadow', store: store.store });
  return { out, events: store.events };
}

describe('fixtures: the expected effect on each axis', () => {
  it.each(fixtures.graded.map((g) => [g.fixture, g] as const))('%s', async (_name, g) => {
    const { out, events } = await settleAll(g.row);
    for (const [axis, want] of Object.entries(g.expect)) {
      const res = out[axis]!;
      const version = ACTIVE_VERSIONS.find((v) => dimOf(v) === axis)!;
      const scored = SCORING_VERSIONS[version]!.score(knownAnswerEvidence(g.row).content);
      if (want === 'not_scorable') {
        expect(res).toEqual({ status: 'not_scorable' });
        expect(events.filter((e) => e.dimension === axis)).toHaveLength(0);
        continue;
      }
      expect(res).toMatchObject({ status: 'settled', mode: 'shadow', dimension: axis, eligibility: 'same_controller_measured' });
      if (res.status !== 'settled') throw new Error('unreachable');
      expect(res.delta).toBe(scored);
      if (want === 'positive') expect(res.delta).toBeGreaterThan(0);
      if (want === 'negative') expect(res.delta).toBeLessThan(0);
      if (want === 'zero') expect(res.delta).toBe(0);
      const ev = events.filter((e) => e.dimension === axis);
      expect(ev).toHaveLength(1);
      expect(ev[0]!.score_after).toBe(res.delta); // first event on a fresh chain
    }
  });

  it('abstention writes a zero-delta validator row and nothing on calibration', async () => {
    const { events } = await settleAll(graded['FX-ABS']!.row);
    expect(events.map((e) => [e.dimension, e.delta])).toEqual([['validator', 0]]);
  });
});

describe('canaries: each is refused with its reason, and writes nothing', () => {
  const POS = graded['FX-POS']!.row;

  it('duplicate receipt -> already_consumed', async () => {
    const s = memoryStore(AGENTS);
    const e = knownAnswerEvidence(POS);
    const first = await settleExperimental({ agentId: A.id, evidence: e, version: 'ka-v2-precommitted' }, { mode: 'shadow', store: s.store });
    expect(first.status).toBe('settled');
    const again = await settleExperimental({ agentId: A.id, evidence: e, version: 'ka-v2-precommitted' }, { mode: 'shadow', store: s.store });
    expect(again).toEqual({ status: 'refused', reason: 'already_consumed' });
    expect(s.events).toHaveLength(1);
  });

  it('self-endorsement -> self_dealing (the subject is its own oracle)', async () => {
    const s = memoryStore(AGENTS);
    for (const oracle of [A.id, A.agent_id]) {
      const e = sealEvidence({ ...knownAnswerEvidence(POS), oracleId: oracle });
      expect(await settleExperimental({ agentId: A.id, evidence: e, version: 'ka-v2-precommitted' }, { mode: 'shadow', store: s.store }))
        .toEqual({ status: 'refused', reason: 'self_dealing' });
    }
    expect(s.events).toHaveLength(0);
  });

  it('circular endorsement -> oracle_not_answer_key on both legs (A grades B, B grades A)', async () => {
    const s = memoryStore(AGENTS);
    const bRow: KnownAnswerRow = { ...POS, task_id: 'fx-task-pos-b', claimed_by: B.agent_id, subject_agent_id: B.id };
    const aGradedByB = sealEvidence({ ...knownAnswerEvidence(POS), oracleId: B.id });
    const bGradedByA = sealEvidence({ ...knownAnswerEvidence(bRow), oracleId: A.id });
    expect(await settleExperimental({ agentId: A.id, evidence: aGradedByB, version: 'ka-v2-precommitted' }, { mode: 'shadow', store: s.store }))
      .toEqual({ status: 'refused', reason: 'oracle_not_answer_key' });
    expect(await settleExperimental({ agentId: B.id, evidence: bGradedByA, version: 'ka-v2-precommitted' }, { mode: 'shadow', store: s.store }))
      .toEqual({ status: 'refused', reason: 'oracle_not_answer_key' });
    expect(s.events).toHaveLength(0);
  });

  it.each([
    ['empty ref', { ref: '' }],
    ['ref names another task', { ref: 'trinity_tasks/fx-other;hal_test_cases/fx-case-veto-1' }],
    ['ref names no answer key', { ref: 'trinity_tasks/fx-task-pos-1' }],
    ['ref names a task whose id only starts with this one', { ref: 'trinity_tasks/fx-task-pos-10;hal_test_cases/fx-case-veto-1' }],
  ] as const)('ungrounded grading (%s) -> ungrounded', async (_n, over) => {
    const s = memoryStore(AGENTS);
    const e = sealEvidence({ ...knownAnswerEvidence(POS), ...over });
    expect(await settleExperimental({ agentId: A.id, evidence: e, version: 'ka-v2-precommitted' }, { mode: 'shadow', store: s.store }))
      .toEqual({ status: 'refused', reason: 'ungrounded' });
    expect(s.events).toHaveLength(0);
  });

  it('ungrounded grading (no case id) -> ungrounded', async () => {
    const s = memoryStore(AGENTS);
    const e = knownAnswerEvidence({ ...POS, case_id: '' });
    expect(await settleExperimental({ agentId: A.id, evidence: e, version: 'ka-v2-precommitted' }, { mode: 'shadow', store: s.store }))
      .toEqual({ status: 'refused', reason: 'ungrounded' });
    expect(s.events).toHaveLength(0);
  });

  it('control: the grounded original of every canary settles (each refusal is the canary, not a broken fixture)', async () => {
    const s = memoryStore(AGENTS);
    expect((await settleExperimental({ agentId: A.id, evidence: knownAnswerEvidence(POS), version: 'ka-v2-precommitted' }, { mode: 'shadow', store: s.store })).status).toBe('settled');
  });
});
