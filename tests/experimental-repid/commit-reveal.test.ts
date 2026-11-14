/**
 * Commit-reveal answer key for experimental RepID (2026-11-14).
 *
 * A rehearsal conductor commits to sha256("<expected>|<nonce>") in each task's metadata BEFORE
 * dispatch, and reveals (expected, nonce) after the run. These tests pin three things:
 *   1. a reveal counts only when it recomputes the commitment the task row carried since dispatch;
 *   2. the commit-reveal key settles shadow only (active is refused until ratified);
 *   3. nothing about the hal_test_cases key changes: same parse, same rules, byte-identical hashes.
 * No network, no DB: the clients below are in-memory fakes.
 */
import {
  COMMIT_REVEAL_ORACLE,
  KNOWN_ANSWER_ORACLE,
  SCORING_VERSIONS,
  answerCommitment,
  knownAnswerEvidence,
  parseKnownAnswer,
  sealEvidence,
  settleExperimental,
  type AgentRow,
  type ExperimentalEventRow,
  type ExperimentalStore,
  type KnownAnswerRow,
} from '../../src/services/experimental-repid';
import { keyVsBridge, loadBridgeDeltas, loadCommitRevealRows, parseRevealFile, revealIsClean } from '../../src/services/commit-reveal-key';

beforeAll(() => { jest.spyOn(console, 'warn').mockImplementation(() => undefined); });

const APM: AgentRow = { id: '065ad782-ea58-4078-9414-60a862d67ba1', agent_id: 'trinity-apm', agent_name: 'trinity-apm' };
const answer = (decision: string, confidence?: number) =>
  JSON.stringify(confidence === undefined ? { decision } : { decision, confidence });
const V = 'ka-v2-precommitted';

function memStore(agents: AgentRow[] = [APM]) {
  const inserted: ExperimentalEventRow[] = [];
  const store: ExperimentalStore = {
    async getAgent(id) { return agents.find((a) => a.id === id) ?? null; },
    async insert(row) { inserted.push(row); return { ok: true, score_after: row.delta }; },
  };
  return { store, inserted };
}

function revealRow(expected: string, nonce: string, over: Partial<KnownAnswerRow> = {}): KnownAnswerRow {
  return {
    task_id: '438340', claimed_by: 'trinity-apm', case_id: 'rehearsal-x-01', result: answer('veto', 1), expected,
    subject_agent_id: APM.id, commitment: answerCommitment(expected, nonce), nonce, ...over,
  };
}

describe('the commitment', () => {
  test('matches the vector the rehearsal runner published in its own self-test', () => {
    // rehearsal-1.mjs self-test: commitOf("veto", "d00ba73197e0bb502b285dcebae8996e")
    expect(answerCommitment('veto', 'd00ba73197e0bb502b285dcebae8996e'))
      .toBe('20319f75cb73b1dbf1b0c876150c6a9180cf1a7167b849937d0bdfaa9765a3f3');
  });
});

describe('hal_test_cases key is unchanged', () => {
  const halRow: KnownAnswerRow = { task_id: '435784', claimed_by: 'trinity-apm', case_id: 'case-1', result: answer('pass', 0.9), expected: 'pass', subject_agent_id: APM.id };

  test('evidence hash is byte-identical to the one main computed before this change', () => {
    // Computed from main 122cbf26's evidenceHash over the same row: stored hashes must still verify.
    const ev = knownAnswerEvidence(halRow);
    expect(ev.oracleId).toBe(KNOWN_ANSWER_ORACLE);
    expect(ev.hash).toBe('340d9fb32800d6eca94b2fd5f1f0188d344bb4748e28e7eec4983a14e4789d8a');
  });

  test("an 'abstain' key with no commitment is still not scorable", () => {
    const c = knownAnswerEvidence({ ...halRow, expected: 'abstain', result: answer('abstain') }).content;
    expect(parseKnownAnswer(c).expected).toBeNull();
    for (const v of Object.values(SCORING_VERSIONS)) expect(v.score(c)).toBeNull();
  });

  test('active settlement still works for the hal_test_cases key', async () => {
    const { store, inserted } = memStore();
    const r = await settleExperimental({ agentId: APM.id, evidence: knownAnswerEvidence(halRow), version: V }, { store, mode: 'active' });
    expect(r).toMatchObject({ status: 'settled', mode: 'active', delta: 1 });
    expect(inserted).toHaveLength(1);
  });
});

