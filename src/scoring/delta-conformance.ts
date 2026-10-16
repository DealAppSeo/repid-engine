/**
 * delta-conformance.ts — does the RepID delta in the ledger equal the delta the code says it should be?
 *
 * READ-ONLY BY CONSTRUCTION. This module takes `repid_score_events` rows (already SELECTed by the
 * caller) and returns a verdict per row. It never writes, and it imports the tariff from the SAME
 * modules the live writers use, so the spec cannot drift from the code it checks. If a writer's
 * constant changes, the expectation here changes with it; what this catches is a row the writer
 * produced that its own constant does not explain (a stale trigger, a second writer, a fallback).
 *
 * THREE ANSWERS, NEVER TWO. Every row is CONFORMS, DEVIATES or NOT_CHECKED. NOT_CHECKED is reported
 * with its reason and is never counted as conforming: env-tuned scorers (challenge via /score,
 * prediction, the exchange red-team base) have no committed value to compare against, and a row
 * whose writer cannot be identified is unexplained, not fine. LESSONS rule 5.
 *
 * Run it: `scripts/repid/delta-conformance.ts` (live SELECT or a JSON file of rows).
 */
import { computeDelta, type HALDecision } from './repid-delta';
import { FIXED_DELTAS } from './repid-deltas';
import { STARTING_REPID } from './repid-constants';
import {
  SERVICE_FULFILLED_DELTAS,
  SERVICE_SATISFIED_DELTA_BASE,
  SERVICE_DISPUTE_DELTAS,
  SERVICE_OUTCOME_BASE,
  CLAIMER_DELTAS,
  VALIDATOR_DELTAS,
  computeRaterWeight,
} from '../services/validation-repid-delta';
import { PANEL_DELTAS } from '../services/peer-verify-consensus';
import { REDTEAM_REWARDS } from '../testing/redteam-adjudication';

export interface ScoreEventRow {
  id: number | string;
  event_type: string;
  delta: number | null;
  repid_before: number | null;
  repid_after: number | null;
  repid_delta_calculated?: number | null;
  repid_delta_applied: number | null;
  hal_decision?: string | null;
  hal_score?: number | string | null;
  hallucination_caught?: boolean | null;
  is_shadow?: boolean | null;
  metadata?: Record<string, any> | null;
  contract_id?: string | null;
  created_at?: string;
  /** Optional join: the contract's deliverable verdict, for the no-reward-for-unverified-work check. */
  contract?: { verdict?: string | null; confident?: boolean | null; simulated?: boolean | null } | null;
}

export type Status = 'CONFORMS' | 'DEVIATES' | 'NOT_CHECKED';
export interface RowVerdict {
  id: number | string;
  event_type: string;
  check: string;
  status: Status;
  expected?: number | string;
  actual?: number | null;
  reason: string;
}

