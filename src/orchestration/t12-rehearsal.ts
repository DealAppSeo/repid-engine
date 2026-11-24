/**
 * A dry run of the loop on fixtures: five situations the loop must get right before it is trusted
 * with a real row. It calls the same functions the feeder calls (orderFeed, planReplenish) and the
 * same reconcile the status view uses. It imports no database client, so it cannot write a row.
 *
 * Caller: scripts/t12/rehearse.ts, and tests/t12-rehearsal.test.ts.
 */
import { orderFeed, type FeedItem, type Horizon } from './t12-feed-order';
import { planReplenish, type LaneSpec, type PoolRow } from './t12-lane-store';
import { reconcileCard, type CardEvidence, type ReviewEvidence, type TaskEvidence } from './t12-reconcile';

export interface BoardCard { id: string; horizon: Horizon; owner: string; state: string; lane: string; blocked_on?: string }
export interface BoardEvent { card: string; at: string; result: 'failed' | 'passed' | 'dispatched' }
export interface Board { cards: BoardCard[]; events: BoardEvent[]; frozen_lanes: string[]; limit: number }

/**
 * A prototype board snapshot as feed items. For real rows the database already answers these
 * questions (a row's own state says whether its last attempt failed and whether it is out with a
 * worker); this exists so the prototype's snapshots can be replayed against the ported rules.
 * A card owned by a person is set aside with a reason, and the scan continues.
 */
export function itemsFromBoard(b: Board): FeedItem[] {
  const latest = new Map<string, BoardEvent>();
  const dispatched = new Set<string>();
  for (const e of b.events) {
    const prev = latest.get(e.card);
    if (!prev || Date.parse(e.at) >= Date.parse(prev.at)) latest.set(e.card, e);
    if (e.result === 'dispatched') dispatched.add(e.card);
  }
  const failedAt = (id: string) => (latest.get(id)?.result === 'failed' ? latest.get(id)!.at : null);
  const blocked = (c: BoardCard): string | null => {
    if (failedAt(c.id)) return null;
    if (c.owner !== 'T12') return `owner is ${c.owner}, not T12`;
    if (c.state !== 'open') return `state is ${c.state}${c.blocked_on ? `: ${c.blocked_on}` : ''}`;
    if (dispatched.has(c.id)) return 'already dispatched';
    return null;
  };
  const onBoard = new Set(b.cards.map((c) => c.id));
  return [
    ...b.cards.map((c) => ({ id: c.id, horizon: c.horizon, workLane: c.lane, failedAt: failedAt(c.id), blocked: blocked(c) })),
    ...[...latest.values()].filter((e) => !onBoard.has(e.card)).map((e) => ({
      id: e.card, failedAt: failedAt(e.card), blocked: e.result === 'failed' ? null : `latest event is ${e.result}, nothing to fix`,
    })),
  ];
}

export const nextFromBoard = (b: Board) => orderFeed(itemsFromBoard(b), { frozen: b.frozen_lanes, limit: b.limit });

export interface RehearsalInput {
  now: string;
  contract: CardEvidence['contract'];
  maker: TaskEvidence;
  artifacts: NonNullable<CardEvidence['artifacts']>;
  breaker: ReviewEvidence;
  breaker_same_family: ReviewEvidence;
  scoreEvents: NonNullable<CardEvidence['scoreEvents']>;
  blocker_board: Board;
  /** A new card in the failed card's own horizon, listed ahead of it, so the repair has something to beat. */
  repair_rival: BoardCard;
}

export interface RehearsalResult {
  n: number;
  name: string;
  pass: boolean;
  got: unknown;
}

export function rehearse(fx: RehearsalInput, failedBoard: Board, specs: readonly LaneSpec[]): RehearsalResult[] {
  const card = (reviews: ReviewEvidence[]): CardEvidence => ({ card: 'REHEARSAL-1', now: fx.now, maker: fx.maker, artifacts: fx.artifacts, contract: fx.contract, reviews, scoreEvents: fx.scoreEvents });
  const pick = <T extends object, K extends keyof T>(o: T, ...keys: K[]) => Object.fromEntries(keys.map((k) => [k, o[k]]));

  const made = reconcileCard(card([]));
  const reviewed = reconcileCard(card([fx.breaker]));
  const sameFamily = reconcileCard(card([fx.breaker_same_family]));

  const fix = nextFromBoard({ ...failedBoard, cards: [fx.repair_rival, ...failedBoard.cards] });

  const pool: PoolRow[] = [];
  const run = (target: number) => {
    const { insert } = planReplenish(specs, pool, target);
    for (const s of insert) pool.push({ id: s.id, status: 'pending', claim_count: 0 });
    return insert.map((s) => s.id);
  };
  const first = run(3);
  const second = run(3);
  for (const r of pool) r.status = 'done';
  const third = run(3);

  const before = nextFromBoard(fx.blocker_board);
  const cleared: Board = { ...fx.blocker_board, cards: fx.blocker_board.cards.map((c) => (c.state === 'blocked' ? { id: c.id, horizon: c.horizon, owner: c.owner, state: 'open', lane: c.lane } : c)) };
  const after = nextFromBoard(cleared);

  return [
    {
      n: 1, name: 'a saved artifact counts as delivered when the reply is only a summary',
      pass: made.delivery === 'delivered' && made.copies.delivered_in_reply === false && made.copies.delivered_in_artifact === true && made.acceptance === 'pending',
      got: { ...pick(made, 'queue', 'delivery', 'acceptance', 'scoring', 'route'), delivered_in_reply: made.copies.delivered_in_reply, delivered_in_artifact: made.copies.delivered_in_artifact },
    },
    {
      n: 2, name: 'a breaker on another model family verifies that artifact; one on the maker\'s family does not count',
      pass: reviewed.acceptance === 'accepted' && reviewed.route === 'close' && reviewed.scoring === 'shadow_only' && sameFamily.acceptance === 'not_checked',
      got: { other_family: pick(reviewed, 'delivery', 'acceptance', 'scoring', 'route'), same_family: { acceptance: sameFamily.acceptance, reasons: sameFamily.reasons } },
    },
    {
      n: 3, name: 'a failed card comes back for repair before new work in its horizon',
      pass: fix.picks[0]?.kind === 'fix' && fix.picks[1]?.id === fx.repair_rival.id,
      got: fix.picks,
    },
    {
      n: 4, name: 'running the feeder twice dispatches no duplicate',
      pass: first.length === 3 && second.length === 0 && third.every((id) => !first.includes(id)) && new Set(pool.map((r) => r.id)).size === pool.length,
      got: { first_run: first, second_run_nothing_changed: second, third_run_after_the_first_three_finished: third },
    },
    {
      n: 5, name: 'when an immediate blocker clears while a near card is ready, immediate is picked next',
      pass: before.picks[0]?.id !== after.picks[0]?.id && itemsFromBoard(cleared).find((i) => i.id === after.picks[0]?.id)?.horizon === 'immediate'
        && itemsFromBoard(fx.blocker_board).find((i) => i.id === before.picks[0]?.id)?.horizon === 'near',
      got: { while_blocked: before.picks, set_aside: before.skipped.filter((k) => !k.reason.includes('limit')), after_it_clears: after.picks },
    },
  ];
}
