/**
 * Public verify body for one receipt.
 * The receipt id and each family's verdict are the whole body.
 * A claim key is not copied. A missing verdict is NOT_CHECKED, never 0.
 */

export interface FamilyVerdict {
  family: string;
  verdict: 'TRUE' | 'FALSE' | 'NOT_CHECKED';
}

export interface VerifyReceiptBody {
  receipt_id: string;
  families: FamilyVerdict[];
}

function nameOf(value: unknown): string {
  if (typeof value !== 'string') return 'NOT_CHECKED';
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : 'NOT_CHECKED';
}

function verdictOf(value: unknown): FamilyVerdict['verdict'] {
  if (value === 'TRUE' || value === 'FALSE') return value;
  return 'NOT_CHECKED';
}

function receiptIdOf(value: unknown): string {
  if (typeof value === 'string' && value.trim().length > 0) return value.trim();
  if (typeof value === 'number' && Number.isInteger(value) && value > 0) return String(value);
  return 'NOT_CHECKED';
}

export function verifyReceiptResponse(input: unknown): VerifyReceiptBody {
  const record =
    input !== null && typeof input === 'object' && !Array.isArray(input)
      ? (input as Record<string, unknown>)
      : {};
  const rawVotes = record['votes'] ?? record['families'];
  const votes = Array.isArray(rawVotes) ? rawVotes : [];
  const families: FamilyVerdict[] = [];
  for (const vote of votes) {
    if (vote === null || typeof vote !== 'object' || Array.isArray(vote)) {
      families.push({ family: 'NOT_CHECKED', verdict: 'NOT_CHECKED' });
      continue;
    }
    const row = vote as Record<string, unknown>;
    families.push({
      family: nameOf(row['family']),
      verdict: verdictOf(row['verdict']),
    });
  }
  return {
    receipt_id: receiptIdOf(record['receipt_id']),
    families,
  };
}
