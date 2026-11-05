/**
 * immune/evidence-pack.ts — the Evidence Pack experimental aggregation (increment 1: inert, single-table).
 *
 * Roadmap IMMUNE_PIPELINE_ROADMAP_2026-11-03 (D-130), EVIDENCE PACK table: the "656 experimental rows"
 * claim must become "grouped by shadow/active, dimension, +/- delta, controller class, task evidence"
 * because "numbers need stronger proof than counts" (656 events != 656 successful tasks).
 *
 * PURE + READ-ONLY. Reduces repid_experimental_events rows into a defensible, invariant-checked view. It
 * writes nothing, moves no RepID, reads no canonical table, and has zero callers wired into any scoring
 * path — the reducer IS the brick; the caller supplies the rows. Safe to ship (r23: cannot change live state).
 *
 * It is a TRIPWIRE (antifragile / no-silent-failure), in two layers:
 *   invariants[] — must ALL hold for the pack to be publishable; any failure sets ok=false.
 *   signals[]    — surfaced-but-non-gating observations the reader must SEE, not a pass/fail. The point is
 *                  that the net-positive same-controller delta (self-measured evidence scoring itself well)
 *                  is impossible to miss, so nobody mistakes it for independent reputation.
 *
 * SCOPE. Increment 1 grounds each delta in the task-evidence PROVENANCE its own row carries (evidence_id cites
 * trinity_tasks:<id>, plus evidence_ref + a content hash) — the evidence IS cited. Increment 2 (OPT-IN: pass
 * `taskEvidence`) cross-joins that citation to real task state the CALLER resolves: every cited trinity_tasks:<id>
 * must resolve to a real task row (cited_task_exists) AND be verified done by the caller's bar (cited_task_verified_done).
 * The reducer stays PURE — the caller runs the read-only trinity_tasks query and passes the existing/done id sets in,
 * exactly as it passes the rows. Omit `taskEvidence` and the reducer behaves as increment 1 (no task-existence invariant).
 *
 * DONE-BAR, verified live [V 2026-11-04]: the 656 live rows cite 330 distinct tasks; all 330 EXIST, all 330 have a
 * non-null `result`, and all 330 are `status='done'` with known-answer lineage — 0 are `status='completed'` (the
 * lifecycle marks done as 'done', NOT 'completed'; a `status='completed'` literal false-alarms on all 330). The code's
 * own done-bar is `result IS NOT NULL` (`loadKnownAnswerRows` filters on that, never status). So "done" = has a result;
 * the caller names its exact bar in `doneBar`, recorded on the invariant.
 *
 * Read query (copy-paste, read-only; agent_id cast to text so the reducer never needs the uuid type):
 *   SELECT mode, dimension, eligibility, scoring_version, oracle_id, agent_id::text AS agent_id,
 *          evidence_kind, evidence_id, evidence_ref, evidence_hash, delta
 *   FROM repid_experimental_events;
 *
 * Column domains (from services/experimental-repid.ts, kept as loose strings so the reducer is robust to DB
 * drift): mode ∈ off|shadow|active · eligibility ∈ same_controller_measured|independent_counterparty ·
 * dimension ∈ producer|validator|redteam|calibration|reliability|safety.
 */

/** The read-shape this reducer consumes — a lean subset of repid_experimental_events (strings as pg returns them; delta may arrive as a numeric string). */
export interface PackRow {
  mode: string;
  dimension: string;
  eligibility: string;
  scoring_version: string;
  oracle_id: string;
  agent_id: string;
  evidence_kind: string;
  evidence_id: string;
  evidence_ref: string;
  evidence_hash: string;
  delta: number | string;
}

/**
 * Increment 2 (opt-in): the real task state the caller resolved for the cited trinity_tasks ids, read-only.
 * `existing` = ids that resolve to a real trinity_tasks row; `done` = ids the caller confirms were actually done
 * (for known-answer that is "has a non-null result", NOT status='completed'). `doneBar` records what done meant.
 */
export interface TaskEvidenceLookup {
  existing: Iterable<string | number>;
  done: Iterable<string | number>;
  doneBar?: string;
}

