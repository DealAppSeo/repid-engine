/**
 * S-HARDEN Phase 3 — tool_call_log writer.
 *
 * Records a tool/decision invocation to the hash-chained `tool_call_log` (the BEFORE-INSERT
 * `fn_audit_hash_chain` trigger stamps `previous_entry_hash`). Off by default — set
 * `TOOL_CALL_LOGGING=true` to enable. Never throws: a logging failure must not break a request.
 */
import { createHash } from 'crypto';
import { db } from '../db';
import { writeToolReceipt, toolReceiptsEnabled } from '../services/trustshell-tool-receipt';

export type AutonomyTier = 'just_do_it' | 'do_then_tell' | 'ask_first';

export interface ToolCallLogParams {
  agentName: string;
  toolName: string;
  toolInput: unknown;
  toolOutput: unknown;
  repidAtCall: number;
  confidenceAtCall: number;
  autonomyTier: AutonomyTier;
  hitlRequired?: boolean;
  hitlDecision?: string | null;
  /** Vertical for the Trust Receipt (default 'trustshell'). */
  vertical?: string;
  /** Tool version recorded on the receipt, when known. */
  toolVersion?: string | null;
}

export function isToolCallLoggingEnabled(): boolean {
  return process.env.TOOL_CALL_LOGGING === 'true';
}

/**
 * Append a row to tool_call_log (TOOL_CALL_LOGGING) and/or mint a signed
 * trustshell_tool_receipt (TRUSTSHELL_TOOL_RECEIPTS). The two are independent
 * flags: the hash-chained audit log and the signed public receipt are different
 * surfaces. No-op unless at least one is enabled. Never throws.
 */
export async function logToolCall(params: ToolCallLogParams): Promise<void> {
  const logEnabled = isToolCallLoggingEnabled();
  const receiptsEnabled = toolReceiptsEnabled();
  if (!logEnabled && !receiptsEnabled) return;

  // Computed once, shared by both writers. output_hash matches what the audit log
  // stores and what the receipt commits to.
  const outputHash = createHash('sha256')
    .update(JSON.stringify(params.toolOutput ?? null))
    .digest('hex');

  if (logEnabled) {
    try {
      const confidence = Number.isFinite(params.confidenceAtCall)
        ? Math.max(0, Math.min(1, params.confidenceAtCall))
        : null;

      const { error } = await db.from('tool_call_log').insert({
        agent_name: params.agentName,
        tool_name: params.toolName,
        tool_input: params.toolInput ?? null,
        tool_output_hash: outputHash,
        repid_at_call: Number.isFinite(params.repidAtCall) ? Math.round(params.repidAtCall) : null,
        confidence_at_call: confidence,
        autonomy_tier: params.autonomyTier,
        hitl_required: params.hitlRequired ?? false,
        hitl_decision: params.hitlDecision ?? null,
      });
      if (error) console.error('[tool-call-logger] insert failed:', error.message);
    } catch (err) {
      console.error('[tool-call-logger] failed to log:', err instanceof Error ? err.message : err);
    }
  }

  // Mint a signed Trust Receipt for this tool call — ONLY via the write_tool_receipt
  // RPC wrapper (CC1: never a direct insert). Best-effort; a mint failure never
  // breaks the request. This is the origin that makes trustshell_tool_receipts (Gate 2)
  // start accumulating when the flag is on.
  if (receiptsEnabled) {
    const inputHash = createHash('sha256')
      .update(JSON.stringify(params.toolInput ?? null))
      .digest('hex');
    await writeToolReceipt(db, {
      vertical: params.vertical ?? 'trustshell',
      agentId: params.agentName,
      toolName: params.toolName,
      inputHash,
      outputHash,
      toolVersion: params.toolVersion ?? null,
    });
  }
}
