/**
 * work-statement-canonical.ts — the hash a THIRD PARTY can actually recompute.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * WHY THIS EXISTS, AND WHY IT IS NOT `work-statement.ts`
 * ════════════════════════════════════════════════════════════════════════════
 * `service_contracts.work_statement_hash` is computed IN POSTGRES, by
 * `work_statement_sha256(ws)` → `'0x' || sha256(work_statement_canonical_text(ws))`,
 * fired by the `trg_service_contracts_work_statement` trigger. The trigger
 * refuses a client-supplied hash outright, so the database is the only writer.
 *
 * `src/services/work-statement.ts` computes a DIFFERENT hash over ten different
 * inputs (contract id, agent ids, settlement tx, verdict, satisfaction, payload
 * and result digests) and HAS NO CALLERS ANYWHERE IN `src/`. Its header says
 * "Anyone holding the public receipt can RECOMPUTE the hash and check it
 * matches". That sentence is about a hash this system does not produce, on a
 * module nothing runs — so the receipt's headline verifiability property was
 * carried entirely by dead code.
 *
 * This module ports the LIVE construction, so the claim becomes true.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * THE CONSTRUCTION, and why a JS port is safe here
 * ════════════════════════════════════════════════════════════════════════════
 * `work_statement_canonical_text` emits a fixed-order object over exactly four
 * fields — acceptance_criteria (sorted by n), agreed_price, deadline,
 * deliverable — with no whitespace. It is deliberately NOT generic JSON
 * canonicalisation: the field order is hardcoded in the SQL, so the port is a
 * transcription rather than a re-derivation.
 *
 * That is also the risk. A port that drifts from the SQL by one byte produces a
 * hash that disagrees with every stored row, and the failure looks like "someone
 * tampered with the contract" rather than "our port is wrong" — an accusation,
 * not a bug report. So `tests/work-statement-canonical.test.ts` pins it against
 * a REAL production row (canonical text and hash both read from the live
 * database), the same way `zkp-vault` pins Poseidon2 against a Rust oracle. If
 * the SQL changes, that test fails and names the disagreement.
 *
 * WHAT THE HASH DOES AND DOES NOT COVER. Four fields — the agreed SPEC. It does
 * not cover the payload, the result, the price actually settled, the parties, or
 * the transaction. Matching it proves THE SPEC WAS NOT EDITED AFTER BINDING. It
 * does not prove the work was done, done well, or done by anyone in particular.
 * Anyone describing a hash match as "the work is verified" is overclaiming.
 */
import { createHash } from 'node:crypto';

/** One numbered acceptance criterion, as the DB normalises it. */
export interface AcceptanceCriterion {
  n: number;
  text: string;
}

export interface WorkStatement {
  acceptance_criteria: AcceptanceCriterion[];
  agreed_price: { amount_usdc_raw: number | string; currency: string };
  deadline: string;
  deliverable: string;
}

/** One buyer rating of one criterion. `met` is a boolean in the DB, enforced. */
export interface CriterionRating {
  n: number;
  met: boolean;
  note?: string;
}

/**
 * Byte-for-byte port of `public.work_statement_canonical_text(jsonb)`.
 *
 * `JSON.stringify` on a string produces exactly PostgreSQL `to_json(text)` for
 * the characters that occur here (both emit RFC-8259 escapes), which is what
 * makes the transcription tractable. The parity test is what makes it TRUE.
 */
export function workStatementCanonicalText(ws: WorkStatement): string {
  const criteria = [...(ws.acceptance_criteria ?? [])]
    .sort((a, b) => Number(a.n) - Number(b.n))
    .map((c) => `{"n":${Number(c.n)},"text":${JSON.stringify(String(c.text))}}`)
    .join(',');

  return (
    `{"acceptance_criteria":[${criteria}]` +
    `,"agreed_price":{"amount_usdc_raw":${ws.agreed_price.amount_usdc_raw}` +
    `,"currency":${JSON.stringify(String(ws.agreed_price.currency))}}` +
    `,"deadline":${JSON.stringify(String(ws.deadline))}` +
    `,"deliverable":${JSON.stringify(String(ws.deliverable))}}`
  );
}

