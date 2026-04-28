/**
 * Daily audit-chain Merkle anchor tests.
 *
 * Mocks db (controllable row sets per query) and ethers Wallet/JsonRpcProvider
 * so no real network or DB calls happen.
 */

let auditRows: Array<{ id: number; event_payload: Record<string, unknown>; previous_entry_hash: string | null }> = [];
let lastUpsert: Record<string, unknown> | null = null;
let upsertShouldFail = false;

jest.mock('../src/db', () => {
  const queryBuilder: any = {
    _table: '',
    select() { return this; },
    eq() { return this; },
    gte() { return this; },
    lt() { return this; },
    order() { return this; },
    upsert(row: any) {
      lastUpsert = row;
      return Promise.resolve(upsertShouldFail
        ? { data: null, error: { message: 'simulated upsert failure' } }
        : { data: row, error: null });
    },
    then(resolve: (r: any) => void) {
      if (this._table === 'hal_audit_chain') resolve({ data: auditRows, error: null });
      else resolve({ data: null, error: null });
    },
  };
  return {
    db: {
      from(table: string) { queryBuilder._table = table; return queryBuilder; },
      rpc: async () => ({ data: null, error: null }),
    },
  };
});

let lastSendTxArgs: { to: string; value: bigint; data: string } | null = null;
let sendTxShouldThrow: Error | null = null;
let sendTxHashOverride: string | null = null;

jest.mock('ethers', () => {
  const actual = jest.requireActual('ethers');
  class MockWallet {
    address: string;
    privateKey: string;
    constructor(privateKey: string, _provider?: unknown) {
      this.privateKey = privateKey;
      this.address = '0x000000000000000000000000000000000000ABcd';
    }
    async sendTransaction(tx: { to: string; value: bigint; data: string }) {
      if (sendTxShouldThrow) throw sendTxShouldThrow;
      lastSendTxArgs = tx;
      return {
        hash: sendTxHashOverride ?? '0xfeedfacefeedfacefeedfacefeedfacefeedfacefeedfacefeedfacefeedface',
        wait: async () => ({ status: 1 }),
      };
    }
  }
  class MockProvider {
    constructor(_url: string) {}
  }
  return {
    ...actual,
    Wallet: MockWallet,
    JsonRpcProvider: MockProvider,
  };
});

import {
  computeDailyMerkleRoot,
  anchorDailyRoot,
  buildMerkleRoot,
  _internals,
} from '../src/services/audit-merkle-anchor';
import { ZeroHash, keccak256, getBytes, concat } from 'ethers';

const TEST_KEY = '0x' + '11'.repeat(32);

beforeEach(() => {
  auditRows = [];
  lastUpsert = null;
  upsertShouldFail = false;
  lastSendTxArgs = null;
  sendTxShouldThrow = null;
  sendTxHashOverride = null;
  process.env.AUDIT_ANCHOR_PRIVATE_KEY = TEST_KEY;
});

afterEach(() => {
  delete process.env.AUDIT_ANCHOR_PRIVATE_KEY;
  delete process.env.DEPLOYER_PRIVATE_KEY;
});

const DAY = new Date('2026-04-27T00:00:00.000Z');

describe('buildMerkleRoot — pure function', () => {
  it('empty input → ZeroHash', () => {
    expect(buildMerkleRoot([])).toBe(ZeroHash);
  });

  it('single leaf → root equals leaf', () => {
    const leaf = keccak256(getBytes('0x' + 'aa'.repeat(32)));
    expect(buildMerkleRoot([leaf])).toBe(leaf);
  });

  it('two leaves → keccak256(left || right)', () => {
    const a = keccak256(getBytes('0x' + 'aa'.repeat(32)));
    const b = keccak256(getBytes('0x' + 'bb'.repeat(32)));
    const expected = keccak256(concat([getBytes(a), getBytes(b)]));
    expect(buildMerkleRoot([a, b])).toBe(expected);
  });

  it('three leaves duplicate the last (Bitcoin-style odd → dup)', () => {
    const a = keccak256(getBytes('0x' + 'aa'.repeat(32)));
    const b = keccak256(getBytes('0x' + 'bb'.repeat(32)));
    const c = keccak256(getBytes('0x' + 'cc'.repeat(32)));
    const ab = keccak256(concat([getBytes(a), getBytes(b)]));
    const cc = keccak256(concat([getBytes(c), getBytes(c)]));
    const expected = keccak256(concat([getBytes(ab), getBytes(cc)]));
    expect(buildMerkleRoot([a, b, c])).toBe(expected);
  });

  it('deterministic — same input twice yields the same root', () => {
    const leaves = ['aa', 'bb', 'cc', 'dd', 'ee'].map(h => keccak256(getBytes('0x' + h.repeat(32))));
    expect(buildMerkleRoot(leaves)).toBe(buildMerkleRoot(leaves));
  });
});

