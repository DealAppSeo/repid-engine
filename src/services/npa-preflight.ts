/**
 * npa-preflight.ts: the data checks of AUTONOMY_LOOPS_SPEC §2-§4 on one payment presentation, run before any
 * effect. PURE: no file, no network, no chain, no clock, no environment, no randomness. Everything it needs
 * (the parsed policy file, the pinned policy id, "now", whether the kill-switch file exists, what the connected
 * chain and the asset contract answered, the budget already spent) is handed in by the caller, which does the I/O.
 *
 * WHY IT LIVES IN src/ AND NOT IN A HARNESS SCRIPT. The L1 executor is "preflight -> x402 gate -> kernel". The
 * kernel's signed owner policy limits the amount, lists the payees, expires and is signature-checked; it
 * deliberately does NOT constrain the asset or the chain (decide.ts says so in `does_not_attest`) and has no notion
 * of an NPA, a quote, a pinned experiment policy or a kill-switch file. On the fixed kernel the kernel alone still
 * pays five of the sixteen attack cases (token substitution, wrong chain, expired quote, a one-signature NPA, a
 * request after the kill switch appears). Those refusals are part of the executor, so they live where tsc and CI
 * cover them, with unit tests (tests/npa-preflight.test.ts).
 *
 * THIS MODULE ONLY REFUSES. It never authorises: an ALLOW always comes from the kernel. Every refusal is
 * collected, not just the first, so the evidence shows what else was wrong with a request. A presentation that is
 * not even well-formed is refused with `presentation_malformed` / `npa_malformed` and never throws.
 *
 * NOT HERE, ON PURPOSE: the one-use authorization (consume sha256(NPA) once, atomically and durably). That belongs
 * to the kernel's gate; writing it here would make a check that only this caller runs.
 */
import { createHash } from 'node:crypto';
import { verifyTypedData } from 'ethers';

export type Hex = `0x${string}`;
export const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000' as Hex;

export const sha256Hex = (s: string | Uint8Array): string => createHash('sha256').update(s).digest('hex');

/**
 * RFC 8785 (JCS) canonical JSON of JSON data: keys sorted by UTF-16 code unit, no whitespace, strings and numbers
 * serialised as ECMAScript does (which is what RFC 8785 §3.2 specifies). bigint, NaN, Infinity and functions
 * throw: a policy or NPA that needs one has not been written in decimal strings.
 */
export function jcs(v: unknown): string {
  if (v === null) return 'null';
  switch (typeof v) {
    case 'boolean':
      return v ? 'true' : 'false';
    case 'string':
      return JSON.stringify(v);
    case 'number':
      if (!Number.isFinite(v)) throw new Error('jcs: non-finite number');
      return JSON.stringify(v);
    case 'object': {
      if (Array.isArray(v)) return `[${v.map(jcs).join(',')}]`;
      const o = v as Record<string, unknown>;
      return `{${Object.keys(o)
        .filter((k) => o[k] !== undefined)
        .sort()
        .map((k) => `${JSON.stringify(k)}:${jcs(o[k])}`)
        .join(',')}}`;
    }
    default:
      throw new Error(`jcs: unsupported ${typeof v}`);
  }
}

// ── §2 experiment policy ─────────────────────────────────────────────────────────────────────────

export interface AssetEntry {
  symbol: string;
  /** 'native' or the ERC-20 contract. A token is only trusted after it is verified on its own chain. */
  contract: Hex | 'native';
  decimals: number;
}

export interface ExperimentPolicyBody {
  level: 0;
  chain_id: number;
  assets: AssetEntry[];
  wallets: { buyer: Hex[]; seller: Hex[] };
  counterparties: Hex[];
  operations: string[];
  /** Raw integer amounts as canonical decimal strings, keyed by asset symbol. */
  per_tx_max_raw: Record<string, string>;
  aggregate_max_raw: Record<string, string>;
  max_tx_count: number;
  max_fee_wei: string;
  /** Unix seconds. */
  not_before: number;
  expires_at: number;
  kill_switch_path: string;
  /** sha256 of the oracle file that grades the run. */
  evaluator_sha256: string;
}

export interface ExperimentPolicy extends ExperimentPolicyBody {
  policy_id: string;
}

