/**
 * What a human's WALLET signs in the arena, and the exact text of it. In its own module so the
 * route (src/routes/arena.ts) and the record verifier (src/arena/game-key.ts verifyGameRecord) build
 * the SAME text: the verifier rebuilds every published grant statement exactly, it never searches it.
 */
import type { TimeControl } from './referee';
import type { Speed } from './store';

/**
 * What a human's WALLET signs. Each variant names everything the server will do with the request.
 * `grant` (a game key's RFC 7638 thumbprint) rides on a challenge or an accept, so a human signs once
 * per game. Moves are not here: a game key signs those (src/arena/game-key.ts).
 */
export type ArenaAction =
  | { action: 'challenge'; game?: string; opponent: string; colour: 'white' | 'black'; stake_usd: number; time_control: TimeControl; speed: Speed; grant?: string }
  | { action: 'accept'; game: string; colour: 'white' | 'black'; stake_usd: number; grant?: string }
  | { action: 'grant'; game: string; colour: 'white' | 'black'; stake_usd: number; grant: string }
  | { action: 'revoke'; game: string }
  | { action: 'scoresheet'; game: string; result: string; plies: number; chain_head: string }
  | { action: 'predict'; game: string; side: 'white' | 'black'; probability: number };

/**
 * The arena's signed statement, in plain words. The page builds the same text (src/arena/page.ts,
 * pinned equal by tests/arena.test.ts) and shows it before the wallet does.
 */
export function arenaStatement(a: ArenaAction, wallet: string, timestamp: string): string {
  const lines = ['HyperDAG AgentChess arena (testnet; no money moves)'];
  const stake = (usd: number) => `stake: ${usd} testnet USD, on your own win`;
  if (a.action === 'challenge') {
    lines.push('action: challenge', ...(a.game ? [`game: ${a.game}`] : []), `opponent: ${a.opponent}`, `you play: ${a.colour}`,
      stake(a.stake_usd), `time control: ${a.time_control}`, `viewer speed: ${a.speed}`, ...(a.grant ? grantLines(a.grant) : []));
  } else if (a.action === 'accept') {
    lines.push('action: accept challenge', `game: ${a.game}`, `you play: ${a.colour}`, stake(a.stake_usd), ...(a.grant ? grantLines(a.grant) : []));
  } else if (a.action === 'grant') {
    lines.push('action: grant a game key', `game: ${a.game}`, `you play: ${a.colour}`, stake(a.stake_usd), ...grantLines(a.grant));
  } else if (a.action === 'revoke') {
    lines.push('action: end game key', `game: ${a.game}`);
  } else if (a.action === 'scoresheet') {
    lines.push('action: sign the scoresheet (I accept the result)', `game: ${a.game}`, `result: ${a.result}`, `plies: ${a.plies}`, `move chain: ${a.chain_head}`);
  } else {
    lines.push('action: predict (calibration only)', `game: ${a.game}`, `side: ${a.side} wins`, `probability: ${a.probability}`);
  }
  lines.push(`wallet: ${wallet.toLowerCase()}`, `time: ${timestamp}`);
  return lines.join('\n');
}

/** The grant lines a wallet signs, in plain words. */
export function grantLines(thumbprint: string): string[] {
  return [
    `game key: ${thumbprint}`,
    'game key may: move, offer a draw, accept a draw and resign for you, in this game only',
    'resigning, or agreeing a draw, can lose this game\'s stake',
    'game key may never: move funds, change a stake, create or accept a challenge, or act in another game',
    'game key ends: when this game ends, when you sign "end game key", or when you grant a new key for this game',
  ];
}
