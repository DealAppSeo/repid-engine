/**
 * One verify call per fixture id. The client is injected.
 * This module does not open a database or a network connection.
 */
import { verifyFixtureClaim } from './fixture-claim-verify';
import type { PassVoteWriteResult } from './first-pass-vote';

export interface LiveClaim {
  id: string;
  receipt_id: number;
  family: string;
  host: string;
  first_pass_verdict?: unknown;
  first_pass_at?: unknown;
  post_hal_verdict?: unknown;
}

export type LiveStatus = 'inserted' | 'skipped' | 'columns-missing';

type VoteClient = Parameters<typeof verifyFixtureClaim>[0];

export function passWord(value: unknown): 'TRUE' | 'FALSE' | 'NOT_CHECKED' {
  if (value === 'TRUE' || value === 'FALSE') return value;
  return 'NOT_CHECKED';
}

export async function runLivePack(
  claims: readonly LiveClaim[],
  client: VoteClient,
  env: Record<string, string | undefined>,
): Promise<{ lines: string[] }> {
  const enabled = env.HAL_QUORUM_RECEIPT_ENABLED === 'true';
  const lines: string[] = [];
  for (const claim of claims) {
    let result: PassVoteWriteResult | null = null;
    if (enabled) {
      result = await verifyFixtureClaim(
        client,
        {
          receipt_id: claim.receipt_id,
          family: claim.family,
          host: claim.host,
          first_pass_verdict: claim.first_pass_verdict,
          first_pass_at: claim.first_pass_at,
        },
        env,
      );
    }
    const status: LiveStatus = !enabled
      ? 'skipped'
      : result?.written
        ? 'inserted'
        : result?.skippedReason === 'columns-missing'
          ? 'columns-missing'
          : 'skipped';
    lines.push(
      [
        claim.id,
        passWord(claim.first_pass_verdict),
        passWord(claim.post_hal_verdict),
        claim.family,
        claim.host,
        status,
      ].join('\t'),
    );
  }
  return { lines };
}
