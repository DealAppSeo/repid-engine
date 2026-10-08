/**
 * serializeWithdraw — the per-builder withdrawal lock that closes the concurrent-withdrawal
 * TOCTOU Strix flagged on #1261 (two parallel withdrawals reading the same realTotal before
 * either debits). Proven non-vacuous here: same-key calls run one-at-a-time, different keys
 * overlap, and a thrown holder does not wedge the next same-key call.
 *
 * `../src/db` and the heavy layers are mocked so importing stake-vault does not need a live DB.
 */
jest.mock('../src/db', () => ({ db: { from: () => ({}) } }));
jest.mock('../src/services/escrow-refunder', () => ({ escrowRefund: jest.fn() }));

import { serializeWithdraw } from '../src/services/stake-vault';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('serializeWithdraw — per-builder withdrawal lock', () => {
  it('same key: calls run one at a time (no interleave)', async () => {
    const order: string[] = [];
    const task = (tag: string, ms: number) => async () => {
      order.push(`${tag}:start`);
      await sleep(ms);
      order.push(`${tag}:end`);
      return tag;
    };
    const a = serializeWithdraw('b1', task('A', 30));
    const b = serializeWithdraw('b1', task('B', 5)); // queued behind A despite being faster
    await Promise.all([a, b]);
    expect(order).toEqual(['A:start', 'A:end', 'B:start', 'B:end']);
  });

  it('different keys: calls overlap (both start before either ends)', async () => {
    const order: string[] = [];
    const task = (tag: string, ms: number) => async () => {
      order.push(`${tag}:start`);
      await sleep(ms);
      order.push(`${tag}:end`);
      return tag;
    };
    await Promise.all([serializeWithdraw('x', task('C', 30)), serializeWithdraw('y', task('D', 5))]);
    expect(order.slice(0, 2).sort()).toEqual(['C:start', 'D:start']);
  });

  it('a throwing holder does not block the next same-key call', async () => {
    const a = serializeWithdraw('k', async () => {
      throw new Error('boom');
    }).catch(() => 'caught');
    const b = serializeWithdraw('k', async () => 'ok');
    expect(await a).toBe('caught');
    expect(await b).toBe('ok');
  });
});
