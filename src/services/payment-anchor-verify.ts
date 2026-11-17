/**
 * payment-anchor-verify.ts — is this payment anchor real, paid, bound to its contract, and new?
 *
 * THE GAP (E2E eval 2026-11-16, §3a and gap 4). An x402 payment anchor was accepted on SHAPE:
 * `linkPaymentProof` checks a 0x-prefixed 32-byte hash and a chain id, and nothing else unless a
 * caller opts into `requireVerified`. The eval passed a made-up hash through the repo's own trust
 * harness and turned an UNCERTAIN outcome into SUCCESS_AUDITED, delta +25. A reputation that can
 * be earned by typing 64 hex characters costs nothing to farm.
 *
 * WHAT THIS CHECKS, in this order, each from something the caller cannot write:
 *   1. shape and chain (Base Sepolia only);
 *   2. the anchor names a contract, and the contract exists in OUR records. The payee, the payer
 *      and the price come from that record, never from the caller: the caller supplies only
 *      a contract id and a tx hash;
 *   3. when the contract already has a recorded settlement tx, the anchor is that tx;
 *   4. the tx has not anchored anything before (the replay table);
 *   5. on chain: a canonical-USDC `Transfer` to the payee of at least the contract price,
 *      from the recorded payer when one is recorded, net of anything the payee sent back
 *      in the same tx. An EIP-3009 `AuthorizationUsed` beside it marks it as an x402 settlement;
 *   6. the tx is then bound to this contract, so it cannot anchor a second one.
 *
 * THREE ANSWERS, NOT TWO. VERIFIED, REFUSED (we looked, and the answer is no), or NOT_CHECKED
 * (we could not look). An RPC that fails, times out or refuses is NOT_CHECKED: never a pass, and
 * never a refusal, because reporting an outage as a bad payment turns an infrastructure problem
 * into an accusation. NOT_CHECKED still does not earn: an unverified anchor is a claim.
 *
 * The RPC error TEXT never reaches an answer. ethers v6 puts the request URL, key and all, in the
 * message of a server error; `x402-settlement-verifier.ts` withholds it, and this module only ever
 * reports fixed codes.
 *
 * MODE (`PAYMENT_ANCHOR_VERIFY_MODE`):
 *   unset / 'off'  nothing is read, nothing is logged, nothing changes. The default.
 *   'shadow'       check every anchor, log what would be refused, record the binding. Changes
 *                  no delta and no score.
 *   'enforce'      REFUSED IN THIS BUILD. Behaves exactly as 'shadow' and says so loudly.
 *                  Turning it on strips a non-VERIFIED anchor before scoring, which moves money-
 *                  backed reputation: that is Sean's call, in its own MAJOR PR (CLAUDE_RULES r31).
 *   anything else  a typo: said loudly, behaves as 'shadow' (records, moves nothing).
 *
 * This module does no I/O of its own. The chain read is `verifySettlement`; the contract terms and
 * the replay table come in as dependencies (`payment-anchor-db.ts` holds the Supabase versions), so
 * every property here is tested offline.
 */
import { DEFAULT_CHAIN_ID } from './x402-outcome-link';
import { verifySettlement, type VerifySettlementResult } from './x402-settlement-verifier';

/** Canonical Base Sepolia USDC. Pinned here, not read from env or from the caller. */
export const ANCHOR_USDC = '0x036CbD53842c5426634e7929541eC2318f3dCF7e';

/** How long one chain read may take before the answer is NOT_CHECKED. */
export const DEFAULT_ANCHOR_RPC_TIMEOUT_MS = 10_000;

export type PaymentAnchorVerifyMode = 'off' | 'shadow' | 'enforce';

export interface PaymentAnchorModeReading {
  /** What the environment asked for. 'invalid' = an unrecognised value. */
  requested: PaymentAnchorVerifyMode | 'invalid';
  /** What actually runs. Never 'enforce' in this build. */
  effective: 'off' | 'shadow';
  /** Set when the requested mode was not honoured, and why. */
  note?: string;
}

/**
 * Read `PAYMENT_ANCHOR_VERIFY_MODE`. 'enforce' and typos both run as 'shadow' and log once per
 * process, so a misconfiguration is visible without flooding the log on every anchor.
 */
