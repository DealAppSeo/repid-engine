/**
 * erc8004-linkage.ts — the missing join between a RepID proof and an on-chain
 * ERC-8004 identity, made explicit, testable, and HONEST about what it does and
 * does not certify.
 *
 * ════════════════════════════════════════════════════════════════════════════════
 * THE QUESTION THIS ANSWERS
 * ════════════════════════════════════════════════════════════════════════════════
 * A third party holds two things:
 *   (1) a RepID range proof — `repid_zkp_proofs.statement = {agent_id, repid_score,
 *       threshold, tier}`, where `agent_id` is `repid_agents.id` (a UUID), and
 *   (2) an ERC-8004 token id on the IdentityRegistry (Base Sepolia
 *       0x8004A818BFB912233c491871b3d84c89A494BD9e).
 * They want to know: do these refer to the SAME agent, WITHOUT trusting our server?
 *
 * ════════════════════════════════════════════════════════════════════════════════
 * WHAT IS REAL TODAY — the one anchor that is trustless
 * ════════════════════════════════════════════════════════════════════════════════
 * The minter (`src/services/erc8004-minter.ts`) registers each agent with
 *   `agentURI = https://repid.dev/agents/{UUID}/metadata`
 * via `register(string agentURI)`, and the registry exposes `tokenURI(uint256)
 * -> string` as an on-chain view. So the token → UUID direction is readable ON
 * CHAIN with no server call: read `tokenURI(tokenId)`, parse the UUID out of the
 * path, and you have the same `agent_id` the proof statement carries. That match —
 * UUID-from-chain == UUID-in-statement — is the linkage, and it is what
 * `verifyProofLinksToToken` checks.
 *
 * ════════════════════════════════════════════════════════════════════════════════
 * WHAT IS NOT PROVEN — do not read a match as a cryptographic guarantee
 * ════════════════════════════════════════════════════════════════════════════════
 * A positive match here is NECESSARY but not SUFFICIENT for "provably the same
 * identity". Three residual trust assumptions remain, each surfaced in `unproven`:
 *
 *  A. `statement.agent_id` is a PLAINTEXT field. Whether it is a bound PUBLIC INPUT
 *     of the Plonky3 circuit is not decidable from this repo — the real proof is
 *     produced by an external prover (`/prove/trade_auth`, see plonky3-real.ts),
 *     and the 56,823 legacy stub rows bind nothing at all. Until the circuit binds
 *     `agent_id`, a malicious server could attach any UUID to any proof bytes.
 *
 *  B. `tokenURI` is OWNER-MUTABLE: the registry exposes `setAgentURI(uint256,
 *     string)`. A UUID read from it is CURRENT state, not a mint-time immutable.
 *     A verifier that needs mint-time truth must read the `Registered(agentId,
 *     agentURI, owner)` event log at the mint block, not the live getter.
 *
 *  C. A mint may pass a custom `agentURI` (the minter's `override`) that does NOT
 *     embed the UUID. Then the token carries no on-chain UUID and this trustless
 *     path is simply unavailable — `agentIdFromAgentURI` returns null and the
 *     verdict is `linkable=false, reason='uri_carries_no_uuid'`, NOT a false match.
 *
 * ════════════════════════════════════════════════════════════════════════════════
 * THE BINDING THIS MODULE ADDS — close A's server-trust with one commitment
 * ════════════════════════════════════════════════════════════════════════════════
 * The RepID statement today references NO ERC-8004 field, so proof → token always
 * needs the server's DB mapping. `linkageCommitment` is the smallest value that
 * removes that: a Poseidon2 digest binding `{agent_id, erc8004_token_id,
 * erc8004_address}` under a domain tag. Included as a public input in the RepID
 * statement/proof (the minimal circuit change, documented below), a verifier
 * recomputes it from (UUID-from-tokenURI, tokenId, address) and checks equality —
 * one on-chain read, no server. It does not FIX (A): binding the commitment into
 * the proof still requires the circuit to treat it as a public input. It makes the
 * link EXPLICIT and checkable instead of implicit in a DB row, and it is
 * Poseidon2-over-BabyBear so it is aggregation-ready (Invariant 1).
 *
 * ════════════════════════════════════════════════════════════════════════════════
 * INVARIANT COMPLIANCE (ZKP_ARCHITECTURE_INVARIANTS v1)
 * ════════════════════════════════════════════════════════════════════════════════
 * 1. Poseidon2 over BabyBear ONLY (`poseidon2-leaf` / `poseidon2-babybear`). No
 *    sha256, no keccak — pinned by a test that greps this file's source.
 * 3. DOMAIN-PARAMETERIZED — `ERC8004_LINKAGE_DOMAIN` is absorbed, so this circuit
 *    family's commitments do not collide with the repid-delta family's, and a
 *    health-vertical linkage would use its own domain unchanged.
 * 6. Domain string is the circuit-registry namespace key.
 *
 * WRITES NOTHING. No `db`, no chain call, no env read. Pure functions over inputs a
 * caller supplies. The on-chain read (`tokenURI`) is the CALLER's job — this module
 * only says what to do with its result.
 */