/** id = sha256 of the RFC 8785 bytes of the policy without its own id. */
export const policyIdOf = (body: ExperimentPolicyBody): string => sha256Hex(jcs(body));

export function stampPolicy(body: ExperimentPolicyBody): ExperimentPolicy {
  return { policy_id: policyIdOf(body), ...body };
}

export function policyBodyOf(p: ExperimentPolicy): ExperimentPolicyBody {
  const { policy_id: _id, ...body } = p;
  return body;
}

export const assetKey = (a: Hex | 'native'): Hex => (a === 'native' ? ZERO_ADDRESS : a);
export const sameAddr = (a: unknown, b: unknown): boolean => typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase();

export const findAsset = (policy: ExperimentPolicy, asset: unknown): AssetEntry | undefined => policy.assets.find((x) => sameAddr(assetKey(x.contract), asset));

// ── shapes ───────────────────────────────────────────────────────────────────────────────────────

export type PreflightStage = 'policy' | 'operation' | 'npa' | 'request' | 'budget' | 'presentation';

export interface PreflightRefusal {
  stage: PreflightStage;
  code: string;
  detail?: string;
}

const ADDR = /^0x[0-9a-fA-F]{40}$/;
const BYTES32 = /^0x[0-9a-fA-F]{64}$/;
const UINT = /^(0|[1-9][0-9]*)$/;
const UINT256_MAX = 2n ** 256n - 1n;
const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
const isAddr = (v: unknown): v is Hex => typeof v === 'string' && ADDR.test(v);
const isSafeInt = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v);
/** A canonical non-negative decimal string that fits a uint256. */
const uintStr = (v: unknown): v is string => typeof v === 'string' && v.length <= 78 && UINT.test(v) && BigInt(v) <= UINT256_MAX;
const big = (v: string): bigint | null => (uintStr(v) ? BigInt(v) : null);

/** Why a parsed policy file is not a policy, or null. Names a field, never echoes a value. */
function policyShapeProblem(p: Record<string, unknown>): string | null {
  if (!isSafeInt(p['chain_id']) || (p['chain_id'] as number) <= 0) return 'chain_id';
  const assets = p['assets'];
  if (!Array.isArray(assets) || assets.length === 0 || assets.length > 16) return 'assets';
  const seen = new Set<string>();
  for (const a of assets) {
    if (!isObj(a) || typeof a['symbol'] !== 'string' || !/^[A-Z0-9]{1,12}$/.test(a['symbol'])) return 'assets.symbol';
    if (a['contract'] !== 'native' && !isAddr(a['contract'])) return 'assets.contract';
    if (!isSafeInt(a['decimals']) || (a['decimals'] as number) < 0 || (a['decimals'] as number) > 36) return 'assets.decimals';
    const k = `${a['symbol']}|${String(a['contract']).toLowerCase()}`;
    if (seen.has(a['symbol'] as string) || seen.has(k)) return 'assets.duplicate';
    seen.add(a['symbol'] as string);
    seen.add(k);
  }
  const w = p['wallets'];
  if (!isObj(w) || !Array.isArray(w['buyer']) || !w['buyer'].every(isAddr) || !Array.isArray(w['seller']) || !w['seller'].every(isAddr)) return 'wallets';
  if (!Array.isArray(p['counterparties']) || !p['counterparties'].every(isAddr)) return 'counterparties';
  if (!Array.isArray(p['operations']) || !p['operations'].every((o) => typeof o === 'string' && o.length > 0 && o.length <= 32)) return 'operations';
  for (const k of ['per_tx_max_raw', 'aggregate_max_raw']) {
    const m = p[k];
    if (!isObj(m) || !Object.values(m).every(uintStr)) return k;
  }
  if (!isSafeInt(p['max_tx_count']) || (p['max_tx_count'] as number) < 0) return 'max_tx_count';
  if (!uintStr(p['max_fee_wei'])) return 'max_fee_wei';
  if (!isSafeInt(p['not_before']) || !isSafeInt(p['expires_at'])) return 'not_before/expires_at';
  if (typeof p['kill_switch_path'] !== 'string' || p['kill_switch_path'].length === 0) return 'kill_switch_path';
  if (typeof p['evaluator_sha256'] !== 'string' || !/^[0-9a-f]{64}$/.test(p['evaluator_sha256'])) return 'evaluator_sha256';
  return null;
}

