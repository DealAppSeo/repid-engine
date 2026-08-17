/**
 * routing-record-persist.test.ts — the decision half of the (features -> outcome) corpus.
 *
 * These assertions pin the three things that decide whether a later fit is honest:
 *   1. the join key is (call_id, provider), and `provider` is taken from the record's WINNER
 *      (not from anything the caller passes separately, which could drift);
 *   2. the "usable" counts agree with `freeFirstViolated` — one definition, so a row cannot
 *      say "no free provider was usable" and "free-first was violated" at once;
 *   3. the write is OFF by default, and no env value other than the exact string 'true'
 *      turns it on.
 */

import {
  buildRoutingRecordRow,
  routingRecordPersistEnabled,
} from '../src/decisioning/routing-record-persist';
import { buildRoutingRecord } from '../src/decisioning/routing-record';

const FREE = new Set(['groq', 'cerebras', 'gemini']);
const classify = (p: string) => (FREE.has(p) ? 'free' : p === 'unknownco' ? 'unpriced' : 'paid');

const CHAIN: { provider: string; tier: '0a' | '1' | 'slm' }[] = [
  { provider: 'groq', tier: '0a' },
  { provider: 'cerebras', tier: '0a' },
  { provider: 'gemini', tier: '0a' },
  { provider: 'anthropic', tier: '1' },
];

describe('buildRoutingRecordRow — the join key', () => {
  it('keys on (call_id, provider) with provider taken from the record winner', () => {
    const record = buildRoutingRecord({
      chosen: 'cerebras',
      chosenTier: '0a',
      reason: 'static_cost_order',
      chain: CHAIN,
      unhealthy: ['groq'],
      classify,
    });
    const row = buildRoutingRecordRow({ callId: 'abc-123', attempt: 2, record });

    expect(row.call_id).toBe('abc-123');
    expect(row.provider).toBe('cerebras'); // the WINNER, not a separately supplied name
    expect(row.attempt).toBe(2);
  });

  it('records chosen_position as NULL — never 0 — when the winner is not in the chain', () => {
    // 0 is a real position: it means FIRST. An exhausted chain must not be encoded as
    // "the router picked the head of the list", which is the opposite fact.
    const record = buildRoutingRecord({
      chosen: 'none',
      chosenTier: 'none',
      reason: 'all_exhausted',
      chain: CHAIN,
      unhealthy: CHAIN.map((c) => c.provider),
      classify,
    });
    const row = buildRoutingRecordRow({ callId: 'abc-123', attempt: 3, record });

    expect(row.chosen_position).toBeNull();
    expect(row.chain_len).toBe(4);
  });

  it('records position 0 when the head of the chain won', () => {
    const record = buildRoutingRecord({
      chosen: 'groq',
      chosenTier: '0a',
      reason: 'static_cost_order',
      chain: CHAIN,
      classify,
    });
    const row = buildRoutingRecordRow({ callId: 'c', attempt: 1, record });
    expect(row.chosen_position).toBe(0);
  });
});

describe('buildRoutingRecordRow — counts agree with the record they summarise', () => {
  it('counts only USABLE free/paid candidates, matching the free-first definition', () => {
    // groq and cerebras are free but dead; gemini is free and reachable; anthropic paid.
    const record = buildRoutingRecord({
      chosen: 'gemini',
      chosenTier: '0a',
      reason: 'static_cost_order',
      chain: CHAIN,
      unhealthy: ['groq'],
      keyless: ['cerebras'],
      classify,
    });
    const row = buildRoutingRecordRow({ callId: 'c', attempt: 1, record });

    // gemini (chosen) + anthropic (not_reached) are usable. groq/cerebras are not.
    expect(row.n_free_usable).toBe(1);
    expect(row.n_paid_usable).toBe(1);
    expect(row.n_unhealthy).toBe(1);
    expect(row.n_keyless).toBe(1);
    expect(row.free_first_violated).toBe(false);
  });

  it('a violated free-first row always has at least one usable free candidate', () => {
    // paid ahead of a reachable free provider — the invariant this column exists to catch.
    const record = buildRoutingRecord({
      chosen: 'anthropic',
      chosenTier: '1',
      reason: 'static_cost_order',
      chain: [
        { provider: 'anthropic', tier: '1' },
        { provider: 'groq', tier: '0a' },
      ],
      classify,
    });
    const row = buildRoutingRecordRow({ callId: 'c', attempt: 1, record });

    expect(row.free_first_violated).toBe(true);
    // If this were 0 the row would assert a violation with nothing to have violated it.
    expect(row.n_free_usable).toBeGreaterThanOrEqual(1);
  });

  it('carries the full record verbatim so a new feature needs no re-collection', () => {
    const record = buildRoutingRecord({
      chosen: 'groq',
      chosenTier: '0a',
      reason: 'static_cost_order',
      chain: CHAIN,
      classify,
    });
    const row = buildRoutingRecordRow({ callId: 'c', attempt: 1, record });
    expect(row.record.candidates).toHaveLength(4);
    expect(row.record.candidates[3]!.costClass).toBe('paid');
  });

  it('carries no prompt text — the row is provider names, positions and counts only', () => {
    const record = buildRoutingRecord({
      chosen: 'groq',
      chosenTier: '0a',
      reason: 'static_cost_order',
      chain: CHAIN,
      classify,
    });
    const row = buildRoutingRecordRow({ callId: 'c', attempt: 1, record, taskHint: 'factual' });
    const serialised = JSON.stringify(row);
    expect(serialised).not.toMatch(/prompt/i);
    expect(row.task_hint).toBe('factual');
  });
});

describe('routingRecordPersistEnabled — default OFF', () => {
  it('is off when the variable is unset', () => {
    expect(routingRecordPersistEnabled({} as NodeJS.ProcessEnv)).toBe(false);
  });

  it.each(['false', 'FALSE', '1', 'yes', 'on', 'True', ''])(
    'stays off for %p — only the exact string "true" enables it',
    (value) => {
      expect(routingRecordPersistEnabled({ ROUTING_RECORD_PERSIST: value } as NodeJS.ProcessEnv)).toBe(
        false,
      );
    },
  );

  it('is on for exactly "true"', () => {
    expect(
      routingRecordPersistEnabled({ ROUTING_RECORD_PERSIST: 'true' } as NodeJS.ProcessEnv),
    ).toBe(true);
  });
});
