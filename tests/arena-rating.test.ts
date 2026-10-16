/**
 * src/arena/rating.ts is a port of lane AC's E:\dev\ops\agentchess\ratings.mjs, not a fork.
 *
 * Every expected number below was produced by RUNNING AC's ratings.mjs (sha256 c3e1bb8a…f227; the later 8e51b067…21b8 changes no math),
 * 2026-10-16: its exported expected/stakeMult/deltas/spreads/decay, and its applyGame over the
 * five games in FOLD on a fresh in-memory db. If the port drifts from AC, this goes red.
 */
import { DEFAULTS, decay, deltas, expected, foldRatings, spreads, stakeMult } from '../src/arena/rating';

const close = (a: number, b: number) => expect(Math.abs(a - b)).toBeLessThan(1e-9);

describe('arena rating matches lane AC numbers', () => {
  it('expected score', () => {
    close(expected(1500, 1500), 0.5);
    close(expected(1700, 1500), 0.7597469266479578);
    close(expected(1300, 1700), 0.09090909090909091);
  });

  it('stake multiplier: $0 and $0.10 count half, $1 once, $10 and up twice', () => {
    expect([0, 0.1, 1, 10, 1000, 0.01].map((s) => stakeMult(s))).toEqual([0.5, 0.5, 1, 2, 2, 0.5]);
  });

  it('asymmetric deltas (lambda 0.5): the upset pays the underdog more than it costs the favourite', () => {
    const [w, l] = deltas(1500, 1700, 1, 1, { ...DEFAULTS, decay: 0 });
    close(w, 24.311901652734655);
    close(l, -12.155950826367327);
    const [dw, db] = deltas(1600, 1400, 0.5, 10, DEFAULTS);
    close(dw, -8.311901652734651);
    close(db, 16.623803305469302);
    const [fw, fb] = deltas(1700, 1500, 1, 0.1, DEFAULTS);
    close(fw, 3.8440491736326745);
    close(fb, -1.9220245868163373);
    const [pw, pb] = deltas(1300, 1700, 0, 1, { ...DEFAULTS, alpha: 0.5 }, 0.4);
    close(pw, -0.06338483169519638);
    close(pb, 0.12676966339039275);
  });

  it('lambda = 1 is zero-sum', () => {
    const [a, b] = deltas(1500, 1500, 1, 1, { ...DEFAULTS, lambda: 1 });
    close(a + b, 0);
  });

  it('spreads locked from the rating gap', () => {
    expect(spreads(1300, 1700, 120)).toEqual({
      white: { E_result: 0.0909, performance: 0.317, survival_plies: 42, survival_pawns: 3 },
      black: { E_result: 0.9091, performance: 0.683, survival_plies: 120, survival_pawns: 3 },
      set_from: { white: 1300, black: 1700 },
      params: { dPerf: 1200, survivalPawns: 3 },
    });
  });

  it('recenter decay keeps every gap and pulls the mean toward the anchor', () => {
    const r = { x: 1600, y: 1500, z: 1450 };
    decay(r, { ...DEFAULTS, decay: 0.5, decayMode: 'recenter' });
    close(r.x, 1591.6666666666665);
    close(r.y, 1491.6666666666665);
    close(r.z, 1441.6666666666665);
    close(r.x - r.z, 150);
  });

  it('folding games in order reproduces AC applyGame exactly (2-decimal rounding included)', () => {
    const FOLD = [
      { white: 'a', black: 'b', score_white: 1, stake_usd: 1 },
      { white: 'b', black: 'c', score_white: 0.5, stake_usd: 10 },
      { white: 'c', black: 'a', score_white: 0, stake_usd: 0.1 },
      { white: 'a', black: 'c', score_white: 1, stake_usd: 0 },
      { white: 'b', black: 'a', score_white: 1, stake_usd: 1 },
    ];
    expect(foldRatings(FOLD)).toEqual({
      a: { rating: 1520.98, games: 4 },
      b: { rating: 1509.37, games: 3 },
      c: { rating: 1491.19, games: 3 },
    });
  });
});