describe('commit-reveal key: grading', () => {
  test.each([
    // [expected, decision, confidence, ka-v2 delta]
    ['pass', 'pass', 0.9, 1],
    ['veto', 'pass', 0.8, -1.8],
    ['abstain', 'veto', 1, -2],      // rehearsal 1 item #9: "tests skipped" answered with a sure veto
    ['abstain', 'abstain', undefined, 0], // the precommitted rule pays a correct abstain nothing
    ['veto', 'abstain', undefined, 0],
  ])('key %s, answer %s (conf %s) -> %s', (expected, decision, conf, delta) => {
    const ev = knownAnswerEvidence(revealRow(expected as string, 'n1', { result: answer(decision as string, conf as number | undefined) }));
    expect(ev.oracleId).toBe(COMMIT_REVEAL_ORACLE);
    expect(SCORING_VERSIONS[V]!.score(ev.content)).toBeCloseTo(delta as number, 10);
  });
});

describe('commit-reveal key: settlement refuses forgeries and active', () => {
  test('a genuine reveal settles in shadow and records the commit-reveal oracle', async () => {
    const { store, inserted } = memStore();
    const r = await settleExperimental({ agentId: APM.id, evidence: knownAnswerEvidence(revealRow('abstain', 'n1')), version: V }, { store, mode: 'shadow' });
    expect(r).toMatchObject({ status: 'settled', mode: 'shadow', delta: -2 });
    expect(inserted).toHaveLength(1);
    expect(inserted[0]).toMatchObject({ oracle_id: COMMIT_REVEAL_ORACLE, mode: 'shadow', evidence_id: 'trinity_tasks:438340' });
    expect(inserted[0]!.metadata).toMatchObject({ expected: 'abstain', decision: 'veto' });
  });

  test('a rewritten answer that keeps the dispatch-time commitment is refused, and writes nothing', async () => {
    const { store, inserted } = memStore();
    const genuine = revealRow('abstain', 'n1');
    // The forger re-reveals the key as 'veto' so the sure veto scores +1, keeps the real commitment, and re-seals.
    const forged = sealEvidence({ ...knownAnswerEvidence(genuine), content: { ...knownAnswerEvidence(genuine).content, expected: 'veto' } });
    expect(await settleExperimental({ agentId: APM.id, evidence: forged, version: V }, { store, mode: 'shadow' }))
      .toEqual({ status: 'refused', reason: 'reveal_mismatch' });
    // A changed nonce, or no commitment at all, fails the same way.
    const badNonce = sealEvidence({ ...knownAnswerEvidence(genuine), content: { ...knownAnswerEvidence(genuine).content, nonce: 'n2' } });
    const noCommit = sealEvidence({ ...knownAnswerEvidence(genuine), content: { ...knownAnswerEvidence(genuine).content, commitment: '' } });
    for (const evidence of [badNonce, noCommit]) {
      expect(await settleExperimental({ agentId: APM.id, evidence, version: V }, { store, mode: 'shadow' }))
        .toEqual({ status: 'refused', reason: 'reveal_mismatch' });
    }
    expect(inserted).toHaveLength(0);
  });

  test('active mode is refused for the commit-reveal key and writes nothing', async () => {
    const { store, inserted } = memStore();
    expect(await settleExperimental({ agentId: APM.id, evidence: knownAnswerEvidence(revealRow('pass', 'n1', { result: answer('pass', 1) })), version: V }, { store, mode: 'active' }))
      .toEqual({ status: 'refused', reason: 'shadow_only_oracle' });
    expect(inserted).toHaveLength(0);
  });

  test('any third oracle is still refused', async () => {
    const { store, inserted } = memStore();
    const ev = sealEvidence({ ...knownAnswerEvidence(revealRow('pass', 'n1')), oracleId: 'answer_key:my_own_file' });
    expect(await settleExperimental({ agentId: APM.id, evidence: ev, version: V }, { store, mode: 'shadow' }))
      .toEqual({ status: 'refused', reason: 'oracle_not_answer_key' });
    expect(inserted).toHaveLength(0);
  });
});

