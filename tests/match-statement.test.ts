/**
 * A match is bound BEFORE the prize moves, so the game cannot be rewritten to
 * fit the payout.
 *
 * The fixture is a real adjudicated game — fool's mate, replayed through a chess
 * rules engine, which reports isCheckmate true and the side to move as the
 * loser. Chess is used here precisely because the winner is not a judgement
 * call: a checkmate is a fact about a position that anyone can reproduce from
 * the move list. That is what makes the acceptance criteria checkable rather
 * than prose.
 */
import {
  buildMatchStatement,
  validateMatchRecord,
  winnerOf,
  rateFromReplay,
  MatchStatementError,
  type MatchRecord,
} from '../src/services/match-statement';
import { workStatementCanonicalHash } from '../src/services/work-statement-canonical';

/** Fool's mate. Verified terminal with a real engine [MEASURED 2026-09-04]. */
const FOOLS_MATE: MatchRecord = {
  game: 'chess',
  white_agent: 'trinity-torch',
  black_agent: 'trinity-shofet',
  moves: ['f3', 'e5', 'g4', 'Qh4#'],
  result: 'black_wins',
  termination: 'checkmate',
  final_fen: 'rnb1kbnr/pppp1ppp/8/4p3/6Pq/5P2/PPPPP2P/RNBQKBNR w KQkq - 1 3',
  prize_amount: '100000000000000', // 0.0001 ETH in wei
  prize_asset: 'ETH',
  played_at: '2026-09-04T18:00:00.000Z',
};
const DEADLINE = '2026-09-11T00:00:00.000Z';

describe('who won is derived, never supplied', () => {
  it('reads the winner off the result', () => {
    expect(winnerOf(FOOLS_MATE)).toBe('trinity-shofet');
    expect(winnerOf({ ...FOOLS_MATE, result: 'white_wins' })).toBe('trinity-torch');
    expect(winnerOf({ ...FOOLS_MATE, result: 'draw' })).toBeNull();
  });
});

describe('records that cannot honestly be bound are refused', () => {
  const bad = (over: Partial<MatchRecord>, why: RegExp) => {
    expect(() => validateMatchRecord({ ...FOOLS_MATE, ...over })).toThrow(why);
  };

  it('refuses a player playing itself — a transfer with extra steps', () => {
    bad({ black_agent: 'trinity-torch' }, /cannot play itself/);
  });

  it('refuses a match with no moves — nothing to replay is nothing to verify', () => {
    bad({ moves: [] }, /nothing to replay/);
    bad({ moves: ['e4', ''] }, /non-empty SAN/);
  });

  it('refuses a missing final position', () => {
    bad({ final_fen: '' }, /final_fen is required/);
  });

  it('refuses a termination that contradicts the result', () => {
    // A "draw by checkmate" would sail through if the statement were built from
    // free text. It is caught because both fields are structured.
    bad({ result: 'draw', termination: 'checkmate' }, /contradicts a drawn result/);
    bad({ result: 'black_wins', termination: 'stalemate' }, /contradicts a decisive result/);
  });

  it('refuses a non-positive or non-integer prize', () => {
    bad({ prize_amount: '0' }, /positive integer/);
    bad({ prize_amount: '0.5' }, /positive integer/);
    bad({ prize_amount: '-1' }, /positive integer/);
  });
});

describe('the bound statement', () => {
  const st = buildMatchStatement(FOOLS_MATE, 100000, DEADLINE);

  it('names both players, the result, and where the prize goes', () => {
    expect(st.deliverable).toContain('trinity-torch (white)');
    expect(st.deliverable).toContain('trinity-shofet (black)');
    expect(st.deliverable).toContain('black wins');
    expect(st.deliverable).toContain('100000000000000 wei of ETH to trinity-shofet');
  });

  it('every criterion is checkable by replaying the moves, not by trusting prose', () => {
    expect(st.acceptance_criteria).toHaveLength(4);
    // The move list must be IN the hashed text, not merely described by it.
    expect(st.acceptance_criteria[0]!.text).toMatch(/Replaying these moves in order/);
    expect(st.acceptance_criteria[0]!.text).toContain('f3 e5 g4 Qh4#');
    expect(st.acceptance_criteria[1]!.text).toContain(FOOLS_MATE.final_fen);
    expect(st.acceptance_criteria[2]!.text).toMatch(/checkmate/);
    expect(st.acceptance_criteria[3]!.text).toMatch(/payable to trinity-shofet and to no other party/);
    // Each must clear the DB normaliser's 24-char explicitness floor.
    for (const c of st.acceptance_criteria) expect(c.text.length).toBeGreaterThanOrEqual(24);
  });

  it('a draw pays nobody, and says so', () => {
    const drawn = buildMatchStatement(
      { ...FOOLS_MATE, result: 'draw', termination: 'stalemate' }, 100000, DEADLINE);
    expect(drawn.acceptance_criteria[3]!.text).toMatch(/no prize is payable/);
  });

  it('keeps the ETH prize out of agreed_price, which the DB requires to be USDC', () => {
    // Conflating them would let the settled amount and the advertised prize
    // disagree while both looked bound.
    expect(st.agreed_price).toEqual({ amount_usdc_raw: 100000, currency: 'USDC' });
    expect(JSON.stringify(st.agreed_price)).not.toContain('100000000000000');
  });
});