import { poseidon2Sponge, fieldsToHex } from './poseidon2-leaf';
import { feltsFromString } from './repid-delta-statement';

/** Registry key for the RepID↔ERC-8004 linkage circuit family (Invariant 6). */
export const ERC8004_LINKAGE_DOMAIN = 'hyperdag/erc8004/repid-linkage/v1';

/** The minter's default metadata base (see erc8004-minter.ts `metadataBaseUrl`). */
export const DEFAULT_AGENT_METADATA_BASE = 'https://repid.dev/agents';

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EVM_ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

/**
 * The minter's agentURI convention, in ONE place so the parse and the build cannot
 * drift. `erc8004-minter.ts` builds `${base}/${agentId}/metadata`; this mirrors it
 * exactly. A test asserts the two stay identical in shape.
 */
export function agentURIForAgentId(
  agentId: string,
  base: string = DEFAULT_AGENT_METADATA_BASE,
): string {
  return `${base.replace(/\/$/, '')}/${agentId}/metadata`;
}

/**
 * Extract the `repid_agents.id` UUID from an on-chain agentURI.
 *
 * Returns the lowercased UUID, or null when the URI does not carry one (a custom
 * override URI, a malformed value, or an entirely different scheme). Null is a
 * FIRST-CLASS result: it means "this token cannot be linked trustlessly by URI",
 * not "no agent" — the caller reports `uri_carries_no_uuid`, never a false match.
 *
 * Accepts the `.../agents/{uuid}/metadata` shape and is tolerant of a trailing
 * slash and of an `ipfs://`/`https://` scheme, but requires the `{uuid}` path
 * segment to be a canonical UUID — a partial or truncated id is rejected, because
 * a loose match here would link the wrong agent.
 */
export function agentIdFromAgentURI(uri: string | null | undefined): string | null {
  if (!uri || typeof uri !== 'string') return null;
  // Split on '/', find an 'agents' segment immediately followed by a UUID.
  const parts = uri.split('/').filter((p) => p.length > 0);
  for (let i = 0; i < parts.length - 1; i++) {
    if (parts[i]!.toLowerCase() === 'agents') {
      const candidate = parts[i + 1]!;
      if (UUID_RE.test(candidate)) return candidate.toLowerCase();
    }
  }
  return null;
}

/**
 * `linkageCommitment = Poseidon2( domain ‖ agent_id ‖ token_id ‖ address )`.
 *
 * The smallest value that binds the RepID identity (`agent_id` UUID) to its
 * ERC-8004 token id AND the address the registry associates with it. `0x`+64 hex.
 *
 * `erc8004Address` is lowercased before absorption so a checksummed and an
 * all-lowercase form of the same address commit identically — an address differs
 * only in case, never in meaning, and a case-sensitive commitment would split one
 * identity into two.
 *
 * Absorbed as length-prefixed UTF-8 byte strings (the same `feltsFromString`
 * convention the statement digest uses), so `agent_id ‖ token_id` cannot alias a
 * different split of the same concatenation.
 */
export function linkageCommitment(params: {
  agentId: string;
  erc8004TokenId: string;
  erc8004Address: string;
  domain?: string;
}): string {
  const domain = params.domain ?? ERC8004_LINKAGE_DOMAIN;
  if (!UUID_RE.test(params.agentId)) {
    throw new Error(
      `[erc8004-linkage] agentId must be a repid_agents.id UUID, got '${params.agentId}'`,
    );
  }
  if (!/^\d+$/.test(params.erc8004TokenId)) {
    throw new Error(
      `[erc8004-linkage] erc8004TokenId must be a uint256 decimal string, got '${params.erc8004TokenId}'`,
    );
  }
  if (!EVM_ADDRESS_RE.test(params.erc8004Address)) {
    throw new Error(
      `[erc8004-linkage] erc8004Address must be 0x+40 hex, got '${params.erc8004Address}'`,
    );
  }
  const felts = [
    ...feltsFromString(domain),
    ...feltsFromString(params.agentId.toLowerCase()),
    ...feltsFromString(params.erc8004TokenId),
    ...feltsFromString(params.erc8004Address.toLowerCase()),
  ];
  return fieldsToHex(poseidon2Sponge(felts));
}