// ── loader: a fake client that supports select().in() and records what it was asked ───────────
function fakeClient(tables: Record<string, any[]>) {
  const asked: string[] = [];
  return {
    asked,
    client: {
      from(table: string) {
        return {
          select(_cols: string) {
            return {
              in(col: string, vals: unknown[]) {
                asked.push(`${table}.${col}`);
                const set = new Set(vals.map(String));
                return Promise.resolve({ data: (tables[table] ?? []).filter((r) => set.has(String(r[col]))), error: null });
              },
            };
          },
          insert() { throw new Error(`loader must not write (${table})`); },
        };
      },
    } as any,
  };
}

describe('loadCommitRevealRows', () => {
  const nonce = 'aa11';
  const commitment = answerCommitment('veto', nonce);
  const task = (over: Record<string, unknown> = {}) => ({
    id: 101, claimed_by: 'trinity-apm', result: answer('veto', 0.9),
    metadata: { case_id: 'c-101', answer_commitment_sha256: commitment }, ...over,
  });

  const agents = [{ id: APM.id, agent_id: 'trinity-apm' }];

  test('a reveal that opens the published commitment, which the row still carries, is accepted', async () => {
    const { client } = fakeClient({ trinity_tasks: [task()], repid_agents: agents });
    const { rows, rejected } = await loadCommitRevealRows([{ task_id: 101, case_id: 'c-101', expected: 'veto', nonce, commitment }], client);
    expect(rejected).toEqual([]);
    expect(revealIsClean(rejected)).toBe(true);
    expect(rows).toEqual([{ task_id: '101', claimed_by: 'trinity-apm', case_id: 'c-101', result: answer('veto', 0.9), expected: 'veto', subject_agent_id: APM.id, commitment, nonce }]);
  });

  test('metadata stored as a JSON string is read the same way', async () => {
    const t = task({ metadata: JSON.stringify({ case_id: 'c-101', answer_commitment_sha256: commitment }) });
    const { client } = fakeClient({ trinity_tasks: [t], repid_agents: agents });
    const { rows } = await loadCommitRevealRows([{ task_id: '101', case_id: 'c-101', expected: 'veto', nonce, commitment }], client);
    expect(rows).toHaveLength(1);
  });

  test("Strix #1544: deleting a wrong answer's commitment does not improve the score, it voids the measurement", async () => {
    // Two answers by the same agent: 102 is right, 101 is wrong (key abstain, answered a sure veto).
    // The answerer deletes 101's commitment from its own row, hoping 101 drops out instead of costing -(1 + confidence).
    const n2 = 'cc33';
    const c1 = answerCommitment('abstain', nonce), c2 = answerCommitment('veto', n2);
    const { client } = fakeClient({ trinity_tasks: [
      task({ metadata: { case_id: 'c-101' } }), // commitment deleted after dispatch
      task({ id: 102, metadata: { case_id: 'c-102', answer_commitment_sha256: c2 } }),
    ], repid_agents: agents });
    const { rows, rejected } = await loadCommitRevealRows([
      { task_id: 101, case_id: 'c-101', expected: 'abstain', nonce, commitment: c1 },
      { task_id: 102, case_id: 'c-102', expected: 'veto', nonce: n2, commitment: c2 },
    ], client);
    expect(rows.map((r) => r.task_id)).toEqual(['102']);
    expect(rejected).toEqual([{ task_id: '101', reason: 'no_commitment' }]);
    expect(revealIsClean(rejected)).toBe(false); // the reveal command then exits 1 and settles nothing
  });

  test('any rejection, even not_answered, makes the reveal unclean', () => {
    expect(revealIsClean([])).toBe(true);
    for (const reason of ['not_answered', 'unknown_agent', 'bad_reveal'] as const) {
      expect(revealIsClean([{ task_id: '1', reason }])).toBe(false);
    }
  });

  test.each([
    ['a different answer', { expected: 'pass' }, {}, 'reveal_mismatch'],
    ['a different nonce', { nonce: 'bb22' }, {}, 'reveal_mismatch'],
    ['a published commitment the answer does not open', { commitment: answerCommitment('pass', 'aa11') }, {}, 'reveal_mismatch'],
    ['a reveal naming no published commitment', { commitment: '' }, {}, 'bad_reveal'],
    ['a different item', { case_id: 'c-999' }, {}, 'case_id_mismatch'],
    ['a row whose commitment was deleted', {}, { metadata: { case_id: 'c-101' } }, 'no_commitment'],
    ['a row whose commitment was replaced', {}, { metadata: { case_id: 'c-101', answer_commitment_sha256: answerCommitment('pass', 'zz99') } }, 'commitment_changed'],
    ['an unanswered row', {}, { result: null }, 'not_answered'],
    ['an unclaimed row', {}, { claimed_by: null }, 'not_answered'],
    ['an unknown claimer', {}, { claimed_by: 'trinity-ghost' }, 'unknown_agent'],
    ['a task that does not exist', { task_id: 999 }, {}, 'task_not_found'],
    ['a malformed key', { expected: 'maybe' }, {}, 'bad_reveal'],
    ['a missing nonce', { nonce: '' }, {}, 'bad_reveal'],
  ])('%s is rejected (%s)', async (_label, revealOver, taskOver, reason) => {
    const { client } = fakeClient({ trinity_tasks: [task(taskOver)], repid_agents: agents });
    const r = { task_id: 101 as string | number, case_id: 'c-101', expected: 'veto', nonce, commitment, ...revealOver };
    const { rows, rejected } = await loadCommitRevealRows([r], client);
    expect(rows).toEqual([]);
    expect(rejected).toEqual([{ task_id: String(r.task_id), reason }]);
    expect(revealIsClean(rejected)).toBe(false);
  });

  test('parseRevealFile takes a bare array or {items}, and refuses anything else', () => {
    const item = { task_id: 1, case_id: 'c', expected: 'pass', nonce: 'n', commitment: answerCommitment('pass', 'n') };
    expect(parseRevealFile([item])).toEqual([item]);
    expect(parseRevealFile({ items: [item] })).toEqual([item]);
    expect(() => parseRevealFile({ rows: [item] })).toThrow();
  });
});