const warned = new Set<string>();
export function paymentAnchorVerifyMode(
  raw: string | undefined = process.env.PAYMENT_ANCHOR_VERIFY_MODE,
): PaymentAnchorModeReading {
  const v = (raw ?? '').trim().toLowerCase();
  if (v === '' || v === 'off') return { requested: 'off', effective: 'off' };
  if (v === 'shadow') return { requested: 'shadow', effective: 'shadow' };
  const reading: PaymentAnchorModeReading =
    v === 'enforce'
      ? {
          requested: 'enforce',
          effective: 'shadow',
          note: 'enforce is refused in this build (Sean decides, in its own PR); running as shadow: checks and records, moves nothing',
        }
      : {
          requested: 'invalid',
          effective: 'shadow',
          note: `PAYMENT_ANCHOR_VERIFY_MODE=${JSON.stringify(raw)} is not off|shadow|enforce; running as shadow: checks and records, moves nothing`,
        };
  if (!warned.has(v)) {
    warned.add(v);
    console.error(`[payment-anchor] ${reading.note}`);
  }
  return reading;
}

/** What our own records say this contract's payment must look like. */
export interface AnchorTerms {
  contractId: string;
  /** The provider's wallet: who must have RECEIVED the money. Null when we do not know it. */
  payeeAddress: string | null;
  /** The agreed price, in USDC's smallest unit (6 decimals). */
  claimedUnits: bigint;
  /** Who paid, when a settlement for this contract was recorded. Null otherwise. */
  payerAddress: string | null;
  /** The settlement tx recorded for this contract, when there is one. */
  recordedTxHash: string | null;
}

export interface AnchorBindingRow {
  chain_id: number;
  /** Lowercase. */
  tx_hash: string;
  contract_id: string;
  payee_address: string;
  payer_address: string | null;
  amount_units: string;
  settlement_kind: AnchorSettlementKind;
  verified_at: string;
}

/** One tx anchors at most one contract, once. Backed by `payment_anchor_claims` in production. */
export interface AnchorReplayStore {
  find(chainId: number, txHash: string): Promise<{ contract_id: string } | null>;
  /** 'duplicate' when the tx is already bound (a unique violation): the race was lost. */
  bind(row: AnchorBindingRow): Promise<'ok' | 'duplicate'>;
}

export interface AnchorDeps {
  loadTerms(contractId: string): Promise<AnchorTerms | null>;
  replay: AnchorReplayStore;
  timeoutMs?: number;
  minConfirmations?: number;
  now?: () => Date;
}

export interface AnchorClaim {
  txHash: string;
  chainId: number;
  /** The contract this payment is said to settle. Required: an unbound anchor is refused. */
  contractId: string | null | undefined;
}

export type AnchorVerdict = 'VERIFIED' | 'REFUSED' | 'NOT_CHECKED';
export type AnchorSettlementKind = 'eip3009' | 'transfer';

export type AnchorReason =
  | 'verified'
  // REFUSED: we looked, and the answer is no.
  | 'malformed_tx_hash'
  | 'wrong_chain'
  | 'contract_unbound'
  | 'contract_unknown'
  | 'no_claimed_value'
  | 'contract_tx_mismatch'
  | 'replay_same_contract'
  | 'replay_other_contract'
  | 'tx_not_found'
  | 'tx_reverted'
  | 'wrong_token'
  | 'transfer_elsewhere'
  | 'no_transfer_to_payee'
  | 'below_claimed_value'
  | 'payer_mismatch'
  | 'self_payment'
  | 'refunded_in_tx'
  // NOT_CHECKED: we could not look.
  | 'terms_unreadable'
  | 'payee_unknown'
  | 'rpc_unreachable'
  | 'rpc_timeout'
  | 'insufficient_confirmations'
  | 'replay_store_unreachable';

export interface AnchorCheck {
  verdict: AnchorVerdict;
  reason: AnchorReason;
  contract_id: string | null;
  tx_hash: string;
  chain_id: number;
  /** Set once the chain was read and the transfer was found. */
  settlement_kind?: AnchorSettlementKind;
  /** Units the payee netted from the payer in this tx, as a decimal string. */
  net_units?: string;
  /** For a replay: the contract the tx is already bound to. */
  bound_contract_id?: string;
  /** True when the chain alone would have verified it (the replay store was not reachable). */
  chain_verified?: boolean;
}

