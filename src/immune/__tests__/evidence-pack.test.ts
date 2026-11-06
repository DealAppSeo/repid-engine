import { evidencePack, citedTaskId, type PackRow } from '../evidence-pack';

// A clean same-controller shadow row (the shape the live 656 rows have: each cites its trinity_task + a hash).
const row = (over: Partial<PackRow> = {}): PackRow => ({
  mode: 'shadow',
  dimension: 'validator',
  eligibility: 'same_controller_measured',
  scoring_version: 'ka-v2-precommitted',
  oracle_id: 'answer_key:hal_test_cases.expected_decision',
  agent_id: 'agent-uuid-1',
  evidence_kind: 'known_answer',
  evidence_id: 'trinity_tasks:t1',
  evidence_ref: 'trinity_tasks/t1;hal_test_cases/c1',
  evidence_hash: 'a'.repeat(64),
  delta: 1,
  ...over,
});

describe('evidencePack', () => {
  it('groups by mode/dimension/controller-class/ruler/evidence-kind and tallies +/- delta; clean net-negative set is ok with no net-positive signal', () => {
    const rows = [
      row({ dimension: 'validator', delta: 1 }),
      row({ dimension: 'validator', delta: -2 }),
      row({ dimension: 'calibration', scoring_version: 'brier-v1', delta: 0 }),
    ];
    const p = evidencePack(rows);
    expect(p.total).toBe(3);
    expect(p.byMode).toEqual({ shadow: 3 });
    expect(p.byDimension['validator']).toEqual({ n: 2, pos: 1, neg: 1, zero: 0, net: -1 });
    expect(p.byDimension['calibration']).toEqual({ n: 1, pos: 0, neg: 0, zero: 1, net: 0 });
    expect(p.byControllerClass['same_controller_measured']!.net).toBe(-1);
    expect(p.byScoringVersion).toEqual({ 'ka-v2-precommitted': 2, 'brier-v1': 1 });
    expect(p.byEvidenceKind).toEqual({ known_answer: 3 });
    expect(p.ok).toBe(true);
    expect(p.signals.find((s) => s.name === 'same_controller_net_positive')).toBeUndefined(); // net is negative → no net-positive signal
    expect(p.signals.find((s) => s.name === 'task_existence_check_skipped')).toBeDefined();    // task-citing rows, no taskEvidence → skipped existence check is surfaced
  });

  it('SIGNAL: a net-positive same-controller class is surfaced (non-gating; ok stays true)', () => {
    const p = evidencePack([row({ delta: 1 }), row({ delta: 1 })]);
    expect(p.ok).toBe(true); // a signal does not fail the pack
    const sig = p.signals.find((s) => s.name === 'same_controller_net_positive')!;
    expect(sig).toBeDefined();
    expect(sig.detail).toMatchObject({ n: 2, pos: 2, neg: 0, net: 2 });
  });

  it('TRIPWIRE: an independent_counterparty row is surfaced, not passed silently', () => {
    const p = evidencePack([row(), row({ eligibility: 'independent_counterparty', agent_id: 'a', oracle_id: 'o' })]);
    const inv = p.invariants.find((i) => i.name === 'no_independent_counterparty')!;
    expect(inv.held).toBe(false);
    expect(inv.count).toBe(1);
    expect(p.ok).toBe(false);
    expect(p.byControllerClass['independent_counterparty']!.n).toBe(1);
  });

  it('TRIPWIRE: an active-mode row fails shadow_only', () => {
    const p = evidencePack([row({ mode: 'active' })]);
    expect(p.invariants.find((i) => i.name === 'shadow_only')!.held).toBe(false);
    expect(p.ok).toBe(false);
  });

  it('TRIPWIRE: oracle_id === agent_id is self-dealing', () => {
    const p = evidencePack([row({ oracle_id: 'same', agent_id: 'same' })]);
    expect(p.invariants.find((i) => i.name === 'no_self_dealing')!.held).toBe(false);
    expect(p.ok).toBe(false);
  });

  it('TRIPWIRE (r24): a row with no scoring_version has no ruler', () => {
    const p = evidencePack([row({ scoring_version: '' })]);
    expect(p.invariants.find((i) => i.name === 'every_measurement_has_a_ruler')!.held).toBe(false);
    expect(p.byScoringVersion['(none)']).toBe(1);
    expect(p.ok).toBe(false);
  });

  it('TRIPWIRE (grounding): a delta that does not cite its task evidence fails', () => {
    const p = evidencePack([row({ evidence_hash: '' })]);
    const inv = p.invariants.find((i) => i.name === 'every_delta_cites_task_evidence')!;
    expect(inv.held).toBe(false);
    expect(inv.count).toBe(1);
    expect(p.ok).toBe(false);
  });

  it('coerces a numeric-string delta (as pg returns it) and sums net correctly', () => {
    const p = evidencePack([row({ delta: '0.2475' }), row({ delta: '1' }), row({ delta: '-1.95' })]);
    expect(p.byDimension['validator']!.net).toBeCloseTo(-0.7025, 6);
    expect(p.byDimension['validator']).toMatchObject({ n: 3, pos: 2, neg: 1, zero: 0 });
  });

  it('empty input is ok (no rows, all invariants vacuously hold, no signals)', () => {
    const p = evidencePack([]);
    expect(p.total).toBe(0);
    expect(p.ok).toBe(true);
    expect(p.signals).toHaveLength(0);
  });

  // ── increment 2: opt-in cited-task existence join (reducer stays pure; caller resolves task state) ──
  it('no taskEvidence ⇒ increment-1 behaviour: citedTasks null, no task-existence invariants', () => {
    const p = evidencePack([row(), row()]);
    expect(p.citedTasks).toBeNull();
    expect(p.invariants.map((i) => i.name)).not.toContain('cited_task_exists');
    expect(p.invariants).toHaveLength(5);
  });

  it('cited tasks all exist AND are done ⇒ both increment-2 invariants hold; citedTasks summary is exact', () => {
    const rows = [row({ evidence_id: 'trinity_tasks:t1' }), row({ evidence_id: 'trinity_tasks:t2' }), row({ evidence_id: 'trinity_tasks:t1' })];
    const p = evidencePack(rows, { existing: ['t1', 't2'], done: ['t1', 't2'], doneBar: 'has a non-null result' });
    expect(p.invariants.find((i) => i.name === 'cited_task_exists')!.held).toBe(true);
    expect(p.invariants.find((i) => i.name === 'cited_task_verified_done')!.held).toBe(true);
    expect(p.citedTasks).toEqual({ cited: 2, existing: 2, done: 2, missingRows: 0, notDoneRows: 0 });
    expect(p.ok).toBe(true);
  });

  it('TRIPWIRE (increment 2): a row citing a task that does not exist fails cited_task_exists', () => {
    const p = evidencePack([row({ evidence_id: 'trinity_tasks:real' }), row({ evidence_id: 'trinity_tasks:ghost' })], { existing: ['real'], done: ['real'] });
    const inv = p.invariants.find((i) => i.name === 'cited_task_exists')!;
    expect(inv.held).toBe(false);
    expect(inv.count).toBe(1);           // one row cites a non-existent task
    expect(p.citedTasks!.missingRows).toBe(1);
    expect(p.ok).toBe(false);
  });

  it('TRIPWIRE (increment 2): a cited task that exists but is NOT done fails cited_task_verified_done', () => {
    const p = evidencePack([row({ evidence_id: 'trinity_tasks:answered' }), row({ evidence_id: 'trinity_tasks:unanswered' })], { existing: ['answered', 'unanswered'], done: ['answered'] });
    expect(p.invariants.find((i) => i.name === 'cited_task_exists')!.held).toBe(true);   // both exist
    expect(p.invariants.find((i) => i.name === 'cited_task_verified_done')!.held).toBe(false); // one unanswered
    expect(p.citedTasks).toMatchObject({ cited: 2, existing: 2, done: 1, notDoneRows: 1 });
    expect(p.ok).toBe(false);
  });

  it('citedTaskId parses a task citation and returns null for a non-task evidence_id', () => {
    expect(citedTaskId('trinity_tasks:12345')).toBe('12345');
    expect(citedTaskId('0xdeadbeef')).toBeNull();           // an immune content hash is not a task citation
    expect(citedTaskId('')).toBeNull();
  });

  // ── no-silent-failure: a skipped existence check must be SEEN, never read as a pass ──
  it('SIGNAL: task-citing rows with NO taskEvidence surface task_existence_check_skipped (non-gating)', () => {
    const p = evidencePack([row({ evidence_id: 'trinity_tasks:t1' }), row({ evidence_id: 'trinity_tasks:t1' }), row({ evidence_id: 'trinity_tasks:t2' })]);
    expect(p.citedTasks).toBeNull();                                  // increment-2 did not run
    const sig = p.signals.find((s) => s.name === 'task_existence_check_skipped')!;
    expect(sig).toBeDefined();
    expect(sig.detail).toEqual({ citing_rows: 3, cited_tasks: 2 });   // rows vs distinct tasks
    expect(p.ok).toBe(true);                                          // non-gating: the opt-in is intentional
  });

  it('no task_existence_check_skipped signal when taskEvidence IS supplied (the join ran)', () => {
    const p = evidencePack([row({ evidence_id: 'trinity_tasks:t1' })], { existing: ['t1'], done: ['t1'] });
    expect(p.signals.find((s) => s.name === 'task_existence_check_skipped')).toBeUndefined();
  });

  it('no task_existence_check_skipped signal when no row cites a task (nothing to check)', () => {
    const p = evidencePack([row({ evidence_id: '0xdeadbeef', evidence_ref: 'immune', evidence_hash: 'b'.repeat(64) })]);
    expect(p.signals.find((s) => s.name === 'task_existence_check_skipped')).toBeUndefined();
  });

  // ── D-147: a COMPLETE claim requires the task-existence check to have ACTUALLY RUN ──
  it('COMPLETENESS: task-citing rows with NO taskEvidence are ok (grounded) but NOT complete', () => {
    const p = evidencePack([row({ evidence_id: 'trinity_tasks:t1' }), row({ evidence_id: 'trinity_tasks:t2' })]);
    expect(p.ok).toBe(true);        // increment-1 grounding holds
    expect(p.complete).toBe(false); // but existence was never verified → not a complete claim (D-147)
    expect(p.signals.find((s) => s.name === 'task_existence_check_skipped')).toBeDefined();
  });

  it('COMPLETENESS: task-citing rows WITH a passing taskEvidence join are complete', () => {
    const p = evidencePack([row({ evidence_id: 'trinity_tasks:t1' })], { existing: ['t1'], done: ['t1'] });
    expect(p.ok).toBe(true);
    expect(p.complete).toBe(true); // the existence/done join ran and passed
  });

  it('COMPLETENESS: a failing existence join is ok:false and complete:false', () => {
    const p = evidencePack([row({ evidence_id: 'trinity_tasks:ghost' })], { existing: [], done: [] });
    expect(p.ok).toBe(false);
    expect(p.complete).toBe(false); // check ran but failed → neither ok nor complete
  });

  it('COMPLETENESS: a pack whose rows cite no tasks is complete when ok (nothing to verify)', () => {
    const p = evidencePack([row({ evidence_id: '0xabc', evidence_ref: 'immune', evidence_hash: 'c'.repeat(64) })]);
    expect(p.ok).toBe(true);
    expect(p.complete).toBe(true); // no task citations → the existence check is vacuous, completeness holds
  });

  it('COMPLETENESS: an increment-1 invariant failure makes a non-task pack incomplete too', () => {
    const p = evidencePack([row({ evidence_id: '0xabc', evidence_ref: 'immune', evidence_hash: 'c'.repeat(64), scoring_version: '' })]);
    expect(p.ok).toBe(false);       // missing ruler
    expect(p.complete).toBe(false); // complete can never exceed ok
  });

  it('COMPLETENESS: empty input is complete (ok, nothing cited)', () => {
    const p = evidencePack([]);
    expect(p.ok).toBe(true);
    expect(p.complete).toBe(true);
  });
});
