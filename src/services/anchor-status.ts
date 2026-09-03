/**
 * Is this proof anchored on chain — or has nobody looked yet?
 *
 * WHAT THIS FIXES, and it is the same defect this codebase keeps paying for. The proof surface
 * rendered the anchor as one boolean:
 *
 *     eas: { attestation_uid: null, anchored: false }
 *
 * `false` is the answer to "is it anchored". It is NOT the answer to the question a reader
 * actually asks, which is "will it be" — and for a proof minted five seconds ago the honest
 * answer is *not yet*. Measured end-to-end against production on 2026-08-31, a brand-new agent's
 * proof reads `anchored: false` for the first ~2 minutes of its life and is then anchored on
 * Base Sepolia for real. During that window the API told every caller the same thing it tells
 * them about a proof that will never be anchored at all.
 *
 * That is NOT_YET rendered as NO. It is the shape of #548 (an absence in our table published as a
 * fact about the chain), of the identity ladder beside this file, and of the twelve-day settlement
 * outage where NOT_CHECKED scored as FAILED. Here it costs less than money — but it is the reason
 * a user watching their own passport concludes the anchor leg is dead when it is simply running.
 *
 * THE LADDER, and every rung is something we observed rather than assumed:
 *
 *   ANCHORED      we hold an attestation uid. The chain write is evidenced.
 *   PENDING       eligible for anchoring and still inside the expected window. Not a failure.
 *   OVERDUE       eligible, past the window. STILL QUEUED — the worker backfills oldest-first and
 *                 has not given up — but late enough that a reader deserves to be told.
 *   NOT_ELIGIBLE  the anchor worker will never pick this row up. A legacy stub, or a row with no
 *                 commitment to put in a Merkle leaf. Calling this PENDING would promise a chain
 *                 write that is not coming.
 *   ANCHORED_INELIGIBLE
 *                 an attestation uid EXISTS for a row that the eligibility rule says should never
 *                 have been anchored. Both halves are true and neither may be dropped.
 *
 * `NOT_ELIGIBLE` is the rung that stops this from being decoration. Without it every legacy stub
 * would read PENDING forever, which is a different false claim from the one being removed.
 *
 * ════════════════════════════════════════════════════════════════════════════════
 * WHY THE FIFTH RUNG EXISTS [MEASURED against production 2026-09-03]
 * ════════════════════════════════════════════════════════════════════════════════
 * This function returned ANCHORED on the first line, before it looked at eligibility. Measured:
 * 22,365 rows carry an attestation uid while only 22,360 satisfy the eligibility rule — so five
 * rows hold a uid they should never have had. They are NOT fabricated: each uid resolves on
 * Base Sepolia, minted by this system's own attester under its own schema, with on-chain
 * timestamps matching the rows to within a minute. The system anchored five SIMULATED proofs
 * (`is_real = false`) to the chain as if they were real, in one 63-second window on 2026-05-30,
 * and has not repeated it since across the 22,360 eligible rows that followed.
 *
 * Reported as bare ANCHORED, those five read exactly like a genuine anchored proof — the file
 * that exists to stop a status meaning two things at once was doing it. The reader is owed both
 * facts: there IS an attestation, and the proof under it was never eligible for one.
 *
 * REACHABILITY TODAY IS NIL, and saying so is part of the finding rather than a reason to skip
 * it. The passport surfaces only an agent's LATEST proof; all three affected agents have since
 * minted real ones, so no live response carries this status. It is a latent hole in the ladder,
 * not a live wound — but any consumer counting `eas_attestation_uid IS NOT NULL` as "anchored"
 * still counts those five today.
 */

/**
 * The anchor worker's OWN eligibility predicate, as SQL.
 *
 * It is duplicated from `eas-anchor-worker.ts` on purpose, and `tests/anchor-status.test.ts`
 * pins the worker's two inline copies against this string. A read model that decides "PENDING"
 * from a different predicate than the writer selects on would quietly promise anchoring to rows
 * the worker never looks at — which is precisely the class of bug being fixed here, reintroduced
 * one layer down. Pinning it in a test rather than refactoring the live worker's SQL keeps the
 * running write path untouched while making the drift impossible to land silently.
 */
export const ANCHOR_ELIGIBLE_SQL = 'is_real = true' as const;
export const ANCHOR_ELIGIBLE_SQL_COMMITMENT = 'zk_commitment IS NOT NULL' as const;

export type AnchorStatus =
  | 'ANCHORED'
  | 'ANCHORED_INELIGIBLE'
  | 'PENDING'
  | 'OVERDUE'
  | 'NOT_ELIGIBLE';

