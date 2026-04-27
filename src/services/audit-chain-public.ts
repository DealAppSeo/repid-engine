/**
 * Audit chain — public read service.
 *
 * Exposes paginated reads, single-event lookups, range verification,
 * and a stats endpoint over hal_audit_chain. All public-safe; payloads
 * are sanitised per event_type before egress.
 *
 * Sanitization rule (CLAUDE-RULE-4 alignment): the payload returned to
 * the public NEVER contains a private RepID value, an internal SQL
 * string, or holder PII (email, phone). When in doubt the field is
 * dropped. The full payload is still queryable internally via the
 * non-public auditChainWriter or by direct DB access.
 */

import { db } from '../db';
import { canonicalJson, computeEntryHash } from './auditChainWriter';

export interface PublicAuditEntry {
  id: number;
  source_table: string;
  source_id: string;
  event_type: string | null;
  payload: Record<string, unknown>;       // sanitised
  current_entry_hash: string;
  previous_entry_hash: string | null;
  created_at: string;
  chain_position: number;                  // same as id (BIGSERIAL is dense)
}

export interface AuditChainStats {
  total_entries: number;
  latest_event: PublicAuditEntry | null;
  integrity_status: 'valid' | 'broken' | 'unknown';
  first_break_at_id: number | null;
  newest_at: string | null;
  oldest_at: string | null;
}

export interface RangeVerifyResult {
  ok: boolean;
  from_id: number;
  to_id: number;
  rows_checked: number;
  first_break_at_id: number | null;
  expected_hash?: string;
  actual_hash?: string;
  notes: string;
}

interface AuditRow {
  id: number;
  source_table: string;
  source_id: string;
  event_payload: Record<string, unknown>;
  previous_entry_hash: string | null;
  current_entry_hash: string;
  created_at: string;
}

const PUBLIC_PAYLOAD_ALLOWLIST_BY_TYPE: Record<string, string[]> = {
  sbt_mint: ['event_type', 'is_mock', 'token_id', 'tx_hash', 'metadata_inline', 'holder'],
  repid_threshold_proof_generated: ['event_type', 'outcome', 'threshold', 'holder_commitment', 'plonky3_version', 'is_mock'],
  repid_threshold_proof_verified:  ['event_type', 'outcome', 'threshold', 'holder_commitment', 'plonky3_version', 'is_mock'],
  repid_threshold_proof_attempt:   ['event_type', 'outcome', 'threshold', 'plonky3_version', 'is_mock'],
  agent_registration:              ['event_type', 'agent_name', 'token_id', 'mint_tx', 'metadata_inline'],
};

/**
 * Drop fields that aren't on the per-event-type allowlist. Holder
 * addresses are pseudonymous and considered public (Ethereum convention)
 * unless the event_type's allowlist excludes them. Specifically, the
 * threshold-proof events drop `holder` (preserving zero-knowledge
 * intent — the verifier sees only `holder_commitment`).
 */
function sanitisePayload(eventPayload: Record<string, unknown>): { event_type: string | null; payload: Record<string, unknown> } {
  const eventType = typeof eventPayload?.event_type === 'string'
    ? (eventPayload.event_type as string)
    : null;
  const allow = eventType ? PUBLIC_PAYLOAD_ALLOWLIST_BY_TYPE[eventType] : null;
  if (!allow) {
    // Fail-closed: when we don't know how to sanitise, surface only the
    // event_type and an opaque marker. Internal viewers use the direct DB.
    return {
      event_type: eventType,
      payload: { event_type: eventType, _sanitised: true, _note: 'event_type lacks a public allowlist; full payload not surfaced' },
    };
  }
  const out: Record<string, unknown> = {};
  for (const k of allow) {
    if (eventPayload[k] !== undefined) out[k] = eventPayload[k];
  }
  return { event_type: eventType, payload: out };
}

function rowToPublicEntry(row: AuditRow): PublicAuditEntry {
  const { event_type, payload } = sanitisePayload(row.event_payload || {});
  return {
    id: row.id,
    source_table: row.source_table,
    source_id: row.source_id,
    event_type,
    payload,
    current_entry_hash: row.current_entry_hash,
    previous_entry_hash: row.previous_entry_hash,
    created_at: row.created_at,
    chain_position: row.id,
  };
}

// ---------------------------------------------------------------------------
// Public functions
// ---------------------------------------------------------------------------

