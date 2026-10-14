/**
 * rotation.mjs — which providers the daily minter attests, and how many.
 *
 * WHY THIS IS NOT "ONE PER RUN" ANY MORE [MEASURED 2026-10-14]. The minter attested exactly one
 * provider per daily run, least-recently-attested first. With 11 eligible providers that is an
 * 11-day rotation, so every agent's served zkRepID proof aged to ~11 days before it was renewed.
 * trustshell's cold-install acceptance gate fails `zkrepid.freshness` past 7 days, so its probe
 * agent (trinity-sophia) read FAILED for ~4 of every 11 days by construction — the 2026-10-13
 * scheduled run was one of them (proof 8.8 days old the next morning).
 *
 * The run is now sized from a freshness target instead of a constant, so the cycle stays inside
 * it as the roster grows: perRun = ceil(eligible / targetDays), capped for cost.
 * PURE: no I/O. Exercised by tests/cron-rotation.test.ts.
 */

/** How many providers one run attests so each is renewed within `targetDays`. At least 1, at most `cap`. */
export function providersPerRun(eligibleCount, targetDays, cap) {
  const n = Number(eligibleCount);
  const t = Number(targetDays);
  const c = Number(cap);
  if (!Number.isFinite(n) || n <= 0) return 0;
  if (!Number.isFinite(t) || t <= 0) throw new Error('targetDays must be a positive number');
  if (!Number.isInteger(c) || c < 1) throw new Error('cap must be a positive integer');
  return Math.min(c, Math.max(1, Math.ceil(n / t)));
}

/**
 * The `count` distinct providers whose last on-chain write is oldest (never-written first).
 * `eligible` is [{ svc, prov }] — a provider with two services appears twice and is picked once.
 * `lastByAgent` maps provider id → ISO timestamp of its latest write.
 */
export function pickStalest(eligible, lastByAgent, count) {
  const sorted = [...eligible].sort((a, b) =>
    (lastByAgent.get(a.prov.id) || '').localeCompare(lastByAgent.get(b.prov.id) || ''),
  );
  const seen = new Set();
  const picks = [];
  for (const e of sorted) {
    if (picks.length >= count) break;
    if (seen.has(e.prov.id)) continue;
    seen.add(e.prov.id);
    picks.push(e);
  }
  return picks;
}