export interface AnchorRow {
  eas_attestation_uid?: string | null;
  is_real?: boolean | null;
  zk_commitment?: string | null;
  created_at?: string | Date | null;
}

/**
 * How long a proof may sit un-anchored before the surface stops calling it normal.
 *
 * The worker polls on `EAS_ANCHOR_POLL_MS` (default 5 min) and anchors oldest-first, so a proof
 * minted just after a poll waits nearly a full cycle before it is even considered. Measured lag
 * on a live run was 2 min 09 s. The window is TWO poll intervals rather than one so a single
 * missed or slow cycle does not flip a healthy proof to OVERDUE — a status that cries wolf is a
 * status people learn to ignore, and this file exists because a status was believed.
 */
export const ANCHOR_PENDING_WINDOW_MS = Number(process.env['EAS_ANCHOR_POLL_MS'] ?? 300_000) * 2;

export function deriveAnchorStatus(row: AnchorRow, now: number = Date.now()): AnchorStatus {
  // Mirrors the worker's SELECT. A row failing either clause is never selected for a batch, so
  // promising it a chain write would be inventing one.
  const eligible = row.is_real === true && !!row.zk_commitment;

  // ELIGIBILITY IS CONSULTED BEFORE THE UID, NOT AFTER. The uid used to short-circuit on the
  // first line, which collapsed "anchored, as intended" and "anchored despite never qualifying"
  // into one word. Five production rows are the second case (see the header).
  if (row.eas_attestation_uid) return eligible ? 'ANCHORED' : 'ANCHORED_INELIGIBLE';

  if (!eligible) return 'NOT_ELIGIBLE';

  const createdAt = row.created_at ? new Date(row.created_at).getTime() : NaN;
  // An unparseable or absent timestamp cannot establish that the window has EXPIRED, and OVERDUE
  // is the assertion of the two. Degrade to PENDING — the claim we can still support.
  if (!Number.isFinite(createdAt)) return 'PENDING';

  return now - createdAt > ANCHOR_PENDING_WINDOW_MS ? 'OVERDUE' : 'PENDING';
}

/**
 * The `eas` block every public proof surface returns.
 *
 * `anchored` is KEPT, unchanged, and deliberately: it is in the published shape that
 * `@hyperdag/trustshell` and the passport page already read, and silently changing a boolean's
 * meaning under existing consumers would be its own dishonesty. The new fields sit beside it and
 * say the thing the boolean cannot.
 */
export function easBlock(
  row: AnchorRow & { eas_schema?: string | null },
  network = 'base-sepolia',
  now: number = Date.now(),
): {
  attestation_uid: string | null;
  schema: string | null;
  anchored: boolean;
  anchor_status: AnchorStatus;
  anchor_note: string;
  network: string;
} {
  const anchor_status = deriveAnchorStatus(row, now);
  return {
    attestation_uid: row.eas_attestation_uid ?? null,
    schema: row.eas_schema ?? null,
    anchored: !!row.eas_attestation_uid,
    anchor_status,
    anchor_note: ANCHOR_NOTES[anchor_status],
    network,
  };
}

/**
 * What a human should conclude. Written for the person refreshing their own passport, because
 * that reader is the one the bare boolean misled.
 */
export const ANCHOR_NOTES: Record<AnchorStatus, string> = {
  ANCHORED: 'Anchored on chain. The attestation uid is the on-chain receipt.',
  PENDING:
    'Not yet anchored. The proof is already complete and independently verifiable offline right now; ' +
    'batched on-chain anchoring usually lands within minutes. This is not a failure.',
  OVERDUE:
    'Not yet anchored, and later than expected. Still queued — the anchor worker retries oldest-first ' +
    'and has not given up — but the delay is worth reporting rather than hiding.',
  ANCHORED_INELIGIBLE:
    'An on-chain attestation exists for this proof, but the proof did not meet the anchoring ' +
    'criteria — it is a simulated proof, or carries no commitment. The attestation is real; treat ' +
    'it as evidence of the anchoring run, NOT as evidence about this proof. Generate a current ' +
    'proof for an anchor that means what it says.',
  NOT_ELIGIBLE:
    'This proof will not be anchored: it is a simulated proof, or carries no commitment the ' +
    'batching Merkle tree can use. (This note used to name only the missing commitment, which is ' +
    'the less common of the two causes and read as a diagnosis nobody had made.) ' +
    'Generate a current proof to obtain an on-chain anchor.',
};
