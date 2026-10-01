/**
 * One parent row and one vote row.
 * HAL and the fixture path both call this.
 * The flag must be the exact string true. The rows have no claim text.
 */
import { probePassVoteColumns, writePassVote, type PassVoteWriteResult } from './first-pass-vote';
import { sealReceiptInsert } from './receipt-payload';

export interface V1ReceiptInput {
  host: string;
  first_pass_verdict: unknown;
  first_pass_at: unknown;
  post_hal_verdict?: unknown;
  /** HAL sends this. The fixture does too when it has one. */
  family?: string;
  /** Surface verdict when the first pass is not TRUE or FALSE. */
  verdict?: unknown;
}

export interface V1ReceiptResult {
  written: boolean;
  reason?: 'columns-missing' | 'receipt-missing' | 'insert-error';
  skippedReason?: PassVoteWriteResult['skippedReason'];
}

type ParentInsert = {
  insert: (row: Record<string, unknown>) => {
    select: (columns: string) => {
      single: () => Promise<{ data: { id?: unknown } | null; error: { message?: string } | null }>;
    };
  };
};

type ReceiptClient = {
  from: (table: string) => ParentInsert;
};

function closed(value: unknown): 'TRUE' | 'FALSE' | null {
  if (value === 'TRUE' || value === 'FALSE') return value;
  return null;
}

function stamp(value: unknown): string | null {
  if (typeof value === 'string' && value.length > 0) return value;
  return null;
}

export async function writeV1Receipt(
  client: ReceiptClient,
  input: V1ReceiptInput,
  env: Record<string, string | undefined>,
): Promise<V1ReceiptResult> {
  const enabled = env.HAL_QUORUM_RECEIPT_ENABLED === 'true';
  if (!enabled) return { written: false };
  const votes = client as unknown as Parameters<typeof writePassVote>[0];
  if ((await probePassVoteColumns(votes)) === 'columns-missing') {
    return { written: false, reason: 'columns-missing' };
  }
  const first = closed(input.first_pass_verdict);
  const at = stamp(input.first_pass_at);
  const post = closed(input.post_hal_verdict);
  if (post && !(first && at)) return { written: false };
  const surface = input.verdict === 'UNCERTAIN' ? 'UNCERTAIN' : input.verdict === 'NOT_CHECKED' ? 'NOT_CHECKED' : null;
  const decision = first ?? surface ?? 'NOT_CHECKED';
  const parent = await insertParent(client, decision);
  if (!parent.ok) return { written: false, reason: 'receipt-missing' };
  const family = input.family && input.family.length > 0 ? input.family : 'receipt';
  const pass = await writePassVote(
    votes,
    {
      receipt_id: parent.id,
      family,
      host: input.host,
      verdict: decision,
      ...(first && at ? { first_pass_verdict: first, first_pass_at: at } : {}),
      ...(post ? { post_hal_verdict: post, post_hal_at: at } : {}),
    },
    env,
  );
  if (!pass.written) {
    return {
      written: false,
      reason: pass.skippedReason === 'columns-missing' ? 'columns-missing' : 'insert-error',
      skippedReason: pass.skippedReason,
    };
  }
  return { written: true };
}

async function insertParent(
  client: ReceiptClient,
  decision: string,
): Promise<{ ok: true; id: number } | { ok: false }> {
  try {
    const row = sealReceiptInsert({
      quorum_id: `hal-receipt-${Date.now()}`,
      decision,
      scoring_decision: decision === 'FALSE' ? 'veto' : 'pass',
      quorum_met: false,
      families_used: 1,
      providers_used: 1,
    });
    const { data, error } = await client.from('hal_quorum_receipts').insert(row).select('id').single();
    const raw = data?.id;
    const id = typeof raw === 'number' ? raw : typeof raw === 'string' && /^\d+$/.test(raw) ? Number(raw) : NaN;
    if (error || !Number.isInteger(id)) return { ok: false };
    return { ok: true, id };
  } catch {
    return { ok: false };
  }
}
