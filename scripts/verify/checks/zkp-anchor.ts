/**
 * CHECK — ZKP anchoring coverage (pairs with XC's EAS work). Recent proofs must carry an on-chain
 * attestation: if NEW repid_zkp_proofs rows exist but ZERO have an eas_attestation_uid, the anchor
 * pipeline is dark (proofs generated but never attested on-chain). If there are no recent proofs at
 * all, there is nothing to anchor → SKIP (never a silent pass).
 *
 * "New" = created in the last ANCHOR_WINDOW_DAYS (default 7). Coverage 0 over a non-empty window
 * FAILs (blocking). This is the CC side of the XC handoff; XC populates eas_attestation_uid.
 */
import { CheckResult, pass, fail, skip } from '../lib/types';
import { sqlExec, getDb } from '../lib/db';

const ID = 'zkp-anchor';
const TITLE = 'ZKP anchoring (recent proofs have non-zero EAS attestation coverage)';
const WINDOW_DAYS = Number(process.env.ANCHOR_WINDOW_DAYS ?? '7');

export async function zkpAnchorCheck(): Promise<CheckResult> {
  if (!getDb()) return skip(ID, TITLE, 'needs SUPABASE_URL + SUPABASE_SERVICE_KEY', true);

  let row: { total: number; anchored: number } | undefined;
  try {
    const r = await sqlExec<{ total: number; anchored: number }>(
      `SELECT count(*)::int AS total,
              count(*) FILTER (WHERE eas_attestation_uid IS NOT NULL
                               AND eas_attestation_uid <> '')::int AS anchored
       FROM repid_zkp_proofs
       WHERE created_at >= now() - interval '${WINDOW_DAYS} days'`,
    );
    row = r[0];
  } catch (e: any) {
    return skip(ID, TITLE, `DB query failed: ${e?.message ?? e}`, true);
  }

  const total = Number(row?.total ?? 0);
  const anchored = Number(row?.anchored ?? 0);
  const detail = { window_days: WINDOW_DAYS, recent_proofs: total, anchored, coverage: total ? +(anchored / total).toFixed(3) : null };

  if (total === 0) return skip(ID, TITLE, `no proofs in last ${WINDOW_DAYS}d — nothing to anchor`, true, detail);
  if (anchored === 0) return fail(ID, TITLE, `${total} new proof(s) in ${WINDOW_DAYS}d but 0 anchored (EAS coverage = 0)`, true, detail);
  return pass(ID, TITLE, `${anchored}/${total} recent proofs anchored (coverage ${detail.coverage})`, true, detail);
}