const HEX32 = /^0x[0-9a-fA-F]{64}$/;
const ADDR = /^0x[0-9a-fA-F]{40}$/;

function lc(s: string | null | undefined): string {
  return (s ?? '').trim().toLowerCase();
}

class AnchorTimeout extends Error {}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const t = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new AnchorTimeout()), ms);
  });
  return Promise.race([p, t]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

/** Map the settlement verifier's fixed code to this module's answer. Unknown codes do not pass. */
function fromSettlement(r: VerifySettlementResult): { verdict: AnchorVerdict; reason: AnchorReason } {
  switch (r.code) {
    case 'verified':
      return { verdict: 'VERIFIED', reason: 'verified' };
    case 'tx_not_found':
    case 'tx_reverted':
    case 'wrong_token':
    case 'transfer_elsewhere':
    case 'no_transfer_to_payee':
    case 'below_claimed_value':
    case 'malformed_tx_hash':
      return { verdict: 'REFUSED', reason: r.code };
    case 'insufficient_confirmations':
      // Too early is not wrong: ask again later.
      return { verdict: 'NOT_CHECKED', reason: 'insufficient_confirmations' };
    case 'no_payee':
      return { verdict: 'NOT_CHECKED', reason: 'payee_unknown' };
    default:
      // rpc_unreachable, unsupported_chain, token_not_configured, and any code added later.
      return { verdict: 'NOT_CHECKED', reason: 'rpc_unreachable' };
  }
}

/**
 * Verify one payment anchor. Never throws: every failure is an answer.
 */
export async function verifyPaymentAnchor(claim: AnchorClaim, deps: AnchorDeps): Promise<AnchorCheck> {
  const txHash = lc(claim.txHash);
  const contractId = typeof claim.contractId === 'string' && claim.contractId.trim() ? claim.contractId.trim() : null;
  const base = { contract_id: contractId, tx_hash: txHash, chain_id: claim.chainId };
  const refuse = (reason: AnchorReason, extra: Partial<AnchorCheck> = {}): AnchorCheck => ({
    verdict: 'REFUSED',
    reason,
    ...base,
    ...extra,
  });
  const notChecked = (reason: AnchorReason, extra: Partial<AnchorCheck> = {}): AnchorCheck => ({
    verdict: 'NOT_CHECKED',
    reason,
    ...base,
    ...extra,
  });

  // 1. Shape and chain.
  if (!HEX32.test(txHash)) return refuse('malformed_tx_hash');
  if (claim.chainId !== DEFAULT_CHAIN_ID) return refuse('wrong_chain');

  // 2. The anchor must name a contract we know. Its terms come from our records, not the caller.
  if (!contractId) return refuse('contract_unbound');
  let terms: AnchorTerms | null;
  try {
    terms = await deps.loadTerms(contractId);
  } catch {
    return notChecked('terms_unreadable');
  }
  if (!terms) return refuse('contract_unknown');
  if (typeof terms.claimedUnits !== 'bigint' || terms.claimedUnits <= 0n) return refuse('no_claimed_value');
  const payee = lc(terms.payeeAddress);
  if (!ADDR.test(payee)) return notChecked('payee_unknown');
  const payer = ADDR.test(lc(terms.payerAddress)) ? lc(terms.payerAddress) : null;

  // 3. A contract with a recorded settlement is bound to THAT tx.
  const recorded = lc(terms.recordedTxHash);
  if (HEX32.test(recorded) && recorded !== txHash) return refuse('contract_tx_mismatch');

  // 4. Replay, from our own table. Checked before the chain so a known replay is refused even
  //    while the RPC is down. A store we cannot read does not stop the chain check: the chain's
  //    answer is still worth recording, but the anchor cannot be VERIFIED without it.
  let replayStoreDown = false;
  try {
    const prior = await deps.replay.find(claim.chainId, txHash);
    if (prior) {
      return refuse(prior.contract_id === contractId ? 'replay_same_contract' : 'replay_other_contract', {
        bound_contract_id: prior.contract_id,
      });
    }
  } catch {
    replayStoreDown = true;
  }

  // 5. The chain. Canonical USDC only, at least the contract price, to the payee.
  let settlement: VerifySettlementResult;
  try {
    settlement = await withTimeout(
      verifySettlement({
        txHash,
        payeeAddress: payee,
        claimedValueUsdc: 0,
        claimedUnits: terms.claimedUnits,
        tokenAddress: ANCHOR_USDC,
        chainId: claim.chainId,
        ...(deps.minConfirmations !== undefined ? { minConfirmations: deps.minConfirmations } : {}),
      }),
      deps.timeoutMs ?? DEFAULT_ANCHOR_RPC_TIMEOUT_MS,
    );
  } catch (e) {
    return notChecked(e instanceof AnchorTimeout ? 'rpc_timeout' : 'rpc_unreachable');
  }
  const chain = fromSettlement(settlement);
  if (chain.verdict !== 'VERIFIED') {
    return chain.verdict === 'REFUSED' ? refuse(chain.reason) : notChecked(chain.reason);
  }

  // The total reached the payee. Now WHO paid, and whether it stayed there.
  const a = settlement.analysis;
  if (!a) return notChecked('rpc_unreachable'); // a verified result always carries its analysis
  if (a.inflowBySender[payee] !== undefined) return refuse('self_payment');
  const credited = payer
    ? a.inflowBySender[payer] ?? 0n
    : Object.values(a.inflowBySender).reduce((s, v) => s + v, 0n);
  if (payer && credited === 0n) return refuse('payer_mismatch');
  const net = credited - a.outflowFromPayee;
  if (net < terms.claimedUnits) {
    return refuse(a.outflowFromPayee > 0n ? 'refunded_in_tx' : 'below_claimed_value', { net_units: net.toString() });
  }
  const senders = payer ? [payer] : Object.keys(a.inflowBySender);
  const kind: AnchorSettlementKind = a.authorizationUsedBy.some((x) => senders.includes(x)) ? 'eip3009' : 'transfer';
  const paid = { settlement_kind: kind, net_units: net.toString() };

  // 6. Bind the tx to this contract. The unique key is the authority; the pre-check above only
  //    saves an RPC call. Losing the race is a replay.
  if (replayStoreDown) return notChecked('replay_store_unreachable', { ...paid, chain_verified: true });
  let bound: 'ok' | 'duplicate';
  try {
    bound = await deps.replay.bind({
      chain_id: claim.chainId,
      tx_hash: txHash,
      contract_id: contractId,
      payee_address: payee,
      payer_address: payer,
      amount_units: net.toString(),
      settlement_kind: kind,
      verified_at: (deps.now?.() ?? new Date()).toISOString(),
    });
  } catch {
    return notChecked('replay_store_unreachable', { ...paid, chain_verified: true });
  }
  if (bound === 'duplicate') {
    let other: string | undefined;
    try {
      other = (await deps.replay.find(claim.chainId, txHash))?.contract_id;
    } catch {
      other = undefined;
    }
    return refuse(other === contractId ? 'replay_same_contract' : 'replay_other_contract', {
      ...paid,
      ...(other ? { bound_contract_id: other } : {}),
    });
  }

  return { verdict: 'VERIFIED', reason: 'verified', ...base, ...paid };
}

export interface ShadowAnchorResult extends AnchorCheck {
  mode: PaymentAnchorModeReading;
  /** Under enforce, this anchor would be stripped before scoring. */
  would_refuse: boolean;
}

/**
 * The flag-gated entry point. 'off' returns null WITHOUT reading anything. Otherwise the anchor is
 * checked and the answer logged; the caller records it and changes nothing else.
 */
export async function shadowCheckPaymentAnchor(
  claim: AnchorClaim,
  deps: AnchorDeps,
  mode: PaymentAnchorModeReading = paymentAnchorVerifyMode(),
): Promise<ShadowAnchorResult | null> {
  if (mode.effective === 'off') return null;
  const check = await verifyPaymentAnchor(claim, deps);
  const wouldRefuse = check.verdict !== 'VERIFIED';
  if (check.verdict === 'REFUSED') {
    console.warn(
      `[payment-anchor] shadow: would REFUSE anchor reason=${check.reason} contract=${check.contract_id ?? 'none'} tx=${check.tx_hash}`,
    );
  } else if (check.verdict === 'NOT_CHECKED') {
    console.warn(
      `[payment-anchor] shadow: NOT_CHECKED reason=${check.reason} contract=${check.contract_id ?? 'none'} tx=${check.tx_hash} (would not earn under enforce)`,
    );
  }
  return { ...check, mode, would_refuse: wouldRefuse };
}
