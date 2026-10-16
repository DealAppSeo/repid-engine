/**
 * AgentChess CHESS rating. Chess only: nothing here reads or writes RepID.
 *
 * ONE MODULE, NOT A FORK. This is a line-for-line port of the pure math in lane AC's
 * `E:\dev\ops\agentchess\ratings.mjs` (copied at sha256 c3e1bb8a…f227, 2026-10-16; AC's later
 * 8e51b067…21b8 only records an owner field, the math is unchanged). tests/arena-rating.test.ts pins numbers produced by running THAT file,
 * so a change here that drifts from AC goes red. Tune the parameters with the community, here,
 * in one place; do not grow a second copy.
 *
 *   E = 1/(1+10^((Rb-Ra)/400))
 *   winner +K(1-E_w)M, loser -lambda*K*E_l*M        (lambda < 1: an upset pays the underdog more
 *                                                    than it costs the favourite)
 *   M = clamp(1 + log10(stake_usd / $1), 0.5, 2)     ($0.10 -> 0.5, $1 -> 1, $10 -> 2: money buys
 *                                                    volatility, capped, never reputation)
 *   decay "recenter": shift EVERY rating by delta*(mean-anchor). Gaps, and so every expected
 *   score, are untouched; only the inflation lambda<1 mints is removed.
 *
 * The AC simulation (simOnce/simTable/gamesFor50Elo) is not ported: it is an analysis tool, not
 * something the API calls. Performance spreads need an engine (Stockfish is GPL-3.0 and is not
 * vendored into this Apache-2.0 repo), so the API rates on the result only (perfA = null).
 */

export interface RatingParams {
  K: number;
  lambda: number;
  anchor: number;
  decay: number;
  decayMode: 'recenter' | 'anchor';
  stakeUnitUsd: number;
  stakeMin: number;
  stakeMax: number;
  alpha: number;
  dPerf: number;
  survivalPawns: number;
}

/** Community-tunable defaults, identical to AC's DEFAULTS. */
export const DEFAULTS: RatingParams = {
  K: 32, lambda: 0.5, anchor: 1500, decay: 0.05, decayMode: 'recenter',
  stakeUnitUsd: 1, stakeMin: 0.5, stakeMax: 2, alpha: 0.7, dPerf: 1200, survivalPawns: 3,
};

export const expected = (ra: number, rb: number): number => 1 / (1 + 10 ** ((rb - ra) / 400));
export const expectedPerf = (ra: number, rb: number, p: RatingParams = DEFAULTS): number => 1 / (1 + 10 ** ((rb - ra) / p.dPerf));
export const stakeMult = (usd: number, p: RatingParams = DEFAULTS): number =>
  Math.min(p.stakeMax, Math.max(p.stakeMin, 1 + Math.log10(Math.max(usd, 1e-9) / p.stakeUnitUsd)));

export interface SideSpread { E_result: number; performance: number; survival_plies: number; survival_pawns: number }

/** Spreads, locked before move 1 from the rating gap (AC `spreads`). */
export function spreads(rw: number, rb: number, maxPlies: number, p: RatingParams = DEFAULTS) {
  const side = (ra: number, ro: number): SideSpread => {
    const E = expected(ra, ro);
    return { E_result: +E.toFixed(4), performance: +expectedPerf(ra, ro, p).toFixed(4), survival_plies: Math.min(maxPlies, Math.round(20 + 2 * maxPlies * E)), survival_pawns: p.survivalPawns };
  };
  return { white: side(rw, rb), black: side(rb, rw), set_from: { white: rw, black: rb }, params: { dPerf: p.dPerf, survivalPawns: p.survivalPawns } };
}

/** score: 1 = a won, 0 = b won, 0.5 = draw. perfA null = result only (alpha 1). */
export function blended(ra: number, rb: number, score: number, perfA: number | null, p: RatingParams = DEFAULTS) {
  const a = perfA == null ? 1 : p.alpha;
  return { alpha: a, S: a * score + (1 - a) * (perfA ?? 0), E: a * expected(ra, rb) + (1 - a) * expectedPerf(ra, rb, p) };
}

/** [delta for a, delta for b]. The side above expectation gains in full; the side below loses lambda times. */
export function deltas(ra: number, rb: number, score: number, stakeUsd: number, p: RatingParams = DEFAULTS, perfA: number | null = null): [number, number] {
  const M = stakeMult(stakeUsd, p), { S, E } = blended(ra, rb, score, perfA, p);
  const [x, y] = [S - E, E - S];
  return [p.K * x * M * (x < 0 ? p.lambda : 1), p.K * y * M * (y < 0 ? p.lambda : 1)];
}

/** In place, over every rated participant (AC `decay`). */
export function decay(r: Record<string, number>, p: RatingParams = DEFAULTS): void {
  const ids = Object.keys(r);
  if (!p.decay || !ids.length) return;
  const mean = ids.reduce((a, id) => a + (r[id] as number), 0) / ids.length;
  for (const id of ids) r[id] = (r[id] as number) - p.decay * (p.decayMode === 'anchor' ? (r[id] as number) - p.anchor : mean - p.anchor);
}

export interface RatedGame { white: string; black: string; score_white: number; stake_usd: number }
export interface Rating { rating: number; games: number }

/**
 * Apply finished games in order, exactly as AC's `applyGame` does one at a time: new players
 * enter at the anchor, both deltas use the pre-game ratings, decay runs over EVERYONE, then every
 * rating is rounded to 2 decimals. Folding the whole history (rather than updating in place) makes
 * the stored table a pure function of the finished games: idempotent, and self-healing if two
 * games finish at once.
 */
export function foldRatings(games: RatedGame[], p: RatingParams = DEFAULTS): Record<string, Rating> {
  const db: Record<string, Rating> = {};
  for (const g of games) {
    for (const id of [g.white, g.black]) db[id] ??= { rating: p.anchor, games: 0 };
    const w = db[g.white] as Rating, b = db[g.black] as Rating;
    const [dw, dbk] = deltas(w.rating, b.rating, g.score_white, g.stake_usd, p);
    w.rating += dw; b.rating += dbk; w.games++; b.games++;
    const r = Object.fromEntries(Object.entries(db).map(([id, x]) => [id, x.rating]));
    decay(r, p);
    for (const id in r) (db[id] as Rating).rating = +(r[id] as number).toFixed(2);
  }
  return db;
}
