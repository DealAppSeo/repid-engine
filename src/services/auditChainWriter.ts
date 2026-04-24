import { createHash } from 'crypto';
import { db } from '../db';

export type CanonicalValue =
  | string
  | number
  | boolean
  | null
  | CanonicalValue[]
  | { [k: string]: CanonicalValue };

// Recursively sorts object keys and JSON-stringifies with no whitespace.
// Deterministic for all JSON-representable values. Numbers are normalised
// through JSON round-trip (matches what JSONB round-trip produces at verify
// time), so a payload written once and re-read via SELECT yields the same
// canonical text.
export function canonicalJson(value: unknown): string {
  const normalised = JSON.parse(JSON.stringify(value));
  return stableStringify(normalised);
}

function stableStringify(value: CanonicalValue): string {
  if (value === null) return 'null';
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number') return JSON.stringify(value);
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (Array.isArray(value)) {
    return '[' + value.map(stableStringify).join(',') + ']';
  }
  const keys = Object.keys(value).sort();
  const parts = keys.map(k => JSON.stringify(k) + ':' + stableStringify(value[k] as CanonicalValue));
  return '{' + parts.join(',') + '}';
}

export function computeEntryHash(
  previousEntryHash: string | null,
  canonicalJsonText: string,
  sourceTable: string,
  sourceId: string,
): string {
  const prev = previousEntryHash ?? '';
  return createHash('sha256')
    .update(prev + canonicalJsonText + sourceTable + sourceId)
    .digest('hex');
}

export interface AppendResult {
  id: number;
  current_entry_hash: string;
}

// Appends a new entry to hal_audit_chain. The underlying append_hal_audit_chain
// RPC acquires a transaction-scoped advisory lock before reading the tail, so
// concurrent callers serialize and always observe the true last hash.
export async function appendToAuditChain(
  sourceTable: string,
  sourceId: string,
  eventPayload: Record<string, unknown>,
): Promise<AppendResult> {
  const canonicalText = canonicalJson(eventPayload);

  const { data, error } = await db.rpc('append_hal_audit_chain', {
    p_source_table: sourceTable,
    p_source_id: sourceId,
    p_event_payload: eventPayload,
    p_canonical_json_text: canonicalText,
  });

  if (error) {
    throw new Error(`[auditChain] append failed: ${error.message}`);
  }

  const row = Array.isArray(data) ? data[0] : data;
  if (!row || typeof row.id !== 'number' || typeof row.current_entry_hash !== 'string') {
    throw new Error('[auditChain] RPC returned unexpected shape');
  }

  return { id: row.id, current_entry_hash: row.current_entry_hash };
}

export interface VerifyResultValid {
  valid: true;
  total_entries: number;
  last_id: number | null;
}

export interface VerifyResultBroken {
  valid: false;
  total_entries: number;
  first_break_at_id: number;
  expected_hash: string;
  actual_hash: string;
}

export type VerifyResult = VerifyResultValid | VerifyResultBroken;

interface AuditRow {
  id: number;
  source_table: string;
  source_id: string;
  event_payload: Record<string, unknown>;
  previous_entry_hash: string | null;
  current_entry_hash: string;
}

// Walks hal_audit_chain in id order and recomputes the hash of every row.
// Returns on the first mismatch, or success with the tail id when clean.
export async function verifyAuditChain(): Promise<VerifyResult> {
  const pageSize = 1000;
  let offset = 0;
  let prevHash: string | null = null;
  let total = 0;
  let lastId: number | null = null;

  while (true) {
    const { data, error } = await db
      .from('hal_audit_chain')
      .select('id, source_table, source_id, event_payload, previous_entry_hash, current_entry_hash')
      .order('id', { ascending: true })
      .range(offset, offset + pageSize - 1);

    if (error) {
      throw new Error(`[auditChain] verify read failed: ${error.message}`);
    }

    const rows = (data ?? []) as AuditRow[];
    if (rows.length === 0) break;

    for (const row of rows) {
      const canonicalText = canonicalJson(row.event_payload);
      const expected = computeEntryHash(prevHash, canonicalText, row.source_table, row.source_id);
      if (expected !== row.current_entry_hash) {
        return {
          valid: false,
          total_entries: total,
          first_break_at_id: row.id,
          expected_hash: expected,
          actual_hash: row.current_entry_hash,
        };
      }
      prevHash = row.current_entry_hash;
      lastId = row.id;
      total += 1;
    }

    if (rows.length < pageSize) break;
    offset += pageSize;
  }

  return { valid: true, total_entries: total, last_id: lastId };
}
