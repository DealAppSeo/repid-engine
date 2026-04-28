/**
 * Plonky3 bridge — reponomics trade-authorization proof generator.
 *
 * Wraps the existing src/zkp/plonky3-real.ts HMAC stub to emit a
 * uniform proof shape for linked-bet placement (Phase 7 of the
 * reponomics sprint). When Gemini's parallel sprint
 * (`hyperdag-core/feat/reponomics-circuits-2026-04-27`) ships its
 * TypeScript bridge, the body of generateTradeAuthProof() swaps to
 * the real Plonky3 prover; the function signature stays stable.
 *
 * v0.1 returns `isSimulated: true` on every proof — caller surfaces
 * that flag through to /api/v1/bet/place response and the audit-chain
 * row.
 */

import { generateProofRealSync } from '../zkp/plonky3-real';

export interface TradeAuthProofInput {
  agentId: string;          // UUID
  builderId: string;        // UUID
  tradeAmount: bigint;      // smallest-unit USDC
  timestamp: bigint;        // ms since epoch
  thresholdCombinedScore: number;   // 0 = any positive score allowed
}

export interface TradeAuthProofResult {
  proofBytesHex: string;
  isSimulated: boolean;
  bridgeVersion: string;
}

export function generateTradeAuthProof(input: TradeAuthProofInput): TradeAuthProofResult {
  // Stub path: HMAC over the inputs. Output is base64 from
  // generateProofRealSync; we hex-encode for the
  // linked_bets.plonky3_proof_bytes column.
  const stubBase64 = generateProofRealSync(
    `${input.agentId}|${input.builderId}|${input.tradeAmount.toString()}|${input.thresholdCombinedScore}`,
    'reponomics-trade-auth',
    'v0.1',
    input.timestamp.toString(),
  );
  const proofBytesHex = '0x' + Buffer.from(stubBase64, 'base64').toString('hex');
  return {
    proofBytesHex,
    isSimulated: true,
    bridgeVersion: 'babybear-stub-v1 (reponomics)',
  };
}
