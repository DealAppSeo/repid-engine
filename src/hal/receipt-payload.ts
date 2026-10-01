/**
 * Receipt and vote rows are host, verdict, and timestamps.
 * claim, prompt, and user_id are refused before insert.
 */
const FORBIDDEN_RECEIPT_KEYS = ['claim', 'prompt', 'user_id'] as const;

export function sealReceiptInsert<T extends object>(row: T): T {
  if (Array.isArray(row)) {
    for (const item of row) {
      if (item !== null && typeof item === 'object') sealReceiptInsert(item);
    }
    return row;
  }
  for (const key of FORBIDDEN_RECEIPT_KEYS) {
    if (Object.prototype.hasOwnProperty.call(row, key)) {
      throw new Error('rejected-receipt-key');
    }
  }
  return row;
}