export async function getRecent(limit: number): Promise<PublicAuditEntry[]> {
  const cap = Math.max(1, Math.min(100, Math.floor(limit)));
  const { data, error } = await db
    .from('hal_audit_chain')
    .select('id, source_table, source_id, event_payload, previous_entry_hash, current_entry_hash, created_at')
    .order('id', { ascending: false })
    .limit(cap);
  if (error) throw new Error(error.message);
  return ((data ?? []) as AuditRow[]).map(rowToPublicEntry);
}

export async function getEvent(id: number): Promise<PublicAuditEntry | null> {
  if (!Number.isFinite(id) || id <= 0) return null;
  const { data, error } = await db
    .from('hal_audit_chain')
    .select('id, source_table, source_id, event_payload, previous_entry_hash, current_entry_hash, created_at')
    .eq('id', id)
    .maybeSingle();
  if (error) throw new Error(error.message);
  return data ? rowToPublicEntry(data as AuditRow) : null;
}

/**
 * Verify hash chain integrity over [from_id, to_id]. The check uses the
 * exact same recipe as auditChainWriter.verifyAuditChain — recomputes
 * each row's hash and compares against stored.
 */
export async function verifyRange(fromId: number, toId: number): Promise<RangeVerifyResult> {
  if (!Number.isFinite(fromId) || fromId < 1) fromId = 1;
  if (!Number.isFinite(toId) || toId < fromId) toId = fromId;

  // Fetch the row immediately preceding fromId to seed prevHash correctly.
  let seedPrevHash: string | null = null;
  if (fromId > 1) {
    const { data } = await db
      .from('hal_audit_chain')
      .select('current_entry_hash')
      .eq('id', fromId - 1)
      .maybeSingle();
    seedPrevHash = data?.current_entry_hash ?? null;
  }

  const { data, error } = await db
    .from('hal_audit_chain')
    .select('id, source_table, source_id, event_payload, previous_entry_hash, current_entry_hash, created_at')
    .gte('id', fromId)
    .lte('id', toId)
    .order('id', { ascending: true });
  if (error) throw new Error(error.message);

  const rows = (data ?? []) as AuditRow[];
  let prev = seedPrevHash;
  let checked = 0;
  for (const r of rows) {
    const text = canonicalJson(r.event_payload);
    const expected = computeEntryHash(prev, text, r.source_table, r.source_id);
    if (expected !== r.current_entry_hash) {
      return {
        ok: false,
        from_id: fromId,
        to_id: toId,
        rows_checked: checked,
        first_break_at_id: r.id,
        expected_hash: expected,
        actual_hash: r.current_entry_hash,
        notes: 'Hash mismatch — chain broken at first_break_at_id.',
      };
    }
    prev = r.current_entry_hash;
    checked += 1;
  }

  return {
    ok: true,
    from_id: fromId,
    to_id: toId,
    rows_checked: checked,
    first_break_at_id: null,
    notes: rows.length === 0 ? 'No rows in range.' : 'All rows in range hash-verify against expected.',
  };
}

export async function getStats(): Promise<AuditChainStats> {
  const { count } = await db
    .from('hal_audit_chain')
    .select('*', { count: 'exact', head: true });
  const total = Number(count ?? 0);

  const { data: latest } = await db
    .from('hal_audit_chain')
    .select('id, source_table, source_id, event_payload, previous_entry_hash, current_entry_hash, created_at')
    .order('id', { ascending: false })
    .limit(1);
  const latestEntry = latest?.[0] ? rowToPublicEntry(latest[0] as AuditRow) : null;

  const { data: oldest } = await db
    .from('hal_audit_chain')
    .select('created_at')
    .order('id', { ascending: true })
    .limit(1);

  // Cheap integrity check: just verify the latest 50 rows. A full chain
  // walk lives behind /api/v1/audit/verify (already in main).
  let integrityStatus: AuditChainStats['integrity_status'] = 'unknown';
  let firstBreak: number | null = null;
  if (total > 0 && latestEntry) {
    const fromId = Math.max(1, latestEntry.id - 49);
    try {
      const r = await verifyRange(fromId, latestEntry.id);
      integrityStatus = r.ok ? 'valid' : 'broken';
      firstBreak = r.first_break_at_id;
    } catch {
      integrityStatus = 'unknown';
    }
  }

  return {
    total_entries: total,
    latest_event: latestEntry,
    integrity_status: integrityStatus,
    first_break_at_id: firstBreak,
    newest_at: latestEntry?.created_at ?? null,
    oldest_at: oldest?.[0]?.created_at ?? null,
  };
}

// Exported for tests.
export const _internals = { sanitisePayload };
