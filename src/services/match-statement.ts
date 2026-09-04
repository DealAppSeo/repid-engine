/**
 * match-statement.ts — a two-player match as a bindable work statement.
 *
 * WHY A MATCH IS MODELLED AS A CONTRACT, not a direct transfer.
 * `settleX402Payment(winner, loser, 0.0001, matchId, 'ETH')` moves the money in
 * five lines and produces NO RECEIPT: the settlement row lands with
 * `idempotency_key = matchId` and no `service_contracts` row, so
 * `buildTrustReceipt()` returns null for it. A paid match with no receipt is the
 * one shape this whole system exists to avoid — money moved, nothing checkable.
 *
 * So the match is a contract. The prize is the agreed price, the RESULT is the
 * deliverable, and the acceptance criteria are the objective facts of the game.
 * That buys, for free, everything already built around contracts: the DB trigger
 * hashes the statement and freezes it, `criterion_ratings` derive the
 * satisfaction score, the settlement leg produces a real tx, and
 * `scripts/verify-trust-receipt.mjs` can check the whole thing from outside.
 *
 * WHAT MAKES THE OUTCOME TRUSTWORTHY, and it is not this file.
 * Chess is worth using precisely because the winner is NOT a judgement call — a
 * checkmate is a fact about a position, replayable by anyone from the move list.
 * This module does not adjudicate; it commits. It turns an already-adjudicated
 * result plus its full move list into the canonical statement that gets hashed
 * BEFORE the money moves, so the game cannot be rewritten to fit the payout.
 *
 * Adjudication lives in `scripts/scenarios/chess-match.mjs`, which uses a real
 * rules engine. Keeping it out of `src/` keeps a chess dependency out of the
 * production server, and keeps the trust property where it belongs: in the
 * replayable moves, not in our assertion about them.
 *
 * WHAT THIS DOES NOT PROVE. That the moves were chosen by the agents named, that
 * either played well, or that the game was not arranged between them. It proves
 * the recorded game and its result were fixed before payout and have not moved
 * since. Collusion is countable here, not prevented — the same honest limit the
 * negotiation module states about its own award record.
 */

export type MatchResult = 'white_wins' | 'black_wins' | 'draw';
export type MatchTermination = 'checkmate' | 'resignation' | 'stalemate' | 'insufficient_material' | 'threefold_repetition' | 'fifty_move' | 'timeout' | 'agreed_draw';

export interface MatchRecord {
  game: string;
  white_agent: string;
  black_agent: string;
  /** Full move list in SAN, in order. The evidence a third party replays. */
  moves: string[];
  result: MatchResult;
  termination: MatchTermination;
  /** Terminal position, so a verifier can check its replay landed in the same place. */
  final_fen: string;
  /** Prize in the settlement asset's own smallest unit (wei for ETH, raw for USDC). */
  prize_amount: string;
  prize_asset: 'ETH' | 'USDC';
  played_at: string;
}

export interface MatchStatement {
  deliverable: string;
  acceptance_criteria: Array<{ n: number; text: string }>;
  agreed_price: { amount_usdc_raw: number; currency: 'USDC' };
  deadline: string;
}

export class MatchStatementError extends Error {}

/** The winning agent, or null on a draw. Derived, never supplied. */
export function winnerOf(m: Pick<MatchRecord, 'result' | 'white_agent' | 'black_agent'>): string | null {
  if (m.result === 'draw') return null;
  return m.result === 'white_wins' ? m.white_agent : m.black_agent;
}

/**
 * Refuse a record that cannot honestly be bound.
 *
 * Every one of these is a way the statement could be made to say something the
 * game does not support, so each is refused rather than normalised away.
 */
export function validateMatchRecord(m: MatchRecord): void {
  if (!m.white_agent || !m.black_agent) throw new MatchStatementError('both players must be named');
  if (m.white_agent === m.black_agent) {
    // A self-match has a guaranteed winner and a guaranteed loser, both the same
    // wallet. It is not a contest, it is a transfer with extra steps.
    throw new MatchStatementError('a player cannot play itself — that is not a contest');
  }
  if (!Array.isArray(m.moves) || m.moves.length === 0) {
    throw new MatchStatementError('a match with no moves has nothing to replay, so nothing to verify');
  }
  if (m.moves.some((x) => typeof x !== 'string' || x.trim() === '')) {
    throw new MatchStatementError('every move must be a non-empty SAN string');
  }
  if (!m.final_fen || m.final_fen.trim() === '') {
    throw new MatchStatementError('final_fen is required — without it a replay cannot be compared to anything');
  }
  if (m.result === 'draw' && (m.termination === 'checkmate' || m.termination === 'resignation')) {
    throw new MatchStatementError(`termination '${m.termination}' contradicts a drawn result`);
  }
  if (m.result !== 'draw' && (m.termination === 'stalemate' || m.termination === 'agreed_draw')) {
    throw new MatchStatementError(`termination '${m.termination}' contradicts a decisive result`);
  }
  if (!/^\d+$/.test(String(m.prize_amount)) || BigInt(m.prize_amount) <= 0n) {
    throw new MatchStatementError('prize_amount must be a positive integer in the asset smallest unit');
  }
}

