/**
 * settlement-provenance.ts — one canonical answer to "how many payments really happened",
 * with the evidence attached.
 *
 * ════════════════════════════════════════════════════════════════════════════════
 * THE QUESTION A REVIEWER ASKS FIRST, AND THE THREE ANSWERS WE HAD
 * ════════════════════════════════════════════════════════════════════════════════
 * Asked "how many completed transactions?", this system could return:
 *   106  — `x402_settlements` where `is_simulated = false`
 *    44  — the subset of those carrying a transaction hash
 *     7  — `service_contracts` at status `settled`
 *
 * All three are true statements about different things, and none of them is wrong.
 * That is exactly what makes it dangerous: whoever quotes one has not lied, and the
 * number still cannot be defended when someone checks it against the chain.
 *
 * ════════════════════════════════════════════════════════════════════════════════
 * WHAT THE DATA ACTUALLY SAYS [V 2026-08-04]
 * ════════════════════════════════════════════════════════════════════════════════
 * The split is not random. It is a clean instrumentation cutover:
 *
 *     2026-05-15 .. 2026-07-02 :  62 real settlements,  0 with a tx hash
 *     2026-07-03 .. 2026-08-02 :  44 real settlements, 44 with a tx hash
 *
 * Hash recording landed on 2026-07-03. Every settlement since carries one; not one
 * before does. So the 62 are not failures and not fabrications — they are
 * pre-instrumentation rows whose on-chain evidence was never captured.
 *
 * ════════════════════════════════════════════════════════════════════════════════
 * WHY THIS IS NOT A BACKFILL, AND NOT AN ALERT
 * ════════════════════════════════════════════════════════════════════════════════
 * **Not a backfill.** Reconstructing those hashes by matching amounts and timestamps
 * against the chain would be inventing evidence — proximity in time is not proof, and
 * `settlement-reconciler.ts` already refuses that move for the same reason.
 *
 * **Not an alert.** Flagging 62 known, explained, historical rows would create 62
 * standing alarms that everyone learns to ignore, and the sixty-third — a genuine
 * regression — would be ignored with them. A gate that cries wolf protects nothing.
 *
 * So instead: classify. A row states its own evidential standing, a count of "real
 * payments" returns the PROVABLE subset by default, and the unprovable ones are
 * reported beside it rather than folded in. `x402_settlements` is not modified; this
 * module only reads.
 *
 * ════════════════════════════════════════════════════════════════════════════════
 * THE ONE CASE THAT IS A REAL DEFECT
 * ════════════════════════════════════════════════════════════════════════════════
 * A settlement dated AFTER the cutover with no hash is not history — it means the
 * recorder that has worked every time since 2026-07-03 has stopped. That is
 * `CLAIMS_REAL_NO_PROOF`, and it is the only class here that should ever page anyone.
 * Today there are zero. The value of this module is that the first one is visible.
 */

/**
 * The day `tx_hash` recording began, derived from the data rather than from a
 * changelog: 0 of 62 rows before it carry a hash, 44 of 44 after it do.
 *
 * A row on the boundary date itself counts as post-cutover — the earliest hash-bearing
 * row IS on this date, so treating it as "before" would misclassify a proven payment
 * as unprovable. Erring toward the stricter class would be safe for a claim and wrong
 * about a fact, and this module exists to be right about facts.
 */
export const TX_HASH_INSTRUMENTATION_DATE = '2026-07-03';

export type SettlementProvenance =
  /** Real money, and a transaction hash to check. The only class that may be called proven. */
  | 'PROVEN_ONCHAIN'
  /** Real money, dated before hash recording existed. Believable, uncheckable, historical. */
  | 'UNPROVABLE_PRE_INSTRUMENTATION'
  /** Claims real, dated AFTER the cutover, no hash. A regression — the only alarming class. */
  | 'CLAIMS_REAL_NO_PROOF'
  /** Explicitly simulated. Never counted as a payment anywhere. */
  | 'SIMULATED';

/** The narrow shape needed. Kept minimal so this needs no generated DB types. */
export interface SettlementRow {
  id?: string | null;
  is_simulated?: boolean | null;
  tx_hash?: string | null;
  created_at?: string | null;
  status?: string | null;
}

export interface ProvenanceAssessment {
  id: string | null;
  provenance: SettlementProvenance;
  txHash: string | null;
  /** True only for PROVEN_ONCHAIN. Every public count must gate on this. */
  countableAsProven: boolean;
  /** Plain sentence a reviewer can read without knowing the schema. */
  reason: string;
}

const isBlank = (s: string | null | undefined): boolean =>
  s === null || s === undefined || String(s).trim().length === 0;

/**
 * Classify one settlement row.
 *
 * `is_simulated` is treated as TRUE when null. An unknown flag must not promote a row
 * into the real-money population — the whole failure mode here is unearned confidence.
 */