/**
 * §2: the policy file on disk IS the policy. It must hash to the id it carries AND to the id pinned when the run
 * started (so a file edited and re-stamped with its own new id is still refused), be well-formed, be level 0, be
 * inside its validity window, and no kill-switch file may exist. The caller reads the file and looks for the file.
 */
export function checkPolicy(raw: unknown, pinnedId: string, nowS: number, killSwitchPresent: boolean): { ok: true; policy: ExperimentPolicy } | { ok: false; refusal: PreflightRefusal } {
  const no = (code: string, detail?: string) => ({ ok: false as const, refusal: { stage: 'policy' as const, code, detail } });
  if (!isObj(raw)) return no('policy_malformed', 'the policy is not an object');
  try {
    if (typeof raw['policy_id'] !== 'string') return no('policy_malformed', 'policy_id');
    const { policy_id, ...body } = raw;
    const recomputed = sha256Hex(jcs(body));
    if (recomputed !== policy_id) return no('policy_id_mismatch', 'the file does not hash to the id it carries');
    if (recomputed !== pinnedId) return no('policy_pinned_id_mismatch', 'the file is not the policy that was pinned when the run started');
  } catch (e) {
    return no('policy_malformed', String((e as Error).message).slice(0, 100));
  }
  const bad = policyShapeProblem(raw);
  if (bad) return no('policy_malformed', `field ${bad}`);
  const p = raw as unknown as ExperimentPolicy;
  if ((p.level as unknown) !== 0) return no('policy_level_not_l0', 'an L1+ policy needs the owner signature this check does not verify');
  if (nowS < p.not_before) return no('policy_not_yet_valid');
  if (nowS >= p.expires_at) return no('policy_expired');
  if (killSwitchPresent) return no('kill_switch', 'the kill-switch file exists');
  return { ok: true, policy: p };
}

// ── §3 NPA (EIP-712, two signatures) ─────────────────────────────────────────────────────────────

export interface Npa {
  buyer: Hex;
  seller: Hex;
  /** sha256 of the canonical work statement + acceptance criteria. */
  service_hash: Hex;
  chain_id: number;
  /** ERC-20 contract, or the zero address for the native asset. */
  asset: Hex;
  decimals: number;
  amount_raw: string;
  quote_source: string;
  /** Unix seconds. */
  quote_expires_at: number;
  max_fee_wei: string;
  settlement: 'onchain-readback';
  nonce: Hex;
}

export interface SignedNpa {
  npa: Npa;
  buyer_sig: Hex | null;
  seller_sig: Hex | null;
}

/** What a caller asks the executor to do. Untrusted: nothing in it is believed. */
export interface Presentation {
  operation: string;
  npa: SignedNpa;
  request: { chain_id: number; asset: Hex; recipient: Hex; amount_raw: string; payer: Hex };
}

export const NPA_TYPES: Record<string, Array<{ name: string; type: string }>> = {
  NegotiatedPaymentAgreement: [
    { name: 'buyer', type: 'address' },
    { name: 'seller', type: 'address' },
    { name: 'serviceHash', type: 'bytes32' },
    { name: 'chainId', type: 'uint256' },
    { name: 'asset', type: 'address' },
    { name: 'decimals', type: 'uint8' },
    { name: 'amountRaw', type: 'uint256' },
    { name: 'quoteSource', type: 'string' },
    { name: 'quoteExpiresAt', type: 'uint64' },
    { name: 'maxFeeWei', type: 'uint256' },
    { name: 'settlement', type: 'string' },
    { name: 'nonce', type: 'bytes32' },
  ],
};

/** The domain follows the NPA's own chain id, so an NPA signed for another chain verifies as that chain's. */
export const npaDomain = (n: Npa) => ({ name: 'HyperDAG Negotiated Payment Agreement', version: '1', chainId: BigInt(n.chain_id) });

export function npaMessage(n: Npa) {
  return {
    buyer: n.buyer,
    seller: n.seller,
    serviceHash: n.service_hash,
    chainId: BigInt(n.chain_id),
    asset: n.asset,
    decimals: n.decimals,
    amountRaw: BigInt(n.amount_raw),
    quoteSource: n.quote_source,
    quoteExpiresAt: BigInt(n.quote_expires_at),
    maxFeeWei: BigInt(n.max_fee_wei),
    settlement: n.settlement,
    nonce: n.nonce,
  };
}