/**
 * What a verifier concludes, and — always — what they still cannot know.
 *
 * `linked` is the trustless-by-URI verdict: the UUID in the proof statement equals
 * the UUID read from the token's on-chain URI. `unproven` is NEVER empty on a
 * positive result; a caller that renders `linked` without rendering `unproven`
 * would be making exactly the overclaim this module exists to prevent.
 */
export interface LinkageVerification {
  /** UUID matches on both legs. NECESSARY, not sufficient — see `unproven`. */
  linked: boolean;
  /** The UUID recovered from the on-chain URI, or null when it carried none. */
  onchain_agent_id: string | null;
  checks: Record<string, boolean>;
  failures: string[];
  /** Residual trust assumptions a UUID match does not remove. Never empty. */
  unproven: string[];
}

/**
 * Verify a RepID proof and an ERC-8004 token refer to the same agent, using only
 * the proof's statement and values a verifier can read on-chain.
 *
 * The caller supplies `onChainAgentURI` — the string returned by `tokenURI(tokenId)`
 * (or, for mint-time truth, the `agentURI` from the `Registered` event). This
 * module does NOT make the RPC call; keeping the chain read in the caller is what
 * lets the same logic run in a browser WASM verifier, a test, or a server, and is
 * why there is no ethers import here.
 *
 * If `expectedLinkageCommitment` and the ERC-8004 address are supplied, the
 * commitment leg is also checked — this is the leg that becomes trustless once the
 * circuit binds `linkageCommitment` as a public input (see module header).
 */
export function verifyProofLinksToToken(params: {
  /** `repid_zkp_proofs.statement.agent_id` — the UUID the proof is bound to. */
  statementAgentId: string;
  /** `tokenURI(tokenId)` read from the registry (or the Registered-event agentURI). */
  onChainAgentURI: string | null;
  erc8004TokenId: string;
  /** Optional: the address the registry associates (ownerOf / getAgentWallet). */
  erc8004Address?: string | null;
  /** Optional: a linkage commitment the proof claims to bind. */
  expectedLinkageCommitment?: string | null;
  domain?: string;
}): LinkageVerification {
  const onchainAgentId = agentIdFromAgentURI(params.onChainAgentURI);
  const stmtId = (params.statementAgentId ?? '').toLowerCase();

  const checks: Record<string, boolean> = {
    statement_agent_id_is_uuid: UUID_RE.test(stmtId),
    uri_carries_uuid: onchainAgentId !== null,
    agent_id_matches_onchain_uri:
      onchainAgentId !== null && onchainAgentId === stmtId,
  };

  // Optional commitment leg — only checked when the caller has both the address and
  // an expected commitment to compare against.
  if (params.expectedLinkageCommitment && params.erc8004Address) {
    let recomputed: string | null = null;
    try {
      recomputed = linkageCommitment({
        agentId: stmtId,
        erc8004TokenId: params.erc8004TokenId,
        erc8004Address: params.erc8004Address,
        ...(params.domain ? { domain: params.domain } : {}),
      });
    } catch {
      recomputed = null;
    }
    checks.linkage_commitment_matches =
      recomputed !== null &&
      recomputed.toLowerCase() === params.expectedLinkageCommitment.toLowerCase();
  }

  const failures = Object.entries(checks)
    .filter(([, ok]) => !ok)
    .map(([k]) => k);

  return {
    linked: failures.length === 0,
    onchain_agent_id: onchainAgentId,
    checks,
    failures,
    unproven: [
      'that statement.agent_id is a bound PUBLIC INPUT of the RepID circuit — the ' +
        'real proof is produced by an external prover and legacy stub rows bind ' +
        'nothing; until the circuit binds it, agent_id is a server-attached label ' +
        '(needs the Plonky3 circuit)',
      'that the on-chain agentURI was not mutated after mint — the registry exposes ' +
        'setAgentURI, so tokenURI is current state; read the Registered event at the ' +
        'mint block for mint-time truth',
      'that the ERC-8004 address discriminates this agent — server-minted tokens are ' +
        'owned by a shared deployer wallet, so ownerOf alone does not identify the ' +
        'agent; getAgentWallet(tokenId) is the per-agent binding when set',
    ],
  };
}
