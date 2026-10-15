import { ServiceHandlerBase } from './service-handler-base';
import { runPCP } from './pcp-validator';
import { rpcCall } from '../clients/rpc-with-failover';
import { getActiveNetwork } from '../config/network';
import { BASE_SEPOLIA_CHAIN_ID } from './testnet-only';
import type { ServiceContractRow } from '../types';

type ClaimIs = 'TRUE' | 'FALSE' | 'UNDETERMINED';

/** What a chain-id claim was checked against. Present only when a read was attempted. */
interface VerifiedAgainst {
  method: 'eth_chainId';
  /** Host of the endpoint that answered; never the full URL (a provider URL can carry an API key). */
  rpc_host: string | null;
  returned_chain_id: number | null;
  at: string;
  /** Set only when the read failed. Its presence is why claim_is is UNDETERMINED. */
  error?: string;
}

/** Per-endpoint bound. rpcCall rotates to the next endpoint on timeout, so the worst case is 3 x this. */
const CHAIN_READ_TIMEOUT_MS = 5_000;

// ponytail: one claim shape, read against Base Sepolia only. The content must be exactly
// "[The] Base Sepolia chain id is <n>[.]". Any other phrasing, another chain, or a compound claim
// falls to the validator vote, unchecked. Widen this when a second verifiable claim type is bought.
const BASE_SEPOLIA_CHAIN_ID_CLAIM = /^\s*(?:the\s+)?base sepolia chain id is (\d+)\.?\s*$/i;

/**
 * Read eth_chainId from the configured Base Sepolia RPC and judge the claim against it.
 * Never throws and never guesses: any failure is recorded and the claim is UNDETERMINED.
 * The ceiling it cannot get past: it trusts that the configured RPC is Base Sepolia. A
 * mismatch therefore reads as FALSE, and `rpc_host` is recorded so anyone can re-run it.
 */
async function checkChainIdClaim(claimed: number): Promise<{ claim_is: ClaimIs; verified_against: VerifiedAgainst }> {
  const at = new Date().toISOString();
  const fail = (error: string) => ({
    claim_is: 'UNDETERMINED' as const,
    verified_against: { method: 'eth_chainId' as const, rpc_host: null, returned_chain_id: null, at, error },
  });
  // rpcCall reads the ACTIVE network. If that is not Base Sepolia, the node we would ask is not
  // the chain the claim is about, and its answer would be a false FALSE.
  const net = getActiveNetwork();
  if (net.chainId !== BASE_SEPOLIA_CHAIN_ID) return fail(`active network is ${net.name}, not Base Sepolia`);
  try {
    const { host, id } = await rpcCall(async (p) => {
      let timer: NodeJS.Timeout | undefined;
      try {
        const raw = await Promise.race([
          p.send('eth_chainId', []),
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new Error(`eth_chainId timed out after ${CHAIN_READ_TIMEOUT_MS}ms`)), CHAIN_READ_TIMEOUT_MS);
          }),
        ]);
        // JSON-RPC returns a hex quantity. Anything else is not an answer; throwing rotates endpoints.
        if (typeof raw !== 'string' || !/^0x[0-9a-f]+$/i.test(raw)) throw new Error(`eth_chainId returned ${JSON.stringify(raw)}`);
        return { host: new URL(p._getConnection().url).host, id: Number.parseInt(raw, 16) };
      } finally {
        clearTimeout(timer);
      }
    });
    return {
      claim_is: id === claimed ? 'TRUE' : 'FALSE',
      verified_against: { method: 'eth_chainId', rpc_host: host, returned_chain_id: id, at },
    };
  } catch (e) {
    return fail(e instanceof Error ? e.message : String(e));
  }
}

/**
 * Phase 2.10 — Verification Service Handler (P-001)
 *
 * Wraps the existing PCP validator for arbitrary buyer-supplied payloads.
 * runPCP signature (verified Step 0): runPCP(taskData) where taskData reads
 * {claimed_by, title, description, result}; returns
 * {score:number, confidence:number, validators:string[]}.
 * Service contracts report the verdict honestly (no internal escalation —
 * that is the validation_queue path, not the contract path); a low-confidence
 * result is surfaced so the buyer may dispute.
 */
export class VerificationServiceHandler extends ServiceHandlerBase {
  protected readonly serviceType = 'verification';