/** The spec table, rendered into the report so the doc and the check are one source. */
export const DELTA_SPEC: Array<{ check: string; event: string; rule: string; source: string }> = [
  { check: 'A2A_FULFILLED', event: 'SERVICE_FULFILLED', rule: `provider +${SERVICE_FULFILLED_DELTAS.provider}, buyer +${SERVICE_FULFILLED_DELTAS.buyer}; 0 if simulated`, source: 'services/validation-repid-delta.ts SERVICE_FULFILLED_DELTAS' },
  { check: 'A2A_SATISFIED', event: 'SERVICE_SATISFIED', rule: `provider round(${SERVICE_SATISFIED_DELTA_BASE.provider}*s), buyer round(${SERVICE_SATISFIED_DELTA_BASE.buyer}*s), s in [0,1]; 0 if simulated`, source: 'validation-repid-delta.ts SERVICE_SATISFIED_DELTA_BASE; s clamped by routes/v1/contracts.ts deriveSatisfyScore' },
  { check: 'A2A_OUTCOME', event: 'SERVICE_OUTCOME', rule: `provider round(base*w), base good ${SERVICE_OUTCOME_BASE.good} / ok 0 / bad ${SERVICE_OUTCOME_BASE.bad}, w = clamp(rater_repid/1000, .25, 2)`, source: 'validation-repid-delta.ts SERVICE_OUTCOME_BASE + RATER_WEIGHT' },
  { check: 'A2A_DISPUTE', event: 'VALIDATION_FAILED / SERVICE_FULFILLED (metadata.verdict)', rule: `provider_at_fault: provider ${SERVICE_DISPUTE_DELTAS.provider_at_fault.provider}, buyer +${SERVICE_DISPUTE_DELTAS.provider_at_fault.buyer}; buyer_at_fault: provider +${SERVICE_DISPUTE_DELTAS.buyer_at_fault.provider}, buyer ${SERVICE_DISPUTE_DELTAS.buyer_at_fault.buyer}; no_fault: none`, source: 'validation-repid-delta.ts SERVICE_DISPUTE_DELTAS (workers/dispute-resolution-worker.ts)' },
  { check: 'NO_REWARD_FOR_UNVERIFIED_WORK', event: 'SERVICE_FULFILLED', rule: 'no positive fulfilled delta when the deliverable verdict is VETO, UNDETERMINED, or a FAIL without confident:true', source: 'services/verdict.ts; sprint 2026-10-16 Lane B invariant' },
  { check: 'PANEL', event: 'VALIDATION_PASSED/FAILED, VALIDATOR_REWARD/PENALTY (metadata.panel)', rule: `producer +${PANEL_DELTAS.producerVerified}/${PANEL_DELTAS.producerDisputed}; verifier agree +${PANEL_DELTAS.agree}, diverge ${PANEL_DELTAS.diverge}`, source: 'services/peer-verify-consensus.ts PANEL_DELTAS (env-overridable; resolved in this process)' },
  { check: 'LEGACY_VALIDATION', event: 'VALIDATION_PASSED/FAILED, VALIDATOR_REWARD (metadata.tier_band)', rule: `claimer verified T2a +${CLAIMER_DELTAS.verified.T2a} / T3+ +${CLAIMER_DELTAS.verified.T3plus}; challenged ${CLAIMER_DELTAS.challenged.T2a} / ${CLAIMER_DELTAS.challenged.T3plus}; validator +${VALIDATOR_DELTAS.agreed_no_correctness}`, source: 'validation-repid-delta.ts CLAIMER_DELTAS / VALIDATOR_DELTAS' },
  { check: 'HAL', event: 'HAL_SCORE_EVENT', rule: 'calculated = round(computeDelta(decision, risk)): vetoed -10, clean 1+(0.5-risk)*4, flagged/abstain 0; a negative APPLIED delta needs hallucination_caught + quorum_met + no purpose suppression', source: 'scoring/repid-delta.ts computeDelta; scoring/pipeline.ts runScoreEvent; DB trg_hal_penalty_guard' },
  { check: 'HAL_PENALTY_GUARD', event: 'any row with hal_decision flagged/vetoed', rule: 'negative delta without hallucination_caught is zeroed (metadata.penalty_suppressed)', source: 'DB trg_hal_penalty_guard (migrations/2026-08-03-hal-penalty-guard-trigger-order.sql)' },
  { check: 'FIXED', event: Object.keys(FIXED_DELTAS).join('/'), rule: 'tariff value or 0 (STAKE needs an on-chain proof; self-reported positives need evidence)', source: 'scoring/repid-deltas.ts FIXED_DELTAS via engine/repid-update.ts' },
  { check: 'CHALLENGE_ROUTE', event: 'CHALLENGE_* / EPISTEMIC_VIOLATION (metadata.challengeId)', rule: 'WIN +25; LOSS in [-50, 0] (-50*c^2); EPISTEMIC in [-75, 0]; DRAW 0', source: 'routes/challenge.ts inline literals (NOT scoreChallengeOutcome — see path parity)' },
  { check: 'REDTEAM', event: 'VALIDATOR_REWARD/PENALTY, VALIDATION_FAILED (metadata.redteam_case)', rule: `finder +${REDTEAM_REWARDS.FINDER_REWARD}, subject -${REDTEAM_REWARDS.SUBJECT_PENALTY}, accuser -${REDTEAM_REWARDS.ACCUSER_PENALTY}`, source: 'testing/redteam-adjudication.ts REDTEAM_REWARDS' },
  { check: 'MENTORSHIP', event: 'VALIDATOR_REWARD (metadata.mentorship_pair_id)', rule: 'mentor +2', source: 'services/agent-mentorship.ts' },
  { check: 'GENESIS', event: 'GENESIS', rule: `delta 0, starts at STARTING_REPID ${STARTING_REPID}`, source: 'scoring/repid-constants.ts' },
  { check: 'SHADOW_INERT', event: 'any is_shadow row', rule: 'repid_delta_applied = 0 and repid_after = repid_before', source: 'DB apply_repid_score_event' },
  { check: 'SHADOW_SPEC', event: 'SERVICE_SATISFIED is_shadow (emit_settlement_shadow_event)', rule: 'a shadow of the live rule must compute the live rule: provider round(30*s), buyer round(15*s)', source: 'DB trigger trg_settlement_shadow_emit on service_contracts' },
  { check: 'LEDGER_RECONCILE', event: 'every non-shadow row', rule: 'repid_after - repid_before = repid_delta_applied', source: 'DB apply_repid_score_event (#316 invariant)' },
];

