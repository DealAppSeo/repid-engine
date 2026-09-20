/**
 * Served-proof freshness. Matches the trustshell zkrepid.freshness gate:
 * ageDays > 7 is FAILED. Missing createdAt is NOT_CHECKED.
 *
 * This is a label on the row that is already being served. It does not remint,
 * drop the row, or change MODE.
 */

export const PROOF_FRESHNESS_MAX_AGE_DAYS = 7;

export type ProofFreshnessVerdict = 'MEASURED' | 'FAILED' | 'NOT_CHECKED';

export function proofFreshnessVerdict(
  createdAt: string | Date | null | undefined,
  now: Date = new Date(),
): { verdict: ProofFreshnessVerdict; ageDays: number | null } {
  if (createdAt == null || createdAt === '') {
    return { verdict: 'NOT_CHECKED', ageDays: null };
  }
  const t = typeof createdAt === 'string' ? Date.parse(createdAt) : createdAt.getTime();
  if (!Number.isFinite(t)) return { verdict: 'NOT_CHECKED', ageDays: null };
  const ageDays = (now.getTime() - t) / 86400000;
  if (ageDays > PROOF_FRESHNESS_MAX_AGE_DAYS) {
    return { verdict: 'FAILED', ageDays };
  }
  return { verdict: 'MEASURED', ageDays };
}
