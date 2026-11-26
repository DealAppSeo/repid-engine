/**
 * One card, four separate answers: queue, delivery, acceptance, scoring. Each case is a state seen
 * on 2026-11-23/24; the rows here are written for the test.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { modelFamily, reconcileCard, type CardEvidence, type ReviewEvidence } from '../src/orchestration/t12-reconcile';
import { rehearse, type Board, type RehearsalInput } from '../src/orchestration/t12-rehearsal';
import type { LaneSpec } from '../src/orchestration/t12-lane-store';

const AUDIT = ['1 SUPPORTED', '2 SUPPORTED', '3 NOT SUPPORTED'].join('\n');
const review = (over: Partial<ReviewEvidence> = {}): ReviewEvidence => ({
  id: 2, status: 'done', claimed_by: 'trinity-b', expires_at: null, result: 'all OK', model: 'nvidia/nemotron-3-ultra:free', verdict: 'pass', ...over,
});
const card = (over: Partial<CardEvidence> = {}): CardEvidence => ({
  card: 'C1', now: '2026-11-24T12:00:00Z',
  maker: { id: 1, status: 'done', claimed_by: 'trinity-a', expires_at: null, result: AUDIT, model: 'openai/gpt-oss-120b' },
  artifacts: [{ id: 10, content: AUDIT }], contract: { pattern: 'SUPPORTED', min_lines: 3 },
  reviews: [review()], scoreEvents: [{ id: 5, delta: 0, is_shadow: true }], ...over,
});
const four = (e: CardEvidence) => { const s = reconcileCard(e); return [s.queue, s.delivery, s.acceptance, s.scoring, s.route]; };

describe('reconcile one card', () => {
  it('closes a card that is finished, delivered, independently passed and scored in shadow only', () => {
    const s = reconcileCard(card());
    expect([s.queue, s.delivery, s.acceptance, s.scoring, s.route]).toEqual(['finished', 'delivered', 'accepted', 'shadow_only', 'close']);
    expect(s.task_ids).toEqual({ maker: '1', reviews: ['2'], artifacts: ['10'] });
    expect(s.reasons).toEqual([]);
  });

  it('keeps the four answers apart: a row stored done with nothing delivered is finished and not delivered', () => {
    expect(four(card({ maker: { ...card().maker, result: 'Audit complete.' }, artifacts: [] }))).toEqual(['finished', 'not_delivered', 'accepted', 'shadow_only', 'repair']);
  });

  it('counts a saved artifact when the reply is only a summary', () => {
    expect(four(card({ maker: { ...card().maker, result: 'Saved as a document artifact.' } }))).toEqual(['finished', 'delivered', 'accepted', 'shadow_only', 'close']);
  });

  it('keeps both copies and routes for review when reply and artifact disagree, even with a passing review', () => {
    const s = reconcileCard(card({ artifacts: [{ id: 10, content: AUDIT.replace('3 NOT SUPPORTED', '3 SUPPORTED') }] }));
    expect([s.delivery, s.acceptance, s.route]).toEqual(['disagree', 'needs_review', 'review']);
    expect(s.copies.differences).toEqual([{ line: 3, a: 'reply', a_text: '3 NOT SUPPORTED', b: 'artifact 10', b_text: '3 SUPPORTED' }]);
  });

  it('treats evidence it could not read as not checked, never as a pass or a fail', () => {
    expect(four(card({ maker: { ...card().maker, result: 'Saved.' }, artifacts: null }))).toEqual(['finished', 'not_checked', 'accepted', 'shadow_only', 'not_checked']);
    expect(four(card({ reviews: [review({ verdict: null })] }))).toEqual(['finished', 'delivered', 'not_checked', 'shadow_only', 'not_checked']);
    expect(four(card({ scoreEvents: null }))).toEqual(['finished', 'delivered', 'accepted', 'not_checked', 'not_checked']);
    expect(four(card({ maker: { ...card().maker, status: null } }))[0]).toBe('not_checked');
    // The reply alone meets the contract, so an unreadable artifact store does not undo it.
    expect(four(card({ artifacts: null }))[1]).toBe('delivered');
  });

  it('does not count a review by the maker, on the maker\'s model family, or with no model recorded', () => {
    expect(reconcileCard(card({ reviews: [review({ claimed_by: 'trinity-a' })] })).acceptance).toBe('not_checked');
    const same = reconcileCard(card({ reviews: [review({ model: 'gpt-oss-20b' })] }));
    expect(same.acceptance).toBe('not_checked');
    expect(same.reasons).toEqual(["review 2 ran on gpt-oss, the maker's own model family"]);
    expect(reconcileCard(card({ reviews: [review({ model: null })] })).acceptance).toBe('not_checked');
    expect(reconcileCard(card({ reviews: [] })).acceptance).toBe('pending');
  });

  it('sends a card back for repair when an independent reviewer fails it', () => {
    expect(four(card({ reviews: [review({ verdict: 'fail' })] }))).toEqual(['finished', 'delivered', 'rejected', 'shadow_only', 'repair']);
  });

  it('reads the lease: live is in progress, ended is a repair, and a waiting row waits', () => {
    const working = { ...card().maker, status: 'claimed' };
    expect(four(card({ maker: { ...working, expires_at: '2026-11-24T12:30:00Z' }, reviews: [] }))).toEqual(['in_progress', 'delivered', 'pending', 'shadow_only', 'wait']);
    expect(four(card({ maker: { ...working, expires_at: '2026-11-24T11:00:00Z' }, reviews: [] }))).toEqual(['lease_expired', 'delivered', 'pending', 'shadow_only', 'repair']);
    expect(four(card({ maker: { ...card().maker, status: 'pending', result: null }, artifacts: [], reviews: [], scoreEvents: [] }))).toEqual(['waiting', 'not_delivered', 'pending', 'none', 'wait']);
  });

  it('flags a score event that moved a live score', () => {
    expect(four(card({ scoreEvents: [{ id: 5, delta: 0, is_shadow: true }, { id: 6, delta: 3, is_shadow: false }] }))).toEqual(['finished', 'delivered', 'accepted', 'live_moved', 'review']);
    expect(four(card({ scoreEvents: [{ id: 6, delta: 3, is_shadow: true }] }))[3]).toBe('shadow_only');
  });

  it('names a model family from the ids the runtime records', () => {
    expect(['nvidia/nemotron-3-ultra-550b-a55b:free', 'openai/gpt-oss-120b', 'gpt-oss-20b', 'qwen2.5:3b', '', null].map(modelFamily))
      .toEqual(['nemotron', 'gpt-oss', 'gpt-oss', 'qwen', null, null]);
  });
});

describe('the five rehearsals', () => {
  const dir = join(__dirname, 'fixtures/t12-conductor');
  const json = <T>(f: string): T => JSON.parse(readFileSync(join(dir, f), 'utf8')) as T;
  const board = json<Board>('board-cycle1.json');
  const failedBoard = { ...board, events: board.events.filter((e) => e.at <= '2026-11-24T10:36:00Z') };
  const specs = readFileSync(join(__dirname, '../ops/t12/specs.jsonl'), 'utf8').split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l) as LaneSpec);
  const results = rehearse(json<RehearsalInput>('rehearsal.json'), failedBoard, specs);

  it.each(results.map((r) => [r.n, r.name, r] as const))('%i. %s', (_n, _name, r) => {
    expect(r.pass).toBe(true);
  });

  it('gives the answers the report quotes', () => {
    expect(results[0].got).toEqual({ queue: 'finished', delivery: 'delivered', acceptance: 'pending', scoring: 'shadow_only', route: 'wait', delivered_in_reply: false, delivered_in_artifact: true });
    expect((results[2].got as Array<{ id: string; kind: string }>).map((p) => [p.id, p.kind])).toEqual([['K3', 'fix'], ['K4', 'new'], ['E6', 'new']]);
    expect((results[3].got as { second_run_nothing_changed: string[] }).second_run_nothing_changed).toEqual([]);
    expect(results[4].got).toMatchObject({ while_blocked: [{ id: 'N1' }], after_it_clears: [{ id: 'M1' }] });
  });

  it('fails a rehearsal when the rule it rehearses is broken', () => {
    const broken = rehearse({ ...json<RehearsalInput>('rehearsal.json'), artifacts: [] }, failedBoard, specs);
    expect(broken.map((r) => r.pass)).toEqual([false, false, true, true, true]);
  });

  // The dry run must not be able to write: nothing it loads is a database client.
  it('the dry-run script loads no database client and exits 0', () => {
    const out = execFileSync(process.execPath, ['-r', 'ts-node/register/transpile-only', '-e',
      "process.exit = ((c) => { const db = Object.keys(require.cache).filter((k) => /node_modules[\\\\/](pg|pg-pool|@supabase|ioredis|postgres)[\\\\/]/.test(k)); console.log('DB_MODULES=' + db.length + ' EXIT=' + c); process.reallyExit(c); }); require('./scripts/t12/rehearse.ts');",
    ], { cwd: join(__dirname, '..'), encoding: 'utf8' });
    expect(out).toContain('DRY RUN: 5 of 5 passed');
    expect(out).toContain('DB_MODULES=0 EXIT=0');
  }, 120_000);
});