const CITED_TASK_RE = /^trinity_tasks:(.+)$/;
/** The trinity_tasks id a row cites, or null when the evidence_id is not a task citation (e.g. an immune content hash). */
export function citedTaskId(evidenceId: string): string | null {
  const m = CITED_TASK_RE.exec((evidenceId ?? '').trim());
  return m ? m[1]!.trim() : null;
}

export interface DeltaTally { n: number; pos: number; neg: number; zero: number; net: number }
export interface Invariant { name: string; held: boolean; count: number; note: string }
export interface Signal { name: string; note: string; detail: Record<string, number> }

export interface EvidencePack {
  total: number;
  byMode: Record<string, number>;
  byDimension: Record<string, DeltaTally>;
  byControllerClass: Record<string, DeltaTally>; // keyed by eligibility
  byScoringVersion: Record<string, number>;      // the ruler (r24: a measurement carries its ruler)
  byEvidenceKind: Record<string, number>;        // what each delta was scored from
  invariants: Invariant[];
  signals: Signal[];                             // surfaced, non-gating
  /** Increment 2 (null unless taskEvidence was supplied): the cross-join of cited trinity_tasks:<id> to real task state. */
  citedTasks: { cited: number; existing: number; done: number; missingRows: number; notDoneRows: number } | null;
  /** true ⇒ every invariant held ⇒ safe to publish as same-controller shadow evidence, no independence claim. */
  ok: boolean;
}

const emptyTally = (): DeltaTally => ({ n: 0, pos: 0, neg: 0, zero: 0, net: 0 });

function addDelta(t: DeltaTally, d: number): void {
  t.n += 1;
  t.net += d;
  if (d > 0) t.pos += 1;
  else if (d < 0) t.neg += 1;
  else t.zero += 1;
}

const present = (s: string | undefined): boolean => !!s && s.trim() !== '';