describe('computeDailyMerkleRoot', () => {
  it('empty day → ZeroHash + entry_count 0', async () => {
    auditRows = [];
    const r = await computeDailyMerkleRoot(DAY);
    expect(r.root).toBe(ZeroHash);
    expect(r.entry_count).toBe(0);
    expect(r.first_id).toBeNull();
    expect(r.last_id).toBeNull();
  });

  it('single entry → root equals leaf hash', async () => {
    auditRows = [
      { id: 100, event_payload: { event_type: 'sample' }, previous_entry_hash: null },
    ];
    const r = await computeDailyMerkleRoot(DAY);
    expect(r.entry_count).toBe(1);
    expect(r.first_id).toBe(100);
    expect(r.last_id).toBe(100);
    expect(r.root).toBe(_internals.leafHash(auditRows[0]!));
  });

  it('multiple entries — root is deterministic', async () => {
    auditRows = [
      { id: 1, event_payload: { event_type: 'a' }, previous_entry_hash: null },
      { id: 2, event_payload: { event_type: 'b' }, previous_entry_hash: 'aaaa' },
      { id: 3, event_payload: { event_type: 'c' }, previous_entry_hash: 'bbbb' },
    ];
    const r1 = await computeDailyMerkleRoot(DAY);
    const r2 = await computeDailyMerkleRoot(DAY);
    expect(r1.root).toBe(r2.root);
    expect(r1.entry_count).toBe(3);
    expect(r1.first_id).toBe(1);
    expect(r1.last_id).toBe(3);
    expect(r1.root).not.toBe(ZeroHash);
  });
});

describe('anchorDailyRoot', () => {
  it('empty day → status=no_entries, no tx sent, persists no_entries row', async () => {
    auditRows = [];
    const r = await anchorDailyRoot(DAY);
    expect(r.status).toBe('no_entries');
    expect(r.entry_count).toBe(0);
    expect(r.tx_hash).toBeNull();
    expect(lastSendTxArgs).toBeNull();
    expect(lastUpsert).toMatchObject({
      anchor_date: '2026-04-27',
      entry_count: 0,
      status: 'no_entries',
    });
  });

  it('non-empty day → sends tx with root in data field, status=sent', async () => {
    auditRows = [
      { id: 10, event_payload: { event_type: 'a' }, previous_entry_hash: null },
      { id: 11, event_payload: { event_type: 'b' }, previous_entry_hash: 'h' },
    ];
    const r = await anchorDailyRoot(DAY);
    expect(r.status).toBe('sent');
    expect(r.entry_count).toBe(2);
    expect(r.tx_hash).toMatch(/^0x[0-9a-f]+$/i);
    expect(r.basescan_url).toContain('sepolia.basescan.org/tx/');
    expect(lastSendTxArgs).not.toBeNull();
    // data field carries the root bytes verbatim.
    expect(lastSendTxArgs!.data).toBe(r.root);
    expect(lastSendTxArgs!.value).toBe(0n);
    expect(lastUpsert).toMatchObject({
      anchor_date: '2026-04-27',
      entry_count: 2,
      status: 'sent',
      first_audit_id: 10,
      last_audit_id: 11,
    });
  });

  it('network timeout / send error → status=pending_retry, persisted as such, no throw', async () => {
    auditRows = [
      { id: 20, event_payload: { x: 1 }, previous_entry_hash: null },
    ];
    sendTxShouldThrow = new Error('simulated network failure');
    const r = await anchorDailyRoot(DAY);
    expect(r.status).toBe('pending_retry');
    expect(r.tx_hash).toBeNull();
    expect(r.error).toMatch(/network|fail/i);
    expect(lastUpsert).toMatchObject({
      anchor_date: '2026-04-27',
      status: 'pending_retry',
    });
  });

  it('no signing key → status=failed_no_wallet, persists, no throw', async () => {
    auditRows = [{ id: 30, event_payload: { y: 2 }, previous_entry_hash: null }];
    delete process.env.AUDIT_ANCHOR_PRIVATE_KEY;
    delete process.env.DEPLOYER_PRIVATE_KEY;
    const r = await anchorDailyRoot(DAY);
    expect(r.status).toBe('failed_no_wallet');
    expect(r.tx_hash).toBeNull();
    expect(r.error).toMatch(/PRIVATE_KEY/);
    expect(lastUpsert).toMatchObject({ status: 'failed_no_wallet' });
  });

  it('persistence failure after successful tx → status=failed_persist, tx hash still returned', async () => {
    auditRows = [{ id: 40, event_payload: { z: 3 }, previous_entry_hash: null }];
    upsertShouldFail = true;
    const r = await anchorDailyRoot(DAY);
    expect(r.status).toBe('failed_persist');
    expect(r.tx_hash).not.toBeNull();
    expect(r.error).toMatch(/upsert/i);
  });

  it('upsert row carries first_id and last_id matching the queried range', async () => {
    auditRows = [
      { id: 7, event_payload: { x: 'a' }, previous_entry_hash: null },
      { id: 8, event_payload: { x: 'b' }, previous_entry_hash: 'h1' },
      { id: 9, event_payload: { x: 'c' }, previous_entry_hash: 'h2' },
    ];
    await anchorDailyRoot(DAY);
    expect(lastUpsert).toMatchObject({
      first_audit_id: 7,
      last_audit_id: 9,
      entry_count: 3,
    });
  });
});

describe('dateBoundsUtc', () => {
  it('produces inclusive UTC start, exclusive next-day-UTC end, and ISO date', () => {
    const r = _internals.dateBoundsUtc(new Date('2026-04-27T13:30:00Z'));
    expect(r.start).toBe('2026-04-27T00:00:00.000Z');
    expect(r.end).toBe('2026-04-28T00:00:00.000Z');
    expect(r.isoDate).toBe('2026-04-27');
  });

  it('handles month/year rollover', () => {
    const r = _internals.dateBoundsUtc(new Date('2026-12-31T23:59:59Z'));
    expect(r.start).toBe('2026-12-31T00:00:00.000Z');
    expect(r.end).toBe('2027-01-01T00:00:00.000Z');
    expect(r.isoDate).toBe('2026-12-31');
  });
});
