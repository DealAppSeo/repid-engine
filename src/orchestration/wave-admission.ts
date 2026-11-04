/**
 * orchestration/wave-admission.ts — the seam the T12 free-swarm wave calls BEFORE a task is claimed, so an
 * under-equipped agent abstains instead of fabricating (the 2026-11-03 failure). It wraps the pure admission
 * gate (task-admission.ts) with the two things a live wave needs and the pure gate deliberately omits:
 *   1. a SHADOW/ENFORCE mode, default SHADOW, so wiring it into the live wave changes NOTHING until ratified; and
 *   2. the structured RECORD to persist on the task's evidence (the manifest, or the named gap).
 *
 * SHADOW IS THE DEFAULT, AND IT IS INERT (CLAUDE_RULES r23). In 'shadow' the claim is ALWAYS allowed — the wave
 * runs exactly as it does today — and we only RECORD what 'enforce' WOULD have done (accept + manifest, or
 * abstain + missing). That is the measurement: how often an unequipped agent WOULD have abstained instead of
 * fabricating, taken with zero change to live behaviour. Flipping to 'enforce' (an abstention actually blocks the
 * claim) is the owner-gated ratification step after Sean has seen a shadow run — it is NOT done here.
 *
 * WHERE THE RECORD GOES. `record` is attached as event_data on the task's `recorded` evidence event via the
 * append-only store (immune/receipt-store.ts, merged) when the task produces a receipt; for an abstention there
 * is no receipt, so the wave logs the abstention record to the shadow sink instead. Either way it is a shadow
 * write — never a live score, never RepID, never a public surface.
 *
 * NOT HERE (waits on the settle path, PR #1501). Owner-assurance (owner-classes.assessIndependence) is a PAIRWISE
 * maker-vs-checker verdict recorded at SETTLEMENT, not at claim time (a claim has one party). It belongs on the
 * experimental settlement event, which is the M3(a) settle path — wire it there once #1501 lands, not in this seam.
 *
 * PURE + INERT. No I/O, no DB, no clock, no flag read. The caller passes the mode (default 'shadow') and the
 * agent's held capabilities; nothing here claims, scores, writes, or blocks on its own.
 */
import { admitTask, type AdmissionDecision, type Capability, type TaskDescriptor } from './task-admission';

export type WaveAdmissionMode = 'shadow' | 'enforce';

/** The structured record persisted on the task's evidence (event_data) — the manifest equipped, or the gap. */
export interface AdmissionRecord {
  required: Capability[];
  manifest: Capability[];
  missing: Capability[];
  accepted: boolean;
}

export interface WaveAdmissionResult {
  /** whether the wave may CLAIM the task. Always true in 'shadow' (inert); = accepted in 'enforce'. */
  claimAllowed: boolean;
  /** 'shadow' recorded the decision without acting on it; 'enforce' acted on it. */
  mode: WaveAdmissionMode;
  /** the full admission decision (required / missing / manifest / reason). */
  decision: AdmissionDecision;
  /** what to persist on the task's evidence (shadow sink / receipt event_data). */
  record: AdmissionRecord;
}

/**
 * Decide admission for one wave task. Pure, total, never throws. Default mode 'shadow' ⇒ claimAllowed is always
 * true (the wave is unchanged) and the decision is only recorded; 'enforce' ⇒ an abstention blocks the claim.
 */
export function waveAdmission(input: {
  task: TaskDescriptor;
  held: readonly Capability[];
  mode?: WaveAdmissionMode;
}): WaveAdmissionResult {
  const mode: WaveAdmissionMode = input.mode ?? 'shadow';
  const decision = admitTask({ task: input.task, held: input.held });
  return {
    claimAllowed: mode === 'enforce' ? decision.accepted : true,
    mode,
    decision,
    record: {
      required: decision.required,
      manifest: decision.manifest,
      missing: decision.missing,
      accepted: decision.accepted,
    },
  };
}
