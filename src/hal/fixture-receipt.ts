/**
 * One fixture row in hal_quorum_receipts.
 * Writes only when the flag is the exact string true. Unset writes nothing.
 * The row has no claim text. This does not score.
 */
export interface FixtureReceiptResult {
  written: boolean;
  id?: number;
}

type ReceiptInsert = {
  insert: (row: Record<string, unknown>) => {
    select: (columns: string) => {
      single: () => Promise<{ data: { id?: unknown } | null; error: { message: string } | null }>;
    };
  };
};

type ReceiptClient = {
  from: (table: string) => ReceiptInsert;
};

const FIXTURE_ROW = {
  quorum_id: 'fixture-hal-receipt',
  decision: 'NOT_CHECKED',
  scoring_decision: 'pass',
  quorum_met: false,
  families_used: 1,
  providers_used: 1,
};

export async function writeFixtureReceipt(
  client: ReceiptClient,
  env: Record<string, string | undefined>,
): Promise<FixtureReceiptResult> {
  const enabled = env.HAL_QUORUM_RECEIPT_ENABLED === 'true';
  if (!enabled) return { written: false };
  try {
    const { data, error } = await client
      .from('hal_quorum_receipts')
      .insert(FIXTURE_ROW)
      .select('id')
      .single();
    const raw = data?.id;
    const id = typeof raw === 'number' ? raw : typeof raw === 'string' && /^\d+$/.test(raw) ? Number(raw) : NaN;
    if (error || !Number.isInteger(id)) return { written: false };
    return { written: true, id };
  } catch {
    return { written: false };
  }
}
