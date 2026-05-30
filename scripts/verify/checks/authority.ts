/**
 * CHECK 1 — Authority formula vectors.
 * Asserts computeAuthority == min(R, 100·√S_usd) per D-053, by re-deriving the canonical
 * test vectors against the LIVE code. Catches a linear regression (GA's earlier mistake)
 * or any drift from the sqrt-of-stake authority cap.
 *
 * Vectors (R is large enough not to cap unless noted):
 *   $6,400 → 8000 · $2,500 → 5000 · $100 → 1000 · $25 → 500 · whale $50k/R=300 → 300 (R caps)
 * Stake is passed in micro-USDC (1 USD = 1e6), matching the engine's units.
 */
import { CheckResult, pass, fail } from '../lib/types';

const ID = 'authority';
const TITLE = 'Authority formula = min(R, 100·√S_usd) [D-053]';

// computeAuthority caps on agentRepId (the "R" in min(R,100·√S)); builderRepId is a separate
// participation-floor gate (must be ≥ BUILDER_FLOOR or authority is forced to 0). So vectors
// set agentRepId high enough not to cap (stake term wins) — except the whale, where a small
// agentRepId caps below the stake term, with builderRepId kept above the floor.
interface Vector { usd: number; agentRepId: number; builderRepId: number; want: number; note?: string }
const HIGH = 10_000_000;
const VECTORS: Vector[] = [
  { usd: 6400, agentRepId: HIGH, builderRepId: HIGH, want: 8000 },
  { usd: 2500, agentRepId: HIGH, builderRepId: HIGH, want: 5000 },
  { usd: 100, agentRepId: HIGH, builderRepId: HIGH, want: 1000 },
  { usd: 25, agentRepId: HIGH, builderRepId: HIGH, want: 500 },
  { usd: 50000, agentRepId: 300, builderRepId: 600, want: 300, note: 'agentRepId caps below 100·√S=22361; builderRepId>floor' },
];

export async function authorityCheck(): Promise<CheckResult> {
  let computeAuthority: (a: any) => any;
  try {
    // require (not dynamic import) so ts-node resolves the .ts module under CJS
    computeAuthority = require('../../../src/services/authority-math').computeAuthority;
    if (typeof computeAuthority !== 'function') throw new Error('computeAuthority export missing');
  } catch (e: any) {
    return fail(ID, TITLE, `could not load authority-math: ${e?.message ?? e}`, true);
  }

  const rows: any[] = [];
  let allOk = true;
  for (const v of VECTORS) {
    const stakeMicro = BigInt(Math.round(v.usd * 1_000_000));
    let gotHuman = NaN;
    let err: string | undefined;
    try {
      // authority is returned in micro-units (÷1e6 for human RepID-equivalent).
      const res = computeAuthority({
        stakeAmount: stakeMicro,
        agentRepId: v.agentRepId,
        builderRepId: v.builderRepId,
        agentWisdom: 800,
        agentCharacter: 600,
      });
      const raw = res?.authority ?? res?.authorityMicro ?? res;
      gotHuman = Number(BigInt(raw)) / 1_000_000;
    } catch (e: any) {
      err = e?.message ?? String(e);
    }
    // tolerance: 1 RepID unit (float sqrt vs integer babylonian differ in the ones place)
    const ok = err === undefined && Math.abs(gotHuman - v.want) <= 1;
    if (!ok) allOk = false;
    rows.push({ usd: v.usd, agentRepId: v.agentRepId, builderRepId: v.builderRepId, want: v.want, got: Number.isFinite(gotHuman) ? Math.round(gotHuman) : null, ok, ...(err ? { err } : {}), ...(v.note ? { note: v.note } : {}) });
  }

  const summary = allOk
    ? `all ${VECTORS.length} vectors reproduce min(R,100·√S)`
    : `formula MISMATCH: ${rows.filter(r => !r.ok).map(r => `$${r.usd}→want ${r.want} got ${r.got}`).join(', ')}`;
  return (allOk ? pass : fail)(ID, TITLE, summary, true, { vectors: rows });
}
