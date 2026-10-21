/**
 * Arena preflight: the spec §2-§4 checks on the DATA of a payment, run before any effect.
 *
 * WHY THIS EXISTS BESIDE THE KERNEL. The engine's executor is the kernel plus the x402 gate. The
 * kernel's signed owner policy limits the amount, lists the payees, expires and is signature-checked;
 * it deliberately does NOT constrain the asset or the chain (decide.ts says so in `does_not_attest`),
 * and it has never heard of an NPA, a quote, a kill-switch file or a pinned experiment policy. Those
 * checks are therefore made here, in deterministic code, before the request reaches the kernel. This
 * file only REFUSES; it never authorises. An ALLOW always comes from the kernel.
 *
 * WHAT IS DELIBERATELY NOT HERE: the one-use authorization (spec §4: consume sha256(NPA) atomically
 * and durably). Writing it here would hide that the engine has none, and would make L1's gate look
 * green when the executor it gates is not. The arena records the engine's failure instead.
 */
import { existsSync, readFileSync } from 'node:fs';
import type { ChainPort } from './chain';
import { assetKey, npaSigner, policyBodyOf, policyIdOf, sameAddr, type ArenaPolicy, type Hex, type SignedNpa } from './core';

export type RefusalStage = 'policy' | 'operation' | 'npa' | 'request' | 'budget' | 'gate' | 'kernel' | 'feedback';
export interface Refusal {
  stage: RefusalStage;
  code: string;
  detail?: string;
}

/** What a caller asks the executor to do. It is data from an untrusted caller: nothing in it is believed. */
export interface Presentation {
  operation: string;
  npa: SignedNpa;
  request: { chain_id: number; asset: Hex; recipient: Hex; amount_raw: string; payer: Hex };
}

export interface Tally {
  spent: Record<string, bigint>;
  count: number;
}

/** §2: the policy file on disk is the policy. It must hash to the id it claims AND to the id pinned at the start. */
export function loadPolicyFile(path: string, pinnedId: string, nowS: number): { ok: true; policy: ArenaPolicy } | { ok: false; refusal: Refusal } {
  const no = (code: string, detail?: string) => ({ ok: false as const, refusal: { stage: 'policy' as const, code, detail } });
  let p: ArenaPolicy;
  try {
    p = JSON.parse(readFileSync(path, 'utf8')) as ArenaPolicy;
  } catch (e) {
    return no('policy_unreadable', String((e as Error).message).slice(0, 100));
  }
  try {
    const recomputed = policyIdOf(policyBodyOf(p));
    if (recomputed !== p.policy_id) return no('policy_id_mismatch', 'the file does not hash to the id it carries');
    if (recomputed !== pinnedId) return no('policy_pinned_id_mismatch', 'the file is not the policy that was pinned when the run started');
  } catch (e) {
    return no('policy_malformed', String((e as Error).message).slice(0, 100));
  }
  if (p.level !== 0) return no('policy_level_not_l0', 'an L1+ policy needs the owner signature this arena does not check');
  if (nowS < p.not_before) return no('policy_not_yet_valid');
  if (nowS >= p.expires_at) return no('policy_expired');
  if (existsSync(p.kill_switch_path)) return no('kill_switch', 'the kill-switch file exists');
  return { ok: true, policy: p };
}

