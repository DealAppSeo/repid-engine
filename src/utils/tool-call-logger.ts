/**
 * S-HARDEN Phase 3 — tool_call_log writer.
 *
 * Records a tool/decision invocation to the hash-chained `tool_call_log` (the BEFORE-INSERT
 * `fn_audit_hash_chain` trigger stamps `previous_entry_hash`). Off by default — set
 * `TOOL_CALL_LOGGING=true` to enable. Never throws: a logging failure must not break a request.
 */
import { createHash } from 'crypto';
import { db } from '../db';

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
}

export function isToolCallLoggingEnabled(): boolean {
  return process.env.TOOL_CALL_LOGGING === 'true';
}

/** Append a row to tool_call_log. No-op unless TOOL_CALL_LOGGING=true. Never throws. */
export async function logToolCall(params: ToolCallLogParams): Promise<void> {
  if (!isToolCallLoggingEnabled()) return;
  try {
    const outputHash = createHash('sha256')
      .update(JSON.stringify(params.toolOutput ?? null))
      .digest('hex');

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
    // Never crash a request over an audit-log write.
    console.error('[tool-call-logger] failed to log:', err instanceof Error ? err.message : err);
  }
}