describe('the hash is what freezes the game', () => {
  const base = buildMatchStatement(FOOLS_MATE, 100000, DEADLINE);
  const hashOf = (m: MatchRecord) =>
    workStatementCanonicalHash(buildMatchStatement(m, 100000, DEADLINE) as any);

  it('is stable for the same game', () => {
    expect(hashOf(FOOLS_MATE)).toBe(workStatementCanonicalHash(base as any));
  });

  it('changes if the result is flipped after the fact', () => {
    // The attack this exists to stop: pay the loser, then relabel who won.
    expect(hashOf({ ...FOOLS_MATE, result: 'white_wins' })).not.toBe(hashOf(FOOLS_MATE));
  });

  it('changes if a single move is edited — even a character that changes nothing else', () => {
    // THIS TEST FOUND A REAL HOLE. The statement first committed only to the move
    // COUNT and the final position, so dropping the '#' from the mating move left
    // the count, the FEN and therefore the hash identical — and "the game cannot
    // be rewritten" was false. The move list is now inside the hashed text.
    expect(hashOf({ ...FOOLS_MATE, moves: ['f3', 'e5', 'g4', 'Qh4'] })).not.toBe(hashOf(FOOLS_MATE));
    // A wholly different game with the same length and result must differ too.
    expect(hashOf({ ...FOOLS_MATE, moves: ['e4', 'e5', 'Qh5', 'Nc6'] })).not.toBe(hashOf(FOOLS_MATE));
  });

  it('changes if the prize amount is edited', () => {
    expect(hashOf({ ...FOOLS_MATE, prize_amount: '999000000000000' })).not.toBe(hashOf(FOOLS_MATE));
  });
});

describe('ratings come from an independent replay, not from the record', () => {
  it('a clean replay meets the three replayable criteria', () => {
    const r = rateFromReplay(
      { legal: true, halfMoves: 4, finalFen: FOOLS_MATE.final_fen, terminationMatches: true, resultMatches: true },
      FOOLS_MATE);
    expect(r.slice(0, 3).every((x) => x.met)).toBe(true);
  });

  it('a replay that lands elsewhere fails criterion 2 and says where it landed', () => {
    const r = rateFromReplay(
      { legal: true, halfMoves: 4, finalFen: '8/8/8/8/8/8/8/8 w - - 0 1', terminationMatches: true, resultMatches: true },
      FOOLS_MATE);
    expect(r[1]!.met).toBe(false);
    expect(r[1]!.note).toMatch(/replay ended at/);
  });

  it('criterion 4 is NOT_CHECKED by replay rather than defaulting to met', () => {
    // A replay cannot see where money went. Rating it true would manufacture the
    // one fact the whole scenario is meant to establish.
    const r = rateFromReplay(
      { legal: true, halfMoves: 4, finalFen: FOOLS_MATE.final_fen, terminationMatches: true, resultMatches: true },
      FOOLS_MATE);
    expect(r[3]!.met).toBe(false);
    expect(r[3]!.note).toMatch(/NOT_CHECKED by replay/);
  });
});

/**
 * THE SCENARIO MUST BE REPRODUCIBLE, or the hash it prints is not evidence.
 *
 * `chess-match.mjs` embeds when the game was played and when the prize claim
 * expires, and both defaulted to "now" — so two runs of the SAME game produced
 * two different statement hashes. A hash quoted as evidence that nobody can
 * recompute is a digest with an unreproducible preimage: one step removed from
 * publishing a digest with no preimage at all, which is the defect the trust
 * receipt exists to fix. `--played-at` / `--deadline` make a run pinnable.
 */
describe('chess-match.mjs is reproducible when its clock is pinned', () => {
  const { execFileSync } = require('node:child_process') as typeof import('node:child_process');
  const { join } = require('node:path') as typeof import('node:path');
  const SCRIPT = join(__dirname, '..', 'scripts', 'scenarios', 'chess-match.mjs');
  const PINNED = ['--played-at', '2026-09-04T18:00:00.000Z', '--deadline', '2026-09-11T18:00:00.000Z'];

  const hashOf = (args: string[]): string => {
    const out = execFileSync('node', [SCRIPT, ...args], { encoding: 'utf8' });
    const m = out.match(/0x[0-9a-f]{64}/);
    if (!m) throw new Error(`no statement hash in output:\n${out}`);
    return m[0];
  };

  it('the same game with the same clock hashes the same, twice', () => {
    expect(hashOf(PINNED)).toBe(hashOf(PINNED));
  });

  it('a different game still hashes differently — pinning did not flatten it', () => {
    const fools = hashOf(PINNED);
    const scholars = hashOf([...PINNED, '--moves', 'e4 e5 Qh5 Nc6 Bc4 Nf6 Qxf7#']);
    expect(scholars).not.toBe(fools);
  });

  it('moving the DEADLINE moves the hash — it is one of the four hashed fields', () => {
    const later = hashOf(['--played-at', '2026-09-04T18:00:00.000Z', '--deadline', '2026-09-12T18:00:00.000Z']);
    expect(later).not.toBe(hashOf(PINNED));
  });

  /**
   * This assertion was written the other way round first, expecting `played_at`
   * to move the hash too. It does not, and the test was wrong rather than the
   * script.
   *
   * The canonical text is FIXED BY THE DATABASE: `work_statement_sha256` covers
   * exactly acceptance_criteria, agreed_price, deadline and deliverable. Adding
   * a fifth field here would make the scenario's hash disagree with the one
   * Postgres computes for the same statement, which is the single thing this
   * transcription must never do. `played_at` is match metadata, not a term of
   * the agreement — and what actually protects the outcome is criterion 1, which
   * carries the move list verbatim and IS hashed.
   */
  it('moving only played_at does NOT move the hash — the DB defines the four fields, not us', () => {
    const other = hashOf(['--played-at', '2026-01-01T00:00:00.000Z', '--deadline', '2026-09-11T18:00:00.000Z']);
    expect(other).toBe(hashOf(PINNED));
  });

  it('refuses a malformed timestamp rather than silently hashing NaN', () => {
    expect(() => hashOf(['--played-at', 'yesterday'])).toThrow();
  });
});
