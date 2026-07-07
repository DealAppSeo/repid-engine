// ERC-8004 canonical reputation write for the anonymous demo round.
//
// This module is a THIN ADAPTER over the canonical reputation writer in
// `erc8004-reputation.ts`. It exists only to preserve the
// `writeRepIDCanonical('APM'|'VERITAS', repid)` call shape that
// `anonymous-round-runner.ts` depends on.
//
// CONFORMANCE HISTORY (2026-07-06): this file previously
//   (F2) wrote to a NON-canonical reputation registry
//        0xB5048e3ef1DA4E04deB6f7d0423D06F63869e322 (a stray deploy), and
//   (F3) signed giveFeedback with the AGENT'S OWN key (APM_PRIVATE_KEY /
//        VERITAS_PRIVATE_KEY) — i.e. the agent reviewing itself. The ERC-8004
//        spec (ERC8004SPEC.md L217) prohibits self-review: "The feedback
//        submitter MUST NOT be the agent owner or an approved operator for
//        agentId." On a spec-faithful contract that call REVERTS.
//
// Both are fixed by delegating to `getReputationWriter()`, which:
//   - targets the canonical Reputation Registry 0x8004B663…
//     (network-config `reputationRegistry`), and
//   - signs with the DEDICATED attestor wallet
//     (ERC8004_REPUTATION_WRITER_KEY / minter / operator fallback chain),
//     NEVER the reviewed agent's own key.

import { db } from '../db';
import { getReputationWriter } from './erc8004-reputation';

interface CanonicalWriteResult {
  tx_hash?: string;
  basescan_url?: string;
  status: string;
  error?: string;
}

export async function writeRepIDCanonical(
  agentName: 'APM' | 'VERITAS',
  newRepID: number
): Promise<CanonicalWriteResult> {
  try {
    if (process.env.NODE_ENV === 'test') {
      return {
        tx_hash: '0xtest',
        basescan_url: 'https://sepolia.basescan.org/tx/0xtest',
        status: 'skipped_in_test',
      };
    }

    // The dedicated reviewer identity. Returns null when no signing key env
    // var is set (engine boots read-only). Never the agent's own key.
    const writer = getReputationWriter();
    if (!writer) {
      return {
        status: 'failed',
        error:
          'No reputation writer configured (ERC8004_REPUTATION_WRITER_KEY / ERC8004_MINTER_PRIVATE_KEY / ERC8004_OPERATOR_KEY unset)',
      };
    }

    // Look up the agent's ERC-8004 tokenId (agentId on the registry) + tier.
    // tokenId is what the canonical writer feeds giveFeedback(agentId, …).
    const { data: agent, error: dbError } = await db
      .from('repid_agents')
      .select('erc8004_token_id, current_repid, tier')
      .eq('agent_name', agentName)
      .maybeSingle();

    if (dbError || !agent) {
      return { status: 'failed', error: `Agent ${agentName} not found in DB` };
    }
    if (!agent.erc8004_token_id) {
      return {
        status: 'failed',
        error: `Agent ${agentName} has no erc8004_token_id (not minted on Identity Registry)`,
      };
    }

    // Prefer the freshly-computed round score; fall back to the stored score.
    const repid = Number.isFinite(newRepID)
      ? Math.round(newRepID)
      : Number(agent.current_repid ?? 0);

    const result = await writer.writeRepIDFeedback({
      agentTokenId: String(agent.erc8004_token_id),
      repid,
      tier: String(agent.tier ?? ''),
    });

    return {
      tx_hash: result.txHash,
      basescan_url: `https://sepolia.basescan.org/tx/${result.txHash}`,
      status: 'success',
    };
  } catch (err: any) {
    // Classify transient network/timeout errors as retryable, matching the
    // prior contract that anonymous-round-runner surfaces as onchain_status.
    const msg = String(err?.message ?? err);
    if (/timeout/i.test(msg) || /network/i.test(msg) || err?.code === 'NETWORK_ERROR') {
      return { status: 'pending_retry', error: msg };
    }
    return { status: 'failed', error: msg };
  }
}