/** Every failed check, not just the first: the evidence shows what else was wrong with the request. */
export async function preflight(a: {
  policyPath: string;
  pinnedPolicyId: string;
  nowS: number;
  chain: ChainPort;
  pres: Presentation;
  tally: Tally;
}): Promise<{ refusals: Refusal[]; policy: ArenaPolicy | null }> {
  const refusals: Refusal[] = [];
  const add = (stage: RefusalStage, code: string, detail?: string) => refusals.push({ stage, code, detail });

  const loaded = loadPolicyFile(a.policyPath, a.pinnedPolicyId, a.nowS);
  if (!loaded.ok) return { refusals: [loaded.refusal], policy: null };
  const policy = loaded.policy;
  const { npa, buyer_sig, seller_sig } = a.pres.npa;
  const req = a.pres.request;

  if (!policy.operations.includes(a.pres.operation)) add('operation', 'operation_not_allowed', `only ${policy.operations.join(',')} is allowed`);

  // NPA: two valid signatures over exactly this NPA, from two different parties.
  if (!buyer_sig || !seller_sig) add('npa', 'npa_not_signed_by_both');
  const [bs, ss] = await Promise.all([npaSigner(npa, buyer_sig), npaSigner(npa, seller_sig)]);
  if (buyer_sig && (!bs || !sameAddr(bs, npa.buyer))) add('npa', 'buyer_signature_invalid');
  if (seller_sig && (!ss || !sameAddr(ss, npa.seller))) add('npa', 'seller_signature_invalid');
  if (sameAddr(npa.buyer, npa.seller)) add('npa', 'buyer_is_seller');
  if (npa.settlement !== 'onchain-readback') add('npa', 'settlement_mode_not_onchain_readback');

  // NPA against the policy.
  if (!policy.wallets.buyer.some((w) => sameAddr(w, npa.buyer))) add('npa', 'buyer_wallet_not_approved');
  if (!policy.wallets.seller.some((w) => sameAddr(w, npa.seller))) add('npa', 'seller_wallet_not_approved');
  if (!policy.counterparties.some((w) => sameAddr(w, npa.seller))) add('npa', 'counterparty_not_approved');
  if (npa.chain_id !== policy.chain_id) add('npa', 'wrong_chain', `NPA chain ${npa.chain_id}, policy chain ${policy.chain_id}`);
  const entry = policy.assets.find((x) => sameAddr(assetKey(x.contract), npa.asset));
  if (!entry) add('npa', 'asset_not_in_policy');
  else if (entry.decimals !== npa.decimals) add('npa', 'decimals_mismatch');
  const amount = safeBig(npa.amount_raw);
  if (amount === null || amount <= 0n) add('npa', 'amount_invalid');
  if (entry && amount !== null) {
    const cap = safeBig(policy.per_tx_max_raw[entry.symbol] ?? '0') ?? 0n;
    if (amount > cap) add('npa', 'over_per_tx_cap', `${amount} > ${cap} ${entry.symbol}`);
    const aggCap = safeBig(policy.aggregate_max_raw[entry.symbol] ?? '0') ?? 0n;
    if ((a.tally.spent[entry.symbol] ?? 0n) + amount > aggCap) add('budget', 'over_aggregate_cap', `${entry.symbol} cap ${aggCap}`);
  }
  if (a.tally.count >= policy.max_tx_count) add('budget', 'tx_count_exhausted');
  if (a.nowS >= npa.quote_expires_at) add('npa', 'quote_expired');
  const maxFee = safeBig(npa.max_fee_wei);
  if (maxFee === null || maxFee > (safeBig(policy.max_fee_wei) ?? 0n)) add('npa', 'max_fee_above_policy');

  // The request against the NPA: what is asked for must be what was signed.
  if (req.chain_id !== npa.chain_id) add('request', 'request_chain_differs_from_npa');
  if (!sameAddr(req.asset, npa.asset)) add('request', 'token_substitution', 'the request names a different asset than the NPA');
  if (!sameAddr(req.recipient, npa.seller)) add('request', 'recipient_substitution', 'the request pays someone other than the NPA seller');
  if (req.amount_raw !== npa.amount_raw) add('request', 'amount_differs_from_npa');
  if (!sameAddr(req.payer, npa.buyer)) add('request', 'payer_differs_from_npa');

  // The chain the executor is actually talking to, and the asset as that chain describes it (§5).
  const live = await a.chain.chainId();
  if (live !== policy.chain_id) add('policy', 'connected_chain_differs_from_policy', `connected ${live}`);
  if (entry && entry.contract !== 'native') {
    const info = await a.chain.tokenInfo(entry.contract);
    if (!info || info.decimals !== entry.decimals || info.symbol !== entry.symbol) add('npa', 'asset_not_verified_on_chain', 'symbol()/decimals() do not match the registry');
  }
  return { refusals, policy };
}

function safeBig(s: string): bigint | null {
  return /^(0|[1-9][0-9]*)$/.test(s) ? BigInt(s) : null;
}