  protected async fulfill(contract: ServiceContractRow): Promise<Record<string, unknown>> {
    const payload = contract.payload as {
      content: string;
      criteria?: string[];
      title?: string;
    };

    const syntheticTask = {
      id: -1 as const, // sentinel — not a trinity_tasks row
      claimed_by: contract.buyer_agent_id, // excludes buyer from the validator pool
      title: payload.title ?? 'verification-service-request',
      description: payload.criteria?.join(', ') ?? 'verify content accuracy and coherence',
      result: payload.content,
      tier: 0,
    };

    const pcpResult = await runPCP(syntheticTask);

    // THREE OUTCOMES, NEVER TWO. `confidence >= 0.5 ? 'PASS' : 'FAIL'` collapsed
    // "nobody answered" into "the provider failed". When all three validators erred,
    // confidence was 0, this returned FAIL, and the cascade worker disputed the
    // contract as `provider_at_fault` — charging a provider for work no one assessed.
    // Every daily living-proof run from 2026-08-17 to 2026-08-28 died here.
    //
    // Throwing leaves the contract ESCROWED with an error trail (processOne is
    // try/caught and never rethrows), so the next cycle retries it. That is the
    // correct handling of NOT_CHECKED: not a verdict, not a dispute, just no answer yet.
    if (!pcpResult.checked) {
      throw new Error(
        `verification NOT_CHECKED: 0 of ${pcpResult.attemptedCount} validator(s) answered ` +
        `(${(pcpResult.attemptedValidators ?? []).join(', ')}). Contract stays escrowed for retry; ` +
        `it is not the provider's fault that no validator responded.`
      );
    }

    // WHAT "PASS" MEANS HERE, because it is not "the claim is true". `confidence` is the mean of
    // each validator's confidence IN ITS OWN ASSESSMENT, in either direction; `score` is the
    // confidence-weighted validity. So PASS = "the validators were sure", and a claim they were
    // sure is FALSE also gets PASS. Measured in prod 2026-10-15 (P-001 results dated 05-23..08-01): 18 PASS
    // verdicts carry score < 0.5, among them "The chemical symbol for gold is Pb." at score 0,
    // confidence 1. The verdict is the settlement gate (PASS pays, FAIL disputes), not a truth value.
    const voteVerdict = pcpResult.confidence >= 0.5 ? 'PASS' : 'FAIL';

    // THE CLAIM'S TRUTH, stated, with what it rests on.
    //   Base Sepolia chain-id claim → an eth_chainId read decides it. The vote is still recorded
    //     (score/confidence/validators) but does not decide a fact the chain can answer.
    //       read returned the claimed id → TRUE,  verdict PASS
    //       read returned another id     → FALSE, verdict PASS (a correct "false" is a sound
    //                                       deliverable, the same as the vote path's PASS on a
    //                                       confidently-false claim)
    //       read failed                  → UNDETERMINED, verdict UNDETERMINED. Not PASS: nothing
    //                                       was verified, so the satisfy gate must not pay (it
    //                                       pays only on PASS). Not FAIL: FAIL disputes the
    //                                       provider, and an unreachable RPC is not the
    //                                       provider's fault (the 2026-08 lesson). processOne
    //                                       still files it as delivered (fulfilled + the
    //                                       SERVICE_FULFILLED RepID delta); the buyer's money
    //                                       does not move.
    //   Any other claim → the vote, nothing read: verified_against is null. This is opinion, not a
    //   check: the same prod sample scored the TRUE "The chemical symbol for gold is Au." at 0.
    //       FAIL (validators unsure)     → UNDETERMINED
    //       PASS and score >= 0.5        → TRUE
    //       PASS and score <  0.5        → FALSE
    const chainClaim = BASE_SEPOLIA_CHAIN_ID_CLAIM.exec(String(payload.content ?? ''));
    let verdict: string = voteVerdict;
    let claimIs: ClaimIs = voteVerdict === 'FAIL' ? 'UNDETERMINED' : pcpResult.score >= 0.5 ? 'TRUE' : 'FALSE';
    let verifiedAgainst: VerifiedAgainst | null = null;
    if (chainClaim) {
      const checked = await checkChainIdClaim(Number(chainClaim[1]));
      claimIs = checked.claim_is;
      verifiedAgainst = checked.verified_against;
      verdict = claimIs === 'UNDETERMINED' ? 'UNDETERMINED' : 'PASS';
    }

    return {
      // WHAT WAS VERIFIED. A verdict that does not name its subject cannot be reproduced: "PASS"
      // about what? Without this field the deliverable named validators and a score, never the
      // claim, so the daily living-proof buyer's criterion 2 ("names the chain id it verified
      // against") found nothing to check and every rated run from 2026-09-11 to 2026-10-14 scored
      // 0.5 [V prod]. The claim is the buyer's own payload, stored in the same row; `result` is not
      // published on the public receipt (trust-receipt.ts).
      claim: payload.content,
      claim_is: claimIs,
      verified_against: verifiedAgainst,
      verdict,
      score: pcpResult.score,
      confidence: pcpResult.confidence,
      validators: pcpResult.validators, // string[] of agent names
      validator_count: pcpResult.validators.length,
      attempted_validator_count: pcpResult.attemptedCount,
      contract_id: contract.id,
      verified_at: new Date().toISOString(),
      patent_marker: 'P-001',
    };
  }
}
