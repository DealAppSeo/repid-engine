/**
 * The feed order, against the snapshots the conductor prototype was scored on (2026-11-24):
 * trial CT-1, trial CT-2, and the board of working-loop cycle 1 at three points in its life.
 * The keys were written before the prototype ran; they are not derived from this code.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { orderFeed, specMeta, type FeedItem, type Horizon } from '../src/orchestration/t12-feed-order';
import { validateSpec, type LaneSpec } from '../src/orchestration/t12-lane-store';

interface Card { id: string; horizon: Horizon; owner: string; state: string; lane: string; blocked_on?: string }
interface Event { card: string; at: string; result: 'failed' | 'passed' | 'dispatched' }
interface Snapshot { cards: Card[]; events: Event[]; frozen_lanes: string[]; limit: number }

const load = (name: string): Snapshot => JSON.parse(readFileSync(join(__dirname, 'fixtures/t12-conductor', name), 'utf8'));

/**
 * A board snapshot as feed items. This is the part the database does for the real feeder: a row's
 * state already says whether its last attempt failed and whether it is out with a worker.
 */
function fromSnapshot(s: Snapshot): FeedItem[] {
  const latest = new Map<string, Event>();
  const dispatched = new Set<string>();
  for (const e of s.events) {
    const prev = latest.get(e.card);
    if (!prev || Date.parse(e.at) >= Date.parse(prev.at)) latest.set(e.card, e);
    if (e.result === 'dispatched') dispatched.add(e.card);
  }
  const failedAt = (id: string) => (latest.get(id)?.result === 'failed' ? latest.get(id)!.at : null);
  const blocked = (c: Card): string | null => {
    if (failedAt(c.id)) return null;
    if (c.owner !== 'T12') return `owner is ${c.owner}, not T12`;
    if (c.state !== 'open') return `state is ${c.state}`;
    if (dispatched.has(c.id)) return 'already dispatched';
    return null;
  };
  const onBoard = new Set(s.cards.map((c) => c.id));
  return [
    ...s.cards.map((c) => ({ id: c.id, horizon: c.horizon, workLane: c.lane, failedAt: failedAt(c.id), blocked: blocked(c) })),
    ...[...latest.values()].filter((e) => !onBoard.has(e.card)).map((e) => ({
      id: e.card, failedAt: failedAt(e.card), blocked: e.result === 'failed' ? null : `latest event is ${e.result}, nothing to fix`,
    })),
  ];
}

const run = (s: Snapshot) => orderFeed(fromSnapshot(s), { frozen: s.frozen_lanes, limit: s.limit });
const picked = (s: Snapshot) => run(s).picks.map((p) => [p.id, p.kind]);
const why = (s: Snapshot, id: string) => run(s).skipped.find((k) => k.id === id)?.reason;

describe('feed order on the conductor trial snapshots', () => {
  it('CT-1: the I0 fix, then I2, then N2', () => {
    const s = load('ct1.json');
    expect(picked(s)).toEqual([['I0', 'fix'], ['I2', 'new'], ['N2', 'new']]);
    // Every card not picked is accounted for. (The prototype listed them in board order; here the ones cut by the limit come last.)
    expect(run(s).skipped.map((k) => k.id).sort()).toEqual(['I1', 'I3', 'I4', 'L1', 'L2', 'N1', 'N3', 'N4']);
    expect(why(s, 'N4')).toBe('already dispatched');
    expect(why(s, 'N1')).toBe('work lane outreach is frozen');
    expect(why(s, 'L1')).toContain('limit of 3 reached');
  });

  it('CT-2: the Z7 fix, the Z9 fix, then A2; oldest failure first although the events are out of order', () => {
    const s = load('ct2.json');
    expect(picked(s)).toEqual([['Z7', 'fix'], ['Z9', 'fix'], ['A2', 'new']]);
    expect(why(s, 'Z8')).toBe('latest event is passed, nothing to fix');
    expect(why(s, 'A4')).toBe('work lane outreach is frozen');
  });
});

describe('feed order on the cycle-1 board', () => {
  const board = load('board-cycle1.json');
  const until = (iso: string): Snapshot => ({ ...board, events: board.events.filter((e) => e.at <= iso) });

  it('before anything ran it picks K3, K1, K2, which is what cycle 1 dispatched', () => {
    expect(picked({ ...board, events: [] })).toEqual([['K3', 'new'], ['K1', 'new'], ['K2', 'new']]);
  });

  it('after K3 failed its check, K3 comes back as a fix ahead of the only new card', () => {
    expect(picked(until('2026-11-24T10:36:00Z'))).toEqual([['K3', 'fix'], ['E6', 'new']]);
  });

  it('once the K3 fix passed, only E6 is left and nothing is invented to fill the limit', () => {
    expect(picked(board)).toEqual([['E6', 'new']]);
    expect(why(board, 'O1')).toBe('work lane outreach is frozen');
    expect(why(board, 'K3')).toBe('already dispatched');
  });
});

