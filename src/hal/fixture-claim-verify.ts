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

export async function verifyFixtureClaim(
  client: ReceiptClient,
  claim: FixtureClaim,
  env: Record<string, string | undefined>,
): Promise<V1ReceiptResult> {
  return writeV1Receipt(
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
}