/**
 * Build the statement that gets hashed and frozen before the prize moves.
 *
 * The criteria are written so each is INDEPENDENTLY CHECKABLE by replaying the
 * moves — they are not prose about quality. That is the difference between a
 * statement a verifier can act on and one a reader has to trust.
 *
 * `agreed_price` is the contract's USDC price and is separate from the prize:
 * the DB normaliser requires USDC there, and an ETH prize is recorded in the
 * criteria where it is covered by the same hash. Conflating them would let the
 * settled amount and the advertised prize disagree.
 */
export function buildMatchStatement(m: MatchRecord, contractPriceUsdcRaw: number, deadline: string): MatchStatement {
  validateMatchRecord(m);
  const winner = winnerOf(m);
  const prizeUnit = m.prize_asset === 'ETH' ? 'wei' : 'raw USDC units';

  return {
    deliverable:
      `${m.game} match between ${m.white_agent} (white) and ${m.black_agent} (black), played to a ` +
      `${m.result.replace('_', ' ')} by ${m.termination.replace(/_/g, ' ')} in ${m.moves.length} half-moves. ` +
      `Prize ${m.prize_amount} ${prizeUnit} of ${m.prize_asset} to ` +
      `${winner ?? 'neither player (draw)'}.`,
    acceptance_criteria: [
      {
        // THE MOVES THEMSELVES ARE IN THE HASHED TEXT, and that is load-bearing.
        // An earlier version committed only to the move COUNT and the final
        // position — so an edit that changed neither (dropping the '#' from a
        // mating move, say) left the hash identical, and the claim that the game
        // could not be rewritten was false. Its own test caught it. The move list
        // is the evidence; evidence outside the commitment is not evidence.
        n: 1,
        text:
          `Replaying these moves in order from the standard starting position yields a legal game of ` +
          `${m.moves.length} half-moves: ${m.moves.join(' ')}`,
      },
      {
        n: 2,
        text: `That replay terminates in the recorded final position: ${m.final_fen}`,
      },
      {
        n: 3,
        text: `The terminal position is a ${m.termination.replace(/_/g, ' ')}, giving the recorded result: ${m.result.replace('_', ' ')}.`,
      },
      {
        n: 4,
        text: winner
          ? `The prize of ${m.prize_amount} ${prizeUnit} (${m.prize_asset}) is payable to ${winner} and to no other party.`
          : `The result is a draw, so no prize is payable to either player and the stake returns to its source.`,
      },
    ],
    agreed_price: { amount_usdc_raw: contractPriceUsdcRaw, currency: 'USDC' },
    deadline,
  };
}

/**
 * Ratings for the four criteria, from an INDEPENDENT replay.
 *
 * Takes the replay's own findings rather than the match record, so a criterion
 * is met because a verifier reproduced it — not because the record asserted it.
 * Passing the record's own claims in here would make every match self-certifying,
 * which is the failure this whole file is arranged to avoid.
 */
export function rateFromReplay(replay: {
  legal: boolean;
  halfMoves: number;
  finalFen: string;
  terminationMatches: boolean;
  resultMatches: boolean;
}, m: MatchRecord): Array<{ n: number; met: boolean; note: string }> {
  return [
    { n: 1, met: replay.legal && replay.halfMoves === m.moves.length,
      note: replay.legal ? `replayed ${replay.halfMoves} legal half-moves` : 'replay hit an illegal move' },
    { n: 2, met: replay.finalFen === m.final_fen,
      note: replay.finalFen === m.final_fen ? 'replay reached the recorded position' : `replay ended at ${replay.finalFen}` },
    { n: 3, met: replay.terminationMatches && replay.resultMatches,
      note: replay.terminationMatches && replay.resultMatches ? 'terminal state and result agree with the record' : 'terminal state disagrees with the record' },
    // Criterion 4 is about where the money went, which a replay cannot see. It is
    // rated by the settlement leg, not here, and says so rather than defaulting true.
    { n: 4, met: false, note: 'NOT_CHECKED by replay — payment destination is checked against the settlement receipt' },
  ];
}