const num = (v: unknown): number | null => (v === null || v === undefined || v === '' ? null : Number.isFinite(Number(v)) ? Number(v) : null);
const v = (row: ScoreEventRow, check: string, status: Status, reason: string, expected?: number | string): RowVerdict =>
  ({ id: row.id, event_type: row.event_type, check, status, expected, actual: row.delta, reason });
const eq = (row: ScoreEventRow, check: string, expected: number, why: string): RowVerdict =>
  row.delta === expected
    ? v(row, check, 'CONFORMS', why, expected)
    : v(row, check, 'DEVIATES', `${why}: expected ${expected}, ledger has ${row.delta}`, expected);

/** Applied-to-zero by the DB penalty guard: conforms to the guard, whatever the writer asked for. */
function suppressedByGuard(row: ScoreEventRow): boolean {
  return row.metadata?.penalty_suppressed === true && row.delta === 0 && num(row.metadata?.original_delta) !== null;
}

function checkShadow(row: ScoreEventRow): RowVerdict[] {
  const out: RowVerdict[] = [];
  const inert = (row.repid_delta_applied ?? 0) === 0 && row.repid_after === row.repid_before;
  out.push(inert
    ? v(row, 'SHADOW_INERT', 'CONFORMS', 'shadow row moved nothing')
    : v(row, 'SHADOW_INERT', 'DEVIATES', `shadow row moved the score by ${row.repid_delta_applied}`, 0));
  if (row.event_type === 'SERVICE_SATISFIED') {
    const s = num(row.metadata?.buyer_satisfaction_score);
    const role = row.metadata?.role;
    if (s === null || (role !== 'provider' && role !== 'buyer')) {
      out.push(v(row, 'SHADOW_SPEC', 'NOT_CHECKED', 'shadow row carries no satisfaction score or role'));
    } else {
      const want = Math.round(SERVICE_SATISFIED_DELTA_BASE[role as 'provider' | 'buyer'] * s);
      out.push(eq(row, 'SHADOW_SPEC', want, `shadow ${role} should mirror the live satisfaction-weighted rule at s=${s}`));
      const claimed = num(row.metadata?.live_flat_delta_would_be);
      if (claimed !== null && claimed !== want) {
        out.push(v(row, 'SHADOW_SPEC', 'DEVIATES', `metadata says the live rule would pay ${claimed} (flat); the live rule pays ${want} — the shadow's premise is stale`, want));
      }
    }
  }
  return out;
}

function checkLedger(row: ScoreEventRow): RowVerdict {
  const b = num(row.repid_before), a = num(row.repid_after), d = num(row.repid_delta_applied);
  if (b === null || a === null || d === null) return v(row, 'LEDGER_RECONCILE', 'NOT_CHECKED', 'before/after/applied not all present');
  return a - b === d
    ? v(row, 'LEDGER_RECONCILE', 'CONFORMS', 'after - before = applied', d)
    : v(row, 'LEDGER_RECONCILE', 'DEVIATES', `after-before = ${a - b} but repid_delta_applied = ${d}`, a - b);
}

