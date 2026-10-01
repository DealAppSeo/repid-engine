/**
 * Mocked verify of one fixture claim.
 * The client is injected. This module does not open a database or a network connection.
 */
import { writeV1Receipt, type V1ReceiptResult } from './v1-receipt-writer';

export interface FixtureClaim {
  receipt_id: number;
  family: string;
  host: string;
  first_pass_verdict?: unknown;
  first_pass_at?: unknown;
  post_hal_verdict?: unknown;
}

type ReceiptClient = Parameters<typeof writeV1Receipt>[0];

export interface FixtureFamilyVerdict {
  family: string;
  verdict: 'TRUE' | 'FALSE' | 'NOT_CHECKED';
}

export interface FixtureVerifyResponse extends V1ReceiptResult {
  receipt_id: string;
  families: FixtureFamilyVerdict[];
}

function familyName(value: unknown): string {
  if (typeof value !== 'string') return 'NOT_CHECKED';
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : 'NOT_CHECKED';
}

function passVerdict(value: unknown): FixtureFamilyVerdict['verdict'] {
  if (value === 'TRUE' || value === 'FALSE') return value;
  return 'NOT_CHECKED';
}

function receiptIdOf(value: unknown): string {
  if (typeof value === 'number' && Number.isInteger(value) && value > 0) return String(value);
  if (typeof value === 'string' && value.trim().length > 0 && value.trim() !== '0') return value.trim();
  return 'NOT_CHECKED';
}

export async function verifyFixtureClaim(
  client: ReceiptClient,
  claim: FixtureClaim,
  env: Record<string, string | undefined>,
): Promise<FixtureVerifyResponse> {
  const written = await writeV1Receipt(
    client,
    {
      host: claim.host,
      family: claim.family,
      first_pass_verdict: claim.first_pass_verdict,
      first_pass_at: claim.first_pass_at,
      post_hal_verdict: claim.post_hal_verdict,
    },
    env,
  );
  return {
    ...written,
    receipt_id: receiptIdOf(claim.receipt_id),
    families: [{ family: familyName(claim.family), verdict: passVerdict(claim.first_pass_verdict) }],
  };
}
