/**
 * Thin emit-audit-event wrapper.
 *
 * The auditChainWriter.appendToAuditChain signature is
 * (sourceTable, sourceId, payload). Reponomics services prefer a
 * shorter `emitAuditEvent({event_type, source_table, source_id,
 * payload})` interface — sourceTable defaults to 'reponomics_events',
 * sourceId is generated from event_type + timestamp when not supplied.
 *
 * Every emission is best-effort: a DB hiccup at the audit-chain layer
 * never breaks the calling service. Errors are logged and swallowed.
 */

import { appendToAuditChain } from './auditChainWriter';

export interface EmitAuditEventInput {
  event_type: string;
  source_table?: string;
  source_id?: string;
  payload: Record<string, unknown>;
}

export interface EmitAuditEventResult {
  ok: boolean;
  audit_chain_id: number | null;
  error?: string;
}

export async function emitAuditEvent(input: EmitAuditEventInput): Promise<EmitAuditEventResult> {
  const sourceTable = input.source_table ?? 'reponomics_events';
  const sourceId = input.source_id ?? `${input.event_type}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const payload = { event_type: input.event_type, ...input.payload };
  try {
    const r = await appendToAuditChain(sourceTable, sourceId, payload);
    return { ok: true, audit_chain_id: r.id };
  } catch (e: any) {
    console.warn('[audit-emit] append failed:', e?.message ?? String(e));
    return { ok: false, audit_chain_id: null, error: e?.message ?? 'unknown' };
  }
}