function checkUnverified(row: ScoreEventRow): RowVerdict | null {
  const c = row.contract;
  if (!c || (row.delta ?? 0) <= 0 || row.event_type !== 'SERVICE_FULFILLED' || row.metadata?.verdict) return null;
  const verdict = String(c.verdict ?? '').toUpperCase();
  const unverified = verdict === 'VETO' || verdict === 'UNDETERMINED' || (verdict === 'FAIL' && c.confident !== true);
  if (!unverified) return v(row, 'NO_REWARD_FOR_UNVERIFIED_WORK', 'CONFORMS', `paid on a ${verdict || 'verdict-less'} deliverable`);
  const note = verdict === 'UNDETERMINED'
    ? ' (the SHIPPED "keep" policy of #1407 — Sean has not chosen keep vs retry)'
    : '';
  return v(row, 'NO_REWARD_FOR_UNVERIFIED_WORK', 'DEVIATES', `+${row.delta} awarded on a ${verdict}${verdict === 'FAIL' ? ' (not confident)' : ''} deliverable${note}`, 0);
}

function checkPrimary(row: ScoreEventRow): RowVerdict {
  const m = row.metadata ?? {};
  const role = m.role;
  const t = row.event_type;

  if (t !== 'HAL_SCORE_EVENT' && suppressedByGuard(row)) {
    return v(row, 'HAL_PENALTY_GUARD', 'CONFORMS', `penalty ${m.original_delta} zeroed: ${m.suppressed_reason ?? 'penalty_suppressed'}`, 0);
  }

  // --- A2A dispute (metadata.verdict from the dispute worker) -------------------------------
  if ((m.verdict === 'provider_at_fault' || m.verdict === 'buyer_at_fault') && (role === 'provider' || role === 'buyer')) {
    return eq(row, 'A2A_DISPUTE', SERVICE_DISPUTE_DELTAS[m.verdict as 'provider_at_fault' | 'buyer_at_fault'][role as 'provider' | 'buyer'], `dispute ${m.verdict}, ${role}`);
  }
  // --- signed writers that reuse the generic validator vocabulary --------------------------
  if (m.redteam_case !== undefined) {
    const want = t === 'VALIDATOR_REWARD' ? REDTEAM_REWARDS.FINDER_REWARD
      : t === 'VALIDATOR_PENALTY' ? -REDTEAM_REWARDS.ACCUSER_PENALTY
      : t === 'VALIDATION_FAILED' ? -REDTEAM_REWARDS.SUBJECT_PENALTY : null;
    return want === null ? v(row, 'REDTEAM', 'DEVIATES', `red-team row with unexpected type ${t}`) : eq(row, 'REDTEAM', want, `red-team ${t}`);
  }
  if (m.mentorship_pair_id !== undefined) return eq(row, 'MENTORSHIP', 2, 'mentor reward');
  if (m.source === 'exchange_red_team_audit') return v(row, 'EXCHANGE_RED_TEAM', 'NOT_CHECKED', 'base delta is env-driven (auditBaseDelta)');
  if (m.panel !== undefined) {
    if (role === 'producer') return eq(row, 'PANEL', t === 'VALIDATION_PASSED' ? PANEL_DELTAS.producerVerified : PANEL_DELTAS.producerDisputed, `panel producer ${t}`);
    if (role === 'verifier') return eq(row, 'PANEL', m.agreed_with_consensus === false ? PANEL_DELTAS.diverge : PANEL_DELTAS.agree, `panel verifier ${m.agreed_with_consensus === false ? 'diverged' : 'agreed'}`);
  }
  if (m.tier_band === 'T2a' || m.tier_band === 'T3plus') {
    const band = m.tier_band as 'T2a' | 'T3plus';
    if (t === 'VALIDATOR_REWARD') return eq(row, 'LEGACY_VALIDATION', VALIDATOR_DELTAS.agreed_no_correctness, 'legacy validator');
    const outcome = m.outcome as keyof typeof CLAIMER_DELTAS;
    if (outcome in CLAIMER_DELTAS) return eq(row, 'LEGACY_VALIDATION', CLAIMER_DELTAS[outcome][band], `legacy claimer ${outcome} ${band}`);
  }

  switch (t) {
    case 'SERVICE_FULFILLED': {
      if (role !== 'provider' && role !== 'buyer') return v(row, 'A2A_FULFILLED', 'NOT_CHECKED', 'no role in metadata (pre-#605 or reconciliation row)');
      if (row.delta === 0 && row.contract?.simulated === true) return v(row, 'A2A_FULFILLED', 'CONFORMS', 'simulated contract earns 0', 0);
      return eq(row, 'A2A_FULFILLED', SERVICE_FULFILLED_DELTAS[role as 'provider' | 'buyer'], `fulfilled ${role}`);
    }
    case 'SERVICE_SATISFIED': {
      const s = num(m.satisfaction_score);
      if (s === null || (role !== 'provider' && role !== 'buyer')) return v(row, 'A2A_SATISFIED', 'NOT_CHECKED', 'no satisfaction_score/role in metadata');
      if (s < 0 || s > 1) return v(row, 'A2A_SATISFIED', 'DEVIATES', `satisfaction ${s} outside [0,1]`);
      if (row.delta === 0 && row.contract?.simulated === true) return v(row, 'A2A_SATISFIED', 'CONFORMS', 'simulated contract earns 0', 0);
      return eq(row, 'A2A_SATISFIED', Math.round(SERVICE_SATISFIED_DELTA_BASE[role as 'provider' | 'buyer'] * s), `satisfied ${role} s=${s}`);
    }
    case 'SERVICE_OUTCOME': {
      const rating = m.outcome_rating as 'good' | 'ok' | 'bad';
      if (!(rating in SERVICE_OUTCOME_BASE)) return v(row, 'A2A_OUTCOME', 'DEVIATES', `unknown outcome_rating ${String(rating)}`);
      const w = computeRaterWeight(num(m.rater_repid_at_rating));
      return eq(row, 'A2A_OUTCOME', Math.round((rating === 'ok' ? 0 : SERVICE_OUTCOME_BASE[rating]) * w), `outcome ${rating} w=${w}`);
    }
    case 'HAL_SCORE_EVENT': {
      const decision = row.hal_decision as HALDecision;
      const risk = num(row.hal_score);
      if (!['clean', 'flagged', 'vetoed', 'abstain'].includes(decision) || risk === null || num(row.repid_before) === null) {
        return v(row, 'HAL', 'NOT_CHECKED', 'missing hal_decision/hal_score/repid_before');
      }
      const want = Math.round(computeDelta({
        hal_decision: decision, hal_score: risk, current_repid: Number(row.repid_before),
        agent_tier: '', vesting_cliff_active: m.vesting_cliff_active === true,
      }).delta_calculated);
      // The DB guard zeroes repid_delta_calculated and keeps the earned value in original_delta.
      const calc = suppressedByGuard(row) && num(row.repid_delta_calculated) === 0 ? num(m.original_delta) : num(row.repid_delta_calculated);
      if (calc !== want) return v(row, 'HAL', 'DEVIATES', `calculated ${calc}, computeDelta gives ${want} for ${decision} at risk ${risk}`, want);
      const applied = num(row.repid_delta_applied) ?? 0;
      if (applied < 0) {
        const gated = row.hallucination_caught === true && m.quorum_met === true && m.purpose_suppressed !== true;
        if (!gated) return v(row, 'HAL', 'DEVIATES', `penalty ${applied} applied without hallucination_caught + quorum_met (+ deliverable purpose)`, 0);
      }
      if (applied > 0 && decision !== 'clean') return v(row, 'HAL', 'DEVIATES', `reward ${applied} applied on a ${decision} decision`, 0);
      return v(row, 'HAL', 'CONFORMS', applied === 0 && want !== 0 ? `earned ${want}, applied 0 (${m.suppressed_reason ?? m.delta_reason ?? 'suppressed'})` : `${decision} at risk ${risk}`, want);
    }
    case 'GENESIS':
      return row.delta === 0 && row.repid_after === STARTING_REPID
        ? v(row, 'GENESIS', 'CONFORMS', 'delta 0 at STARTING_REPID', 0)
        : v(row, 'GENESIS', 'DEVIATES', `genesis delta ${row.delta} / start ${row.repid_after}, spec 0 / ${STARTING_REPID}`, 0);
    case 'CHALLENGE_WIN': case 'CHALLENGE_LOSS': case 'CHALLENGE_DRAW': case 'EPISTEMIC_VIOLATION': {
      if (m.challengeId === undefined) return v(row, 'CHALLENGE_SCORE_PATH', 'NOT_CHECKED', 'POST /api/v1/score challenge: magnitude is env-tuned (REPID_CHALLENGE_*)');
      const d = row.delta ?? 0;
      const ok = t === 'CHALLENGE_WIN' ? d === 25 : t === 'CHALLENGE_DRAW' ? d === 0 : t === 'CHALLENGE_LOSS' ? d <= 0 && d >= -50 : d <= 0 && d >= -75;
      return v(row, 'CHALLENGE_ROUTE', ok ? 'CONFORMS' : 'DEVIATES', `/challenge ${t} delta ${d}`);
    }
    case 'PREDICTION_RESOLVE':
      return v(row, 'PREDICTION', 'NOT_CHECKED', 'magnitude is env-tuned (REPID_PREDICTION_*)');
    case 'DECAY': case 'DORMANCY_DECAY':
      return (row.delta ?? 0) <= 0 ? v(row, 'DECAY', 'CONFORMS', 'decay never adds') : v(row, 'DECAY', 'DEVIATES', `decay added ${row.delta}`, 0);
  }

  if (t in FIXED_DELTAS) {
    const tariff = FIXED_DELTAS[t as keyof typeof FIXED_DELTAS] as number;
    const d = row.delta ?? 0;
    // updateRepId may zero a self-report (evidence gate) or STAKE (no on-chain proof); it never exceeds the tariff.
    return d === tariff || d === 0 ? v(row, 'FIXED', 'CONFORMS', `tariff ${tariff} or gated 0`, tariff) : v(row, 'FIXED', 'DEVIATES', `delta ${d} is neither the tariff ${tariff} nor 0`, tariff);
  }
  return v(row, 'UNSPECIFIED', 'DEVIATES', `no spec for event_type ${t}${role ? ` role ${role}` : ''} — an unexplained writer`);
}

