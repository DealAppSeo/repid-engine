/** Days since last_verified_action. Pure — no db. */
export function idleDaysSince(lastVerifiedAction: string | null, now: Date): number | null {
  if (!lastVerifiedAction) return null;
  const t = Date.parse(lastVerifiedAction);
  if (!Number.isFinite(t)) return null;
  return Math.max(0, Math.floor((now.getTime() - t) / (24 * 60 * 60 * 1000)));
}
