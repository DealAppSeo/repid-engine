/**
 * trustshell-tool-receipt.ts — the ONE server-side path that mints a
 * trustshell_tool_receipt.
 *
 * WHY A WRAPPER, NOT A DIRECT INSERT (CC1, 2026-09-04): the row must be written
 * ONLY via the SECURITY DEFINER RPC `write_tool_receipt()`, never by a direct
 * `.from('trustshell_tool_receipts').insert(...)`. The RPC HMAC-signs the receipt
 * with a key the caller never sees and stamps `minted_by = session_user`, so a
 * receipt cannot be forged or back-dated. A direct insert would bypass the
 * signature and the minter stamp — a receipt nobody can trust, in a product about
 * trust. This wrapper is that single path; grep for the table name should only
 * ever find the RPC behind it.
 *
 * Grants (verified 2026-09-04): EXECUTE on write_tool_receipt is service_role +
 * postgres only. So this must run from a server-side, service_role db client
 * (repid-engine's `../db`), NOT a client-side anon key. A client that wants a
 * receipt must POST to an authed engine endpoint that calls this — it cannot mint
 * one itself. That is the intended, unforgeable posture.
 *
 * Never throws: a receipt-mint failure must not break the request that made the
 * tool call. Returns the receipt id on success, null on failure.
 */
import type { SupabaseClient } from '@supabase/supabase-js';

/** input_hash / output_hash must be exactly 64 lowercase hex chars (the RPC enforces
 *  this too and raises RECEIPT_HASH_FORMAT; we check first to fail quietly and locally). */
const HEX64 = /^[0-9a-f]{64}$/;

export interface ToolReceiptInput {
  vertical: string;            // which vertical's tool (e.g. 'trustshell')
  agentId: string;
  toolName: string;
  inputHash: string;           // sha256 of the tool input, 64 lowercase hex
  outputHash: string;          // sha256 of the tool output, 64 lowercase hex
  toolVersion?: string | null;
  executionTimeMs?: number | null;
}

/** Flag: mint a receipt for every logged tool call. Default off (opt-in like every
 *  writer here). Independent of TOOL_CALL_LOGGING so receipts can accumulate without
 *  the hash-chained tool_call_log, and vice versa. */
export function toolReceiptsEnabled(): boolean {
  return process.env.TRUSTSHELL_TOOL_RECEIPTS === 'true';
}

export async function writeToolReceipt(
  db: SupabaseClient,
  r: ToolReceiptInput,
): Promise<string | null> {
  if (!HEX64.test(r.inputHash) || !HEX64.test(r.outputHash)) {
    console.error('[tool-receipt] refusing to mint: input_hash/output_hash must be 64 lowercase hex');
    return null;
  }
  try {
    const { data, error } = await db.rpc('write_tool_receipt', {
      p_vertical: r.vertical,
      p_agent_id: r.agentId,
      p_tool_name: r.toolName,
      p_input_hash: r.inputHash,
      p_output_hash: r.outputHash,
      p_tool_version: r.toolVersion ?? null,
      p_execution_time_ms: typeof r.executionTimeMs === 'number' ? Math.round(r.executionTimeMs) : null,
    });
    if (error) {
      console.error('[tool-receipt] write_tool_receipt RPC failed:', error.message);
      return null;
    }
    return (data as string) ?? null;
  } catch (e: unknown) {
    console.error('[tool-receipt] write_tool_receipt threw:', e instanceof Error ? e.message : String(e));
    return null;
  }
}
