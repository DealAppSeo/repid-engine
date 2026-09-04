#!/usr/bin/env node
//
// chess-match.mjs — two agents play, the winner is a FACT, and the prize is
// bound to the game before it moves.
//
// Usage:
//   node scripts/scenarios/chess-match.mjs                       # fool's mate
//   node scripts/scenarios/chess-match.mjs --moves "e4 e5 Qh5 Nc6 Bc4 Nf6 Qxf7#"
//   node scripts/scenarios/chess-match.mjs --white A --black B --prize-wei 100000000000000
//   node scripts/scenarios/chess-match.mjs --out match.json
//
// WHY CHESS. The winner is not a judgement call. A checkmate is a fact about a
// position that anyone can reproduce from the move list, so the outcome needs no
// trusted adjudicator — which is exactly what a trust demo should not require.
// Everywhere else in this system an outcome is someone's rating; here it is not.
//
// WHAT THIS SCRIPT DOES, AND WHAT IT DOES NOT.
// DOES: adjudicate the game with a real rules engine, refuse a game that is not
// actually terminal, build the canonical work statement, hash it exactly as the
// database would, and rate each criterion from an INDEPENDENT replay.
// DOES NOT: move money. Settlement needs an agent-bound API key this script does
// not mint, so the payment leg is reported NOT_CHECKED and the artifact says so.
// A scenario that printed "paid" without a transaction would be the exact defect
// this codebase keeps removing.

import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { Chess } from 'chess.js';

const argv = process.argv.slice(2);
const flag = (n, d = null) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : d; };

const WHITE = flag('--white', 'trinity-torch');
const BLACK = flag('--black', 'trinity-shofet');
const PRIZE_WEI = flag('--prize-wei', '100000000000000'); // 0.0001 ETH
const MOVES = (flag('--moves', 'f3 e5 g4 Qh4#')).trim().split(/\s+/);
const OUT = flag('--out');

// ── adjudicate ───────────────────────────────────────────────────────────────
const board = new Chess();
const played = [];
for (const san of MOVES) {
  let mv;
  try { mv = board.move(san); } catch { mv = null; }
  if (!mv) {
    console.error(`FAILED — illegal move '${san}' at half-move ${played.length + 1}. Not a game, so nothing to bind.`);
    process.exit(1);
  }
  played.push(mv.san);
}

if (!board.isGameOver()) {
  // An unfinished game has no winner, so there is nobody to pay. Refusing here
  // is the point: a prize paid on an unterminated game is a prize paid on an
  // opinion about who was winning.
  console.error(`FAILED — the game is not over after ${played.length} half-moves. No terminal position, no winner, no payout.`);
  process.exit(1);
}

const loserToMove = board.turn(); // 'w' | 'b' — the side that cannot move
let result, termination;
if (board.isCheckmate()) {
  result = loserToMove === 'w' ? 'black_wins' : 'white_wins';
  termination = 'checkmate';
} else if (board.isStalemate()) { result = 'draw'; termination = 'stalemate'; }
else if (board.isInsufficientMaterial()) { result = 'draw'; termination = 'insufficient_material'; }
else if (board.isThreefoldRepetition()) { result = 'draw'; termination = 'threefold_repetition'; }
else { result = 'draw'; termination = 'fifty_move'; }

const record = {
  game: 'chess',
  white_agent: WHITE,
  black_agent: BLACK,
  moves: played,
  result,
  termination,
  final_fen: board.fen(),
  prize_amount: PRIZE_WEI,
  prize_asset: 'ETH',
  played_at: new Date().toISOString(),
};
const winner = result === 'draw' ? null : (result === 'white_wins' ? WHITE : BLACK);