describe('feed order rules', () => {
  const item = (id: string, over: Partial<FeedItem> = {}): FeedItem => ({ id, ...over });

  it('picks nothing when nothing is eligible and gives every item a reason', () => {
    const out = orderFeed([item('a', { blocked: 'owner is Sean, not T12' }), item('b', { workLane: 'outreach' })], { frozen: ['outreach'], limit: 3 });
    expect(out.picks).toEqual([]);
    expect(out.skipped).toEqual([{ id: 'a', reason: 'owner is Sean, not T12' }, { id: 'b', reason: 'work lane outreach is frozen' }]);
  });

  it('keeps the input order when no item names a horizon, so existing specs are not reordered', () => {
    expect(orderFeed([item('c'), item('a'), item('b')]).picks.map((p) => p.id)).toEqual(['c', 'a', 'b']);
  });

  it('ranks an item with no horizon as near', () => {
    const out = orderFeed([item('later', { horizon: 'long' }), item('plain'), item('now', { horizon: 'immediate' })]);
    expect(out.picks.map((p) => p.id)).toEqual(['now', 'plain', 'later']);
  });

  it('returns a failed item once, as a fix', () => {
    const out = orderFeed([item('r1', { horizon: 'long', failedAt: '2026-11-24T09:20:00Z' }), item('r2', { horizon: 'immediate' }), item('r1')]);
    expect(out.picks.map((p) => [p.id, p.kind])).toEqual([['r1', 'fix'], ['r2', 'new']]);
    expect(out.skipped).toEqual([{ id: 'r1', reason: 'listed twice; the first entry stands' }]);
  });

  // Unlike the prototype: a freeze there did not stop a failed card. Here it does.
  it('does not offer failed work in a frozen work lane', () => {
    const out = orderFeed([item('f', { workLane: 'outreach', failedAt: '2026-11-24T09:00:00Z' }), item('n')], { frozen: ['outreach'] });
    expect(out.picks.map((p) => p.id)).toEqual(['n']);
  });

  it('stops on input it cannot order instead of guessing', () => {
    expect(() => orderFeed([item('x', { failedAt: '3 minutes ago' })])).toThrow(/unreadable failure time/);
    expect(() => orderFeed([item('x', { horizon: 'soon' as Horizon })])).toThrow(/horizon/);
    expect(() => orderFeed([item('x')], { limit: -1 })).toThrow(/limit/);
  });
});

describe('spec fields that ride in context', () => {
  const base: LaneSpec = {
    id: 'meta-1',
    repo: 'DealAppSeo/trustshell',
    title: 'task meta-1',
    prompt: 'Add a focused regression test for the behaviour described in this task.',
    paths: ['tests/meta-1.test.mjs'],
    verify: { runner: 'node-test', target: 'tests/meta-1.test.mjs', controls: [{ file: 'src/thing.mjs', find: '42', replace: '41' }] },
    risk: 'LOW',
  };
  const META = ['meta:horizon=immediate', 'meta:work_lane=pre-post-audit', 'meta:breaker', 'meta:delivery_contract.pattern=^\\d+ \\| .+ \\| (SUPPORTED|NOT SUPPORTED)', 'meta:delivery_contract.min_lines=9'];

  it('reads a delivery contract, a breaker flag, a horizon and a work lane', () => {
    expect(specMeta(['lib/onchain-repid.ts', ...META])).toEqual({
      meta: { horizon: 'immediate', workLane: 'pre-post-audit', breaker: true, deliveryContract: { pattern: '^\\d+ \\| .+ \\| (SUPPORTED|NOT SUPPORTED)', min_lines: 9 } },
      problems: [],
    });
  });

  it('has no breaker and no contract unless the spec asks', () => {
    expect(specMeta(['lib/onchain-repid.ts'])).toEqual({ meta: { breaker: false }, problems: [] });
    expect(specMeta(undefined)).toEqual({ meta: { breaker: false }, problems: [] });
    expect(specMeta(['meta:delivery_contract.pattern=^ok$']).meta.deliveryContract).toEqual({ pattern: '^ok$', min_lines: 1 });
  });

  // The pattern holds a backslash, a star and a question mark: each is refused in a file path.
  it('a spec with these fields is still a valid lane spec, beside its real context files', () => {
    expect(validateSpec({ ...base, context: ['lib/onchain-repid.ts', ...META] })).toEqual([]);
    expect(validateSpec({ ...base, context: ['meta:delivery_contract.pattern=^a*b?\\d$'] })).toEqual([]);
  });

  it('still refuses a context path that only looks harmless', () => {
    expect(validateSpec({ ...base, context: ['.env', 'meta:breaker'] })).toEqual(['context .env may not be read']);
    expect(validateSpec({ ...base, context: ['../meta:breaker'] })).toEqual(['context ../meta:breaker may not be read']);
  });

  it.each([
    [['meta:horizon=soon'], 'meta horizon must be immediate, near, long'],
    [['meta:breaker=yes'], 'meta breaker takes no value'],
    [['meta:breaker', 'meta:breaker'], 'meta breaker is given twice'],
    [['meta:work_lane=Out Reach'], 'meta work_lane must be a short lower-case name'],
    [['meta:delivery_contract.pattern=('], 'meta delivery_contract.pattern is not a valid regular expression'],
    [['meta:delivery_contract.pattern='], 'meta delivery_contract.pattern is empty'],
    [[`meta:delivery_contract.pattern=${'a'.repeat(201)}`], 'meta delivery_contract.pattern is longer than 200 characters'],
    [['meta:delivery_contract.pattern=^ok$', 'meta:delivery_contract.min_lines=0'], 'meta delivery_contract.min_lines must be a whole number of at least 1'],
    [['meta:delivery_contract.min_lines=3'], 'meta delivery_contract.min_lines needs a delivery_contract.pattern'],
    [['meta:budget=free'], 'meta budget is not a known field'],
  ])('refuses %j', (context, problem) => {
    expect(validateSpec({ ...base, context })).toEqual([problem]);
  });
});