/** Every verdict for one row: shadow rows get the shadow checks; live rows get the writer check + invariants. */
export function checkRow(row: ScoreEventRow): RowVerdict[] {
  if (row.is_shadow) return checkShadow(row);
  const out = [checkPrimary(row), checkLedger(row)];
  const unverified = checkUnverified(row);
  if (unverified) out.push(unverified);
  return out;
}

export interface ConformanceReport {
  rows: number;
  verdicts: number;
  conforms: number;
  deviates: number;
  not_checked: number;
  by_check: Record<string, Record<Status, number>>;
  deviations: RowVerdict[];
  not_checked_rows: RowVerdict[];
}

export function checkRows(rows: ScoreEventRow[]): ConformanceReport {
  const all = rows.flatMap(checkRow);
  const by_check: ConformanceReport['by_check'] = {};
  for (const x of all) {
    const c = (by_check[x.check] ??= { CONFORMS: 0, DEVIATES: 0, NOT_CHECKED: 0 });
    c[x.status] += 1;
  }
  return {
    rows: rows.length,
    verdicts: all.length,
    conforms: all.filter((x) => x.status === 'CONFORMS').length,
    deviates: all.filter((x) => x.status === 'DEVIATES').length,
    not_checked: all.filter((x) => x.status === 'NOT_CHECKED').length,
    by_check,
    deviations: all.filter((x) => x.status === 'DEVIATES'),
    not_checked_rows: all.filter((x) => x.status === 'NOT_CHECKED'),
  };
}