// ── bind (transcribed from the DB's canonical text — same as the verifier) ───
const prizeUnit = 'wei';
const statement = {
  deliverable:
    `chess match between ${WHITE} (white) and ${BLACK} (black), played to a ${result.replace('_', ' ')} ` +
    `by ${termination.replace(/_/g, ' ')} in ${played.length} half-moves. ` +
    `Prize ${PRIZE_WEI} ${prizeUnit} of ETH to ${winner ?? 'neither player (draw)'}.`,
  acceptance_criteria: [
    { n: 1, text: `Replaying these moves in order from the standard starting position yields a legal game of ${played.length} half-moves: ${played.join(' ')}` },
    { n: 2, text: `That replay terminates in the recorded final position: ${board.fen()}` },
    { n: 3, text: `The terminal position is a ${termination.replace(/_/g, ' ')}, giving the recorded result: ${result.replace('_', ' ')}.` },
    { n: 4, text: winner
        ? `The prize of ${PRIZE_WEI} ${prizeUnit} (ETH) is payable to ${winner} and to no other party.`
        : `The result is a draw, so no prize is payable to either player and the stake returns to its source.` },
  ],
  agreed_price: { amount_usdc_raw: 100000, currency: 'USDC' },
  deadline: new Date(Date.now() + 7 * 864e5).toISOString().replace('Z', 'Z'),
};

function canonicalText(ws) {
  const crit = [...ws.acceptance_criteria].sort((a, b) => a.n - b.n)
    .map((c) => `{"n":${c.n},"text":${JSON.stringify(String(c.text))}}`).join(',');
  return `{"acceptance_criteria":[${crit}],"agreed_price":{"amount_usdc_raw":${ws.agreed_price.amount_usdc_raw},"currency":${JSON.stringify(ws.agreed_price.currency)}},"deadline":${JSON.stringify(ws.deadline)},"deliverable":${JSON.stringify(ws.deliverable)}}`;
}
const statementHash = '0x' + createHash('sha256').update(Buffer.from(canonicalText(statement), 'utf8')).digest('hex');

// ── rate from an INDEPENDENT replay, not from the record ────────────────────
const replay = new Chess();
let legal = true;
for (const san of record.moves) { try { if (!replay.move(san)) legal = false; } catch { legal = false; } }
const ratings = [
  { n: 1, met: legal && replay.history().length === record.moves.length, note: legal ? `replayed ${replay.history().length} legal half-moves` : 'replay hit an illegal move' },
  { n: 2, met: replay.fen() === record.final_fen, note: replay.fen() === record.final_fen ? 'replay reached the recorded position' : `replay ended at ${replay.fen()}` },
  { n: 3, met: replay.isGameOver() && replay.isCheckmate() === (termination === 'checkmate'), note: 'terminal state agrees with the record' },
  { n: 4, met: false, note: 'NOT_CHECKED by replay — payment destination is checked against the settlement receipt' },
];
const met = ratings.filter((r) => r.met).length;

// ── report ──────────────────────────────────────────────────────────────────
console.log(`chess: ${WHITE} (white) vs ${BLACK} (black)`);
console.log(`  moves       ${played.join(' ')}`);
console.log(`  termination ${termination}`);
console.log(`  result      ${result}  ->  winner: ${winner ?? '(draw)'}`);
console.log(`  final fen   ${board.fen()}`);
console.log('');
console.log(`  statement hash  ${statementHash}`);
console.log(`  bound before any payout, so the game cannot be rewritten to fit it`);
console.log('');
for (const r of ratings) console.log(`  ${r.met ? 'ok  ' : '??  '} criterion ${r.n}  ${r.note}`);
console.log(`  derived satisfaction score: ${(met / ratings.length).toFixed(4)}  (round(${met}/${ratings.length}, 4))`);
console.log('');
console.log('  ??  settlement            NOT_CHECKED — this script does not hold an agent-bound API key,');
console.log('                            so no ETH moved. Nothing here claims a payment happened.');

const artifact = { record, statement, statement_hash: statementHash, criterion_ratings: ratings,
  buyer_satisfaction_score: Number((met / ratings.length).toFixed(4)),
  settlement: { outcome: 'NOT_CHECKED', detail: 'no agent-bound API key; no transaction was attempted' } };
if (OUT) { writeFileSync(OUT, JSON.stringify(artifact, null, 2)); console.log(`\n  wrote ${OUT}`); }
