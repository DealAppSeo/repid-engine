/**
 * Mocked verify of one fixture claim.
 * The client is injected. This module does not open a database or a network connection.
 */
import { writePassVote, type PassVoteWriteResult } from './first-pass-vote';

export interface FixtureClaim {
  receipt_id: number;
  family: string;
  host: string;
  first_pass_verdict?: unknown;
  first_pass_at?: unknown;
}

type VoteClient = Parameters<typeof writePassVote>[0];

export async function verifyFixtureClaim(
  client: VoteClient,
  claim: FixtureClaim,
  env: Record<string, string | undefined>,
): Promise<PassVoteWriteResult> {
  return writePassVote(
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
