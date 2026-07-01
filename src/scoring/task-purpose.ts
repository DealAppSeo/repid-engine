/**
 * task-purpose.ts — purpose-aware gate for RepID/HAL scoring.
 *
 * REPID_HONEST_SCORING_v1: a HAL hallucination-veto should only move RepID on REAL
 * deliverables. Internal cron, DB-fact/operational tasks (which cross-LLM literally
 * cannot verify — no world-knowledge ground truth for "count tasks by status"),
 * adversarial red-team drills (tests, not work), and peer-verify/monitoring chores
 * are NOT hallucination-veto surfaces. Vetoing them false-flagged agents to the floor.
 *
 * This is `w_purpose` in the §7.1 update chain — a weight, not a binary exclude:
 * real deliverable = 1.0; non-deliverable veto = 0 (logged for calibration, never scored).
 * Weights are epoch-tunable — Sean owns the final values.
 *
 * Pure + deterministic. No I/O. Keyed primarily off task_domain (reliable), prompt secondary.
 */

export type TaskPurpose =
  | 'deliverable'   // real work product — HAL cross-LLM veto applies, full weight
  | 'operational'   // internal cron / DB-fact (count/query/report) — cross-LLM cannot verify
  | 'drill'         // CAIT adversarial red-team test — logged, never scores RepID
  | 'peer_verify'   // routes to peer-verify scoring, not a hallucination veto
  | 'monitoring';   // review/monitoring chores — not a deliverable

export interface PurposeVerdict {
  purpose: TaskPurpose;
  halVetoApplies: boolean; // does a HAL cross-LLM veto legitimately move RepID here?
  weight: number;          // multiplier on a HAL penalty (0..1) — `w_purpose`
  reason: string;
}

/**
 * Classify a task's scoring purpose from its domain (= task.task_type on the bridge)
 * and, secondarily, the prompt text. Default = real deliverable (full HAL scoring) so
 * an unknown/new domain is scored normally, not silently excused.
 */
export function classifyTaskPurpose(
  taskDomain: string | null | undefined,
  prompt?: string | null,
): PurposeVerdict {
  const d = (taskDomain || 'general').toLowerCase();
  const p = (prompt || '').toLowerCase();

  // Adversarial drills — tests. Never score reputation; keep telemetry for HAL calibration.
  if (d === 'cait' || /\bhal veto self-test|jailbreak|prompt.?injection|red.?team|adversarial\b/.test(p)) {
    return { purpose: 'drill', halVetoApplies: false, weight: 0,
      reason: 'adversarial drill (CAIT) — logged for calibration, not scored' };
  }

  // Internal cron / operational DB-fact — cross-LLM has no ground truth for operational data.
  if (d === 'evergreen' || d === 'system'
      || /\b(count|query|sample|monitor|report|review|check)\b[\s\S]{0,40}\b(task|registry|log|store|status|kv_store|cost|completion|queue|row)/.test(p)) {
    return { purpose: 'operational', halVetoApplies: false, weight: 0,
      reason: 'operational/DB-fact — verify against DB not cross-LLM; no world-knowledge ground truth' };
  }

  // Peer-verify / review — route to the peer-verify scoring surface, not a hallucination veto.
  if (d === 'peer_verify') {
    return { purpose: 'peer_verify', halVetoApplies: false, weight: 0,
      reason: 'peer_verify — routes to peer-verify scoring, not a hallucination veto' };
  }
  if (d === 'review' || d === 'monitoring') {
    return { purpose: 'monitoring', halVetoApplies: false, weight: 0,
      reason: `${d} — monitoring chore, not a deliverable` };
  }

  // Default: real deliverable — full HAL cross-LLM veto scoring.
  return { purpose: 'deliverable', halVetoApplies: true, weight: 1,
    reason: 'real deliverable — HAL cross-LLM veto applies at full weight' };
}