/** The authorization identity (spec §4): sha256 of the canonical NPA. Two signatures do not enter it. */
export const npaHashOf = (n: Npa): string => sha256Hex(jcs(n));

/** The same hash, or null for an object that has no canonical form (a refused presentation can carry anything). */
export function npaHashOrNull(n: unknown): string | null {
  try {
    return sha256Hex(jcs(n));
  } catch {
    return null;
  }
}

export const serviceHashOf = (workStatement: string, criteria: string[]): Hex => `0x${sha256Hex(jcs({ work_statement: workStatement, acceptance_criteria: criteria }))}`;

/** The signer of one signature, or null when it is not a valid signature over exactly this NPA. Never throws. */
export function recoverNpaSigner(n: Npa, sig: unknown): string | null {
  if (typeof sig !== 'string') return null;
  try {
    return verifyTypedData(npaDomain(n), NPA_TYPES, npaMessage(n), sig);
  } catch {
    return null;
  }
}

/** Why an object is not an NPA, or null. Names a field, never echoes a value. */
export function npaShapeProblem(n: unknown): string | null {
  if (!isObj(n)) return 'npa';
  if (!isAddr(n['buyer'])) return 'buyer';
  if (!isAddr(n['seller'])) return 'seller';
  if (typeof n['service_hash'] !== 'string' || !BYTES32.test(n['service_hash'])) return 'service_hash';
  if (!isSafeInt(n['chain_id']) || (n['chain_id'] as number) <= 0) return 'chain_id';
  if (!isAddr(n['asset'])) return 'asset';
  if (!isSafeInt(n['decimals']) || (n['decimals'] as number) < 0 || (n['decimals'] as number) > 255) return 'decimals';
  if (!uintStr(n['amount_raw'])) return 'amount_raw';
  if (typeof n['quote_source'] !== 'string' || n['quote_source'].length > 128) return 'quote_source';
  if (!isSafeInt(n['quote_expires_at']) || (n['quote_expires_at'] as number) < 0) return 'quote_expires_at';
  if (!uintStr(n['max_fee_wei'])) return 'max_fee_wei';
  if (typeof n['settlement'] !== 'string' || n['settlement'].length > 64) return 'settlement';
  if (typeof n['nonce'] !== 'string' || !BYTES32.test(n['nonce'])) return 'nonce';
  return null;
}

function presentationShapeProblem(p: unknown): string | null {
  if (!isObj(p)) return 'presentation';
  if (typeof p['operation'] !== 'string') return 'operation';
  const s = p['npa'];
  if (!isObj(s)) return 'npa';
  for (const k of ['buyer_sig', 'seller_sig']) if (s[k] !== null && typeof s[k] !== 'string') return k;
  const r = p['request'];
  if (!isObj(r)) return 'request';
  if (!isSafeInt(r['chain_id'])) return 'request.chain_id';
  for (const k of ['asset', 'recipient', 'amount_raw', 'payer']) if (typeof r[k] !== 'string') return `request.${k}`;
  return null;
}

// ── §4 the checks ────────────────────────────────────────────────────────────────────────────────

export interface Tally {
  spent: Record<string, bigint>;
  count: number;
}

export interface PreflightInput {
  /** A policy that passed `checkPolicy`. */
  policy: ExperimentPolicy;
  /** UNTRUSTED. */
  pres: unknown;
  now_s: number;
  /** What the executor has already settled in this run (the aggregate and count budget). */
  tally: Tally;
  /** The chain id the executor is actually connected to. */
  connected_chain_id: number;
  /** symbol() / decimals() as the asset's own contract answered, or null (not an ERC-20, or unreadable). Read for a token entry only. */
  token_info: { symbol: string; decimals: number } | null;
}

/**
 * Every failed check, in the order of the spec, not just the first. An empty array means "nothing here refuses
 * this": it is NOT an authorisation.
 */
