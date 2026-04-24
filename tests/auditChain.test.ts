import { createHash } from 'crypto';
import {
  canonicalJson,
  computeEntryHash,
  appendToAuditChain,
  verifyAuditChain,
} from '../src/services/auditChainWriter';
import { db } from '../src/db';

describe('canonicalJson', () => {
  it('sorts object keys', () => {
    expect(canonicalJson({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
  });

  it('is stable for nested objects', () => {
    const a = canonicalJson({ outer: { z: 1, a: 2 }, k: 'v' });
    const b = canonicalJson({ k: 'v', outer: { a: 2, z: 1 } });
    expect(a).toBe(b);
  });

  it('preserves array order', () => {
    expect(canonicalJson([3, 1, 2])).toBe('[3,1,2]');
  });

  it('round-trips through JSON to normalise numbers', () => {
    expect(canonicalJson({ x: 2.0 })).toBe('{"x":2}');
  });

  it('handles null and booleans', () => {
    expect(canonicalJson({ a: null, b: true, c: false })).toBe('{"a":null,"b":true,"c":false}');
  });
});

describe('computeEntryHash', () => {
  it('produces deterministic sha256 hex', () => {
    const h = computeEntryHash(null, '{"k":1}', 'hal_production_events', 'smoke-1');
    const expected = createHash('sha256')
      .update('' + '{"k":1}' + 'hal_production_events' + 'smoke-1')
      .digest('hex');
    expect(h).toBe(expected);
  });

  it('chains previous hash into the next', () => {
    const h1 = computeEntryHash(null, '{"k":1}', 't', 'a');
    const h2 = computeEntryHash(h1, '{"k":2}', 't', 'b');
    const expected = createHash('sha256')
      .update(h1 + '{"k":2}' + 't' + 'b')
      .digest('hex');
    expect(h2).toBe(expected);
    expect(h2).not.toBe(h1);
  });

  it('treats null previous hash as empty string', () => {
    const a = computeEntryHash(null, 'x', 't', 'i');
    const b = computeEntryHash('', 'x', 't', 'i');
    expect(a).toBe(b);
  });
});

// Integration tests — require a reachable Supabase with hal_audit_chain table
// and the append_hal_audit_chain RPC applied. Gated behind an env var to keep
// CI from hammering the live DB and to avoid polluting the production chain.
// To run: RUN_AUDIT_CHAIN_INTEGRATION=1 npx jest tests/auditChain.test.ts
const runIntegration = process.env.RUN_AUDIT_CHAIN_INTEGRATION === '1';
const describeIntegration = runIntegration ? describe : describe.skip;

describeIntegration('hal_audit_chain integration', () => {
  beforeEach(async () => {
    // Clean slate — only safe when chain is empty or contains only test data.
    // If you run this against a chain with real data, expect data loss.
    await db.from('hal_audit_chain').delete().neq('id', -1);
  });

  afterAll(async () => {
    await db.from('hal_audit_chain').delete().neq('id', -1);
  });

  it('empty chain verifies as valid with total 0', async () => {
    const result = await verifyAuditChain();
    expect(result).toEqual({ valid: true, total_entries: 0, last_id: null });
  });

  it('single entry append + verify', async () => {
    const r = await appendToAuditChain('__auditchain_test__', 'a', { n: 1 });
    expect(typeof r.id).toBe('number');
    expect(r.current_entry_hash).toMatch(/^[0-9a-f]{64}$/);

    const result = await verifyAuditChain();
    expect(result.valid).toBe(true);
    if (result.valid) {
      expect(result.total_entries).toBe(1);
      expect(result.last_id).toBe(r.id);
    }
  });

  it('chain of five entries verifies intact', async () => {
    for (let i = 0; i < 5; i++) {
      await appendToAuditChain('__auditchain_test__', `id-${i}`, { seq: i, msg: `entry ${i}` });
    }
    const result = await verifyAuditChain();
    expect(result.valid).toBe(true);
    if (result.valid) {
      expect(result.total_entries).toBe(5);
    }
  });

  it('catches tampered event_payload with correct first_break_at_id', async () => {
    const ids: number[] = [];
    for (let i = 0; i < 5; i++) {
      const r = await appendToAuditChain('__auditchain_test__', `id-${i}`, { seq: i });
      ids.push(r.id);
    }

    // Tamper: modify the third row's event_payload directly in the DB.
    const tamperedId = ids[2]!;
    const { error } = await db
      .from('hal_audit_chain')
      .update({ event_payload: { seq: 999, msg: 'tampered' } })
      .eq('id', tamperedId);
    expect(error).toBeNull();

    const result = await verifyAuditChain();
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.first_break_at_id).toBe(tamperedId);
      expect(result.total_entries).toBe(2); // two entries passed before the break
      expect(result.expected_hash).toMatch(/^[0-9a-f]{64}$/);
      expect(result.actual_hash).toMatch(/^[0-9a-f]{64}$/);
      expect(result.expected_hash).not.toBe(result.actual_hash);
    }
  });
});