export function classifySettlement(
  row: SettlementRow,
  cutover: string = TX_HASH_INSTRUMENTATION_DATE,
): ProvenanceAssessment {
  const id = row.id ?? null;
  const txHash = isBlank(row.tx_hash) ? null : String(row.tx_hash).trim();

  if (row.is_simulated !== false) {
    return {
      id,
      provenance: 'SIMULATED',
      txHash,
      countableAsProven: false,
      reason:
        row.is_simulated === null || row.is_simulated === undefined
          ? 'is_simulated is unknown; treated as simulated so an unknown never counts as a payment'
          : 'explicitly simulated — no money moved',
    };
  }

  if (txHash) {
    return {
      id,
      provenance: 'PROVEN_ONCHAIN',
      txHash,
      countableAsProven: true,
      reason: 'real settlement with a transaction hash that can be checked on Base Sepolia',
    };
  }

  // Real, no hash. Which side of the instrumentation cutover decides everything.
  const created = row.created_at ? Date.parse(row.created_at) : NaN;
  const cut = Date.parse(`${cutover}T00:00:00.000Z`);

  if (!Number.isFinite(created)) {
    // Undatable and unprovable. Never silently assume it is old — an undatable row
    // could equally be a fresh regression, so it goes to the alarming class.
    return {
      id,
      provenance: 'CLAIMS_REAL_NO_PROOF',
      txHash: null,
      countableAsProven: false,
      reason: 'claims real money with no hash and no usable timestamp — cannot be aged, so it is treated as current',
    };
  }

  if (created < cut) {
    return {
      id,
      provenance: 'UNPROVABLE_PRE_INSTRUMENTATION',
      txHash: null,
      countableAsProven: false,
      reason:
        `real settlement recorded before hash capture began on ${cutover}; believable but ` +
        `not checkable, so it is never counted as proven and never backfilled by guessing`,
    };
  }

  return {
    id,
    provenance: 'CLAIMS_REAL_NO_PROOF',
    txHash: null,
    countableAsProven: false,
    reason:
      `claims real money but carries no hash, and it is dated after ${cutover} when every ` +
      `settlement has recorded one — the recorder has regressed`,
  };
}

export interface ProvenanceSummary {
  total: number;
  byProvenance: Record<SettlementProvenance, number>;
  /** THE canonical number. Real payments with on-chain evidence. */
  provenPayments: number;
  /** Real, believed, uncheckable. Reported beside the canonical number, never inside it. */
  unprovableHistorical: number;
  /** Non-zero means a regression is live. The only figure worth paging on. */
  regressions: number;
  /** A sentence safe to publish verbatim. */
  headline: string;
}

export function summariseProvenance(
  rows: readonly SettlementRow[],
  cutover: string = TX_HASH_INSTRUMENTATION_DATE,
): ProvenanceSummary {
  const byProvenance: Record<SettlementProvenance, number> = {
    PROVEN_ONCHAIN: 0,
    UNPROVABLE_PRE_INSTRUMENTATION: 0,
    CLAIMS_REAL_NO_PROOF: 0,
    SIMULATED: 0,
  };
  for (const r of rows) byProvenance[classifySettlement(r, cutover).provenance]++;

  const proven = byProvenance.PROVEN_ONCHAIN;
  const historical = byProvenance.UNPROVABLE_PRE_INSTRUMENTATION;
  const regressions = byProvenance.CLAIMS_REAL_NO_PROOF;

  const headline =
    regressions > 0
      ? `${regressions} settlement(s) claim real money with no on-chain proof and postdate ` +
        `${cutover}. The hash recorder has regressed — investigate before quoting any figure.`
      : `${proven} payment(s) are provable on-chain.` +
        (historical > 0
          ? ` A further ${historical} predate hash capture on ${cutover}: real, but not checkable, ` +
            `and deliberately not counted as proven.`
          : '');

  return {
    total: rows.length,
    byProvenance,
    provenPayments: proven,
    unprovableHistorical: historical,
    regressions,
    headline,
  };
}

/**
 * Render for a reviewer.
 *
 * Leads with the provable number because that is the one being asked for, and states
 * the uncheckable count immediately after so nobody discovers it later and wonders
 * what else was omitted. Volunteering the weaker number is what makes the stronger one
 * believable.
 */
export function formatProvenance(s: ProvenanceSummary): string {
  return [
    `[settlement-provenance] ${s.total} settlement row(s) examined`,
    `  proven on-chain            : ${s.provenPayments}   <- the number to quote`,
    `  unprovable (pre-${TX_HASH_INSTRUMENTATION_DATE}) : ${s.unprovableHistorical}   <- real, uncheckable, not counted`,
    `  claims real, no proof      : ${s.regressions}   <- ${s.regressions > 0 ? 'REGRESSION' : 'none — the recorder is working'}`,
    `  simulated                  : ${s.byProvenance.SIMULATED}`,
    `  ${s.headline}`,
  ].join('\n');
}
