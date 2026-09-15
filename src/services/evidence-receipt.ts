/**
 * F1 — a receipt row is an evidence tuple, not a baked score.
 * composition, HAL number, payment hash, outcome. No current_repid.
 */
export interface EvidenceReceipt {
  composition: string;
  hal: number | null;
  payment_hash: string | null;
  outcome: string;
}

export function buildEvidenceReceipt(input: {
  composition: string;
  hal?: number | null;
  payment_hash?: string | null;
  outcome: string;
  /** Forbidden: callers must not pass a baked score. Ignored if present. */
  score?: unknown;
}): EvidenceReceipt {
  return {
    composition: input.composition,
    hal: input.hal ?? null,
    payment_hash: input.payment_hash ?? null,
    outcome: input.outcome,
  };
}

export const EVIDENCE_RECEIPT_KEYS = ['composition', 'hal', 'payment_hash', 'outcome'] as const;