describe('keyVsBridge', () => {
  test('a key that follows the answer is reported as such, beside a bridge that does not', () => {
    const rows = [
      revealRow('pass', 'a', { task_id: '1', result: answer('pass', 0.9) }),
      revealRow('veto', 'b', { task_id: '2', result: answer('veto', 0.8) }),
      revealRow('abstain', 'c', { task_id: '3', result: answer('veto', 1) }),
      revealRow('abstain', 'd', { task_id: '4', result: answer('abstain', 0.4) }),
      revealRow('pass', 'e', { task_id: '5', result: 'no json here' }),
    ];
    // bridge: down on a right answer, up on the wrong one, nothing recorded for task 4
    const bridge = new Map<string, number>([['1', 2], ['2', -3], ['3', 1], ['5', 0]]);
    const s = keyVsBridge(rows, bridge);
    expect(s).toMatchObject({ graded: 4, right: 2, right_abstain: 1, wrong: 1, abstained: 0, not_scorable: 1, key_follows_answer: true });
    expect(s.bridge_on_right).toEqual({ up: 1, down: 1, zero: 0, missing: 1 });
    expect(s.bridge_on_wrong).toEqual({ up: 1, down: 0, zero: 0, missing: 0 });
  });

  test('NON-VACUITY: a scorer that ignores the key is caught as not following the answer', () => {
    const real = SCORING_VERSIONS[V]!;
    SCORING_VERSIONS['test-ignores-key'] = { ...real, score: () => 1 };
    try {
      const rows = [revealRow('abstain', 'c', { task_id: '3', result: answer('veto', 1) })];
      expect(keyVsBridge(rows, new Map(), 'test-ignores-key').key_follows_answer).toBe(false);
    } finally {
      delete SCORING_VERSIONS['test-ignores-key'];
    }
  });

  test('loadBridgeDeltas reads the bridge rows by their idempotency key and maps them back to task ids', async () => {
    const { client, asked } = fakeClient({ repid_score_events: [
      { idempotency_key: 'trinity_task_bridge_1', repid_delta_calculated: -2 },
      { idempotency_key: 'trinity_task_bridge_2', repid_delta_calculated: null },
    ] });
    const m = await loadBridgeDeltas(['1', '2', '3'], client);
    expect([...m]).toEqual([['1', -2]]);
    expect(asked).toEqual(['repid_score_events.idempotency_key']);
  });
});