export function evidencePack(rows: PackRow[], taskEvidence?: TaskEvidenceLookup): EvidencePack {
  const byMode: Record<string, number> = {};
  const byDimension: Record<string, DeltaTally> = {};
  const byControllerClass: Record<string, DeltaTally> = {};
  const byScoringVersion: Record<string, number> = {};
  const byEvidenceKind: Record<string, number> = {};
  let independentCount = 0;
  let activeCount = 0;
  let selfDealing = 0;
  let missingRuler = 0;
  let missingEvidence = 0;
  const existingSet = new Set<string>([...(taskEvidence?.existing ?? [])].map(String));
  const doneSet = new Set<string>([...(taskEvidence?.done ?? [])].map(String));
  const citedDistinct = new Set<string>();
  let citedRows = 0;
  let missingTaskRows = 0;
  let notDoneTaskRows = 0;

  for (const r of rows) {
    const parsed = Number(r.delta);
    const delta = Number.isFinite(parsed) ? parsed : 0; // never a silent NaN
    const mode = r.mode || 'unknown';
    const dim = r.dimension || 'unknown';
    const cls = r.eligibility || 'unknown';
    const ver = (r.scoring_version ?? '').trim();
    const kind = r.evidence_kind || 'unknown';

    byMode[mode] = (byMode[mode] ?? 0) + 1;
    addDelta((byDimension[dim] ??= emptyTally()), delta);
    addDelta((byControllerClass[cls] ??= emptyTally()), delta);
    byScoringVersion[ver || '(none)'] = (byScoringVersion[ver || '(none)'] ?? 0) + 1;
    byEvidenceKind[kind] = (byEvidenceKind[kind] ?? 0) + 1;

    if (cls === 'independent_counterparty') independentCount += 1;
    if (mode === 'active') activeCount += 1;
    if (r.oracle_id && r.oracle_id === r.agent_id) selfDealing += 1;
    if (!ver) missingRuler += 1;
    // grounding: every delta must CITE its task evidence (id + ref + content hash all present).
    if (!(present(r.evidence_id) && present(r.evidence_ref) && present(r.evidence_hash))) missingEvidence += 1;
    // increment 2: resolve the cited trinity_tasks:<id> against caller-supplied task state (only for task citations).
    const tid = citedTaskId(r.evidence_id);
    if (tid !== null) {
      citedRows += 1;
      citedDistinct.add(tid);
      if (taskEvidence) {
        if (!existingSet.has(tid)) missingTaskRows += 1;
        if (!doneSet.has(tid)) notDoneTaskRows += 1;
      }
    }
  }

  const invariants: Invariant[] = [
    {
      name: 'no_independent_counterparty',
      held: independentCount === 0,
      count: independentCount,
      note: 'independent-counterparty reputation is Sean-gated and deferred; shadow evidence must be same-controller only',
    },
    {
      name: 'shadow_only',
      held: activeCount === 0,
      count: activeCount,
      note: 'active rows can gate real decisions (shadow→active is Sean-gated); none expected before ratification',
    },
    {
      name: 'no_self_dealing',
      held: selfDealing === 0,
      count: selfDealing,
      note: 'oracle_id must never equal the scored agent (the settle path refuses it; this is the cross-check)',
    },
    {
      name: 'every_measurement_has_a_ruler',
      held: missingRuler === 0,
      count: missingRuler,
      note: 'r24: a row with no scoring_version (ruler) is not a result',
    },
    {
      name: 'every_delta_cites_task_evidence',
      held: missingEvidence === 0,
      count: missingEvidence,
      note: 'every delta must cite its task evidence (evidence_id + evidence_ref + evidence_hash); provenance-present, not task-existence (increment 2)',
    },
  ];

  if (taskEvidence) {
    invariants.push(
      {
        name: 'cited_task_exists',
        held: missingTaskRows === 0,
        count: missingTaskRows,
        note: 'increment 2: every row citing trinity_tasks:<id> must resolve to a real trinity_tasks row',
      },
      {
        name: 'cited_task_verified_done',
        held: notDoneTaskRows === 0,
        count: notDoneTaskRows,
        note: `increment 2: the cited task must be verified done (${taskEvidence.doneBar ?? 'caller-defined bar'})`,
      },
    );
  }

  // Non-gating: surface any same-controller class whose delta is net-positive — self-measured evidence
  // scoring itself up. Expected for known-answer, but it is the exact gaming-shaped signal that must be
  // visible so it is never mistaken for, or promoted to, independent-counterparty reputation.
  const signals: Signal[] = [];
  for (const [cls, t] of Object.entries(byControllerClass)) {
    if (cls === 'same_controller_measured' && t.net > 0) {
      signals.push({
        name: 'same_controller_net_positive',
        note: 'self-measured (same-controller) evidence is net-positive — visible by design; must NOT be promoted to independent reputation',
        detail: { n: t.n, pos: t.pos, neg: t.neg, net: Number(t.net.toFixed(4)) },
      });
    }
  }

  // No-silent-failure (r10 / THE_ONE §10): if rows CITE tasks but the caller supplied no taskEvidence, the
  // increment-2 existence/done join DID NOT run. `ok` then reflects increment-1 grounding only, not task
  // existence — so surface that the check was SKIPPED rather than let a green pack read as "existence verified".
  // This is distinct from a check that RAN and FAILED (the cited_task_exists invariant covers that). Non-gating:
  // the opt-in is intentional (a non-task caller shouldn't be forced to resolve task state), but any task-bearing
  // production use is expected to pass taskEvidence — this signal is the tripwire for when it doesn't.
  if (!taskEvidence && citedDistinct.size > 0) {
    signals.push({
      name: 'task_existence_check_skipped',
      note: 'rows cite trinity_tasks:<id> but no taskEvidence was supplied — the increment-2 existence/done join did not run; ok reflects increment-1 grounding only, not task existence',
      detail: { citing_rows: citedRows, cited_tasks: citedDistinct.size },
    });
  }

  return {
    total: rows.length,
    byMode,
    byDimension,
    byControllerClass,
    byScoringVersion,
    byEvidenceKind,
    invariants,
    signals,
    citedTasks: taskEvidence
      ? {
          cited: citedDistinct.size,
          existing: [...citedDistinct].filter((t) => existingSet.has(t)).length,
          done: [...citedDistinct].filter((t) => doneSet.has(t)).length,
          missingRows: missingTaskRows,
          notDoneRows: notDoneTaskRows,
        }
      : null,
    ok: invariants.every((i) => i.held),
  };
}