/** Port of `public.work_statement_sha256(jsonb)`. `0x`-prefixed. */
export function workStatementCanonicalHash(ws: WorkStatement): string {
  return '0x' + createHash('sha256').update(Buffer.from(workStatementCanonicalText(ws), 'utf8')).digest('hex');
}

export type VerdictMarker = 'VERIFIED' | 'NOT_CHECKED' | 'FAILED';

export interface RecomputeResult {
  outcome: VerdictMarker;
  expected: string | null;
  stored: string | null;
  detail: string;
}

/**
 * Recompute a stored hash from a published work statement.
 *
 * THREE OUTCOMES. A missing statement or a missing hash is NOT_CHECKED — there
 * is nothing to compare, and reporting that as either a pass or a tamper would
 * be the failure this whole codebase keeps finding. Only a statement AND a hash
 * that disagree is FAILED.
 */
export function recomputeWorkStatementHash(
  ws: WorkStatement | null | undefined,
  storedHash: string | null | undefined,
): RecomputeResult {
  if (!ws || typeof ws !== 'object') {
    return {
      outcome: 'NOT_CHECKED',
      expected: null,
      stored: storedHash ?? null,
      detail: 'no work_statement published on this receipt — nothing to recompute from',
    };
  }
  if (!storedHash) {
    return {
      outcome: 'NOT_CHECKED',
      expected: workStatementCanonicalHash(ws),
      stored: null,
      detail: 'contract carries no work_statement_hash (bound before the binding existed)',
    };
  }
  const expected = workStatementCanonicalHash(ws);
  if (expected !== storedHash) {
    return {
      outcome: 'FAILED',
      expected,
      stored: storedHash,
      detail: 'the published work statement does not hash to the stored value — the spec was altered after binding',
    };
  }
  return {
    outcome: 'VERIFIED',
    expected,
    stored: storedHash,
    detail: 'the spec is exactly what was bound; it has not been edited since',
  };
}

export interface ScoreCheck {
  outcome: VerdictMarker;
  expected: string | null;
  stored: string | null;
  detail: string;
}

/**
 * Recompute `buyer_satisfaction_score` from the per-criterion ratings.
 *
 * The trigger derives it as `round(met_count / n_criteria, 4)` and REFUSES a
 * client-supplied value that disagrees — so the score is not an opinion the
 * buyer types, it is a function of the ratings. That makes it independently
 * checkable, which is the point of publishing the ratings.
 */
export function recomputeSatisfactionScore(
  ratings: CriterionRating[] | null | undefined,
  storedScore: number | string | null | undefined,
): ScoreCheck {
  if (!Array.isArray(ratings) || ratings.length === 0) {
    return {
      outcome: 'NOT_CHECKED',
      expected: null,
      stored: storedScore === null || storedScore === undefined ? null : Number(storedScore).toFixed(4),
      detail: 'no criterion_ratings published — the score cannot be re-derived',
    };
  }
  if (storedScore === null || storedScore === undefined) {
    return { outcome: 'NOT_CHECKED', expected: null, stored: null, detail: 'no buyer_satisfaction_score recorded' };
  }
  const met = ratings.filter((r) => r.met === true).length;
  const expected = (met / ratings.length).toFixed(4);
  const stored = Number(storedScore).toFixed(4);
  if (expected !== stored) {
    return {
      outcome: 'FAILED',
      expected,
      stored,
      detail: `score ${stored} is not round(${met}/${ratings.length}, 4) = ${expected} — it was not derived from the ratings`,
    };
  }
  return {
    outcome: 'VERIFIED',
    expected,
    stored,
    detail: `score is exactly round(${met}/${ratings.length}, 4) — derived, not asserted`,
  };
}