export function evaluateNpa(i: PreflightInput): PreflightRefusal[] {
  const out: PreflightRefusal[] = [];
  const add = (stage: PreflightStage, code: string, detail?: string) => out.push({ stage, code, detail });

  const bad = presentationShapeProblem(i.pres);
  if (bad) return [{ stage: 'presentation', code: 'presentation_malformed', detail: `field ${bad}` }];
  const pres = i.pres as Presentation;
  const npaBad = npaShapeProblem(pres.npa.npa);
  if (npaBad) return [{ stage: 'presentation', code: 'npa_malformed', detail: `field ${npaBad}` }];
  const { npa, buyer_sig, seller_sig } = pres.npa;
  const req = pres.request;
  const policy = i.policy;

  if (!policy.operations.includes(pres.operation)) add('operation', 'operation_not_allowed', `only ${policy.operations.join(',')} is allowed`);

  // two valid signatures over exactly this NPA, from two different parties
  if (!buyer_sig || !seller_sig) add('npa', 'npa_not_signed_by_both');
  if (buyer_sig) {
    const s = recoverNpaSigner(npa, buyer_sig);
    if (!s || !sameAddr(s, npa.buyer)) add('npa', 'buyer_signature_invalid');
  }
  if (seller_sig) {
    const s = recoverNpaSigner(npa, seller_sig);
    if (!s || !sameAddr(s, npa.seller)) add('npa', 'seller_signature_invalid');
  }
  if (sameAddr(npa.buyer, npa.seller)) add('npa', 'buyer_is_seller');
  if (npa.settlement !== 'onchain-readback') add('npa', 'settlement_mode_not_onchain_readback');

  // the NPA against the policy
  if (!policy.wallets.buyer.some((w) => sameAddr(w, npa.buyer))) add('npa', 'buyer_wallet_not_approved');
  if (!policy.wallets.seller.some((w) => sameAddr(w, npa.seller))) add('npa', 'seller_wallet_not_approved');
  if (!policy.counterparties.some((w) => sameAddr(w, npa.seller))) add('npa', 'counterparty_not_approved');
  if (npa.chain_id !== policy.chain_id) add('npa', 'wrong_chain', `NPA chain ${npa.chain_id}, policy chain ${policy.chain_id}`);
  const entry = findAsset(policy, npa.asset);
  if (!entry) add('npa', 'asset_not_in_policy');
  else if (entry.decimals !== npa.decimals) add('npa', 'decimals_mismatch');
  const amount = big(npa.amount_raw);
  if (amount === null || amount <= 0n) add('npa', 'amount_invalid');
  if (entry && amount !== null) {
    const cap = big(policy.per_tx_max_raw[entry.symbol] ?? '0') ?? 0n;
    if (amount > cap) add('npa', 'over_per_tx_cap', `${amount} > ${cap} ${entry.symbol}`);
    const aggCap = big(policy.aggregate_max_raw[entry.symbol] ?? '0') ?? 0n;
    if ((i.tally.spent[entry.symbol] ?? 0n) + amount > aggCap) add('budget', 'over_aggregate_cap', `${entry.symbol} cap ${aggCap}`);
  }
  if (i.tally.count >= policy.max_tx_count) add('budget', 'tx_count_exhausted');
  if (i.now_s >= npa.quote_expires_at) add('npa', 'quote_expired');
  const maxFee = big(npa.max_fee_wei);
  if (maxFee === null || maxFee > (big(policy.max_fee_wei) ?? 0n)) add('npa', 'max_fee_above_policy');

  // the request against the NPA: what is asked for must be what was signed
  if (req.chain_id !== npa.chain_id) add('request', 'request_chain_differs_from_npa');
  if (!sameAddr(req.asset, npa.asset)) add('request', 'token_substitution', 'the request names a different asset than the NPA');
  if (!sameAddr(req.recipient, npa.seller)) add('request', 'recipient_substitution', 'the request pays someone other than the NPA seller');
  if (req.amount_raw !== npa.amount_raw) add('request', 'amount_differs_from_npa');
  if (!sameAddr(req.payer, npa.buyer)) add('request', 'payer_differs_from_npa');

  // the chain the executor is actually talking to, and the asset as that chain describes it (spec §5)
  if (i.connected_chain_id !== policy.chain_id) add('policy', 'connected_chain_differs_from_policy', `connected ${i.connected_chain_id}`);
  if (entry && entry.contract !== 'native') {
    if (!i.token_info || i.token_info.decimals !== entry.decimals || i.token_info.symbol !== entry.symbol) add('npa', 'asset_not_verified_on_chain', 'symbol()/decimals() do not match the registry');
  }
  return out;
}
