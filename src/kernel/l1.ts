/**
 * kernel/l1.ts — the L1 (Base Sepolia, test value) owner policy: build it, review it, check it. PURE except
 * `l1LedgerPathProblem`, which only inspects a path string.
 *
 * WHAT THE OWNER SIGNS. ONE EIP-712 message: the kernel's signed owner policy, v2 ("HyperDAG Kernel Owner
 * Policy", version 2, chain 84532). The kernel policy cannot name an asset, a chain, a transaction count, a
 * fee cap or a kill-switch file (decide.ts says so in `does_not_attest`); the experiment policy
 * (AUTONOMY_LOOPS_SPEC §2, RFC 8785, id = sha256) carries those. The v2 field `authorizedImplHashes` holds
 * exactly one entry, `l1.experiment.sha256:<experiment policy id>`, so the one signature covers both
 * documents: change any field of either and the signature no longer matches what the executor checks.
 *
 * WHY NOT THE CAPABILITY REGISTRY (residual 1 of XC1's L1 re-grade). The registry runs a boot-registered
 * function that takes no arguments, so a payment whose amount and recipient differ per call has no way in;
 * building that channel would be a new mechanism. L1 needs none: the executor sets `class: 'spend'` itself
 * (never from model output) AND this policy lists exactly `actions: ["spend"]`. A call filed as read or other
 * needs `tool`, a post needs `post`, so any other class is DENIED by `action_permitted` before any effect,
 * and the residual (RT-6: a payment filed as `read` under a policy that also lists `tool`) cannot be reached.
 * With the registry OFF the kernel does not read the binding; this module does (`checkL1Policy`). If the
 * registry is ever wired, the same binding names the one implementation that may run.
 *
 * THE REVIEW SHEET IS RENDERED FROM THE PAYLOAD BYTES. `renderReviewSheet` takes the exact
 * eth_signTypedData_v4 string and the experiment policy file, derives every value it prints from them,
 * and refuses to render when they disagree with each other or with the L1 ceilings. The signing page shows
 * the sha256 of the same string, so "what I reviewed" and "what I signed" are the same bytes.
 */
import { createHash } from 'node:crypto';
import { isAbsolute, relative, resolve } from 'node:path';
import { TypedDataEncoder, formatUnits, getAddress, isAddress } from 'ethers';
import { evaluateNpa, jcs, sha256Hex, type ExperimentPolicy, type PreflightRefusal, type Tally } from '../services/npa-preflight';
import { POLICY_DOMAIN_V2, POLICY_TYPES_V2, parsePolicy, policyHash, policyTypedValueV2 } from './policy';
import type { LedgerRecord, OwnerPolicy, SignedOwnerPolicy } from './types';

// ── the L1 ceilings (AUTONOMY_LOOPS_SPEC §8). A policy above any of them is refused, never trimmed. ─────────

export const L1_CHAIN_ID = 84532;
/** Circle's test USDC on Base Sepolia. Read on its own chain 2026-10-21: symbol() "USDC", decimals() 6. */
export const BASE_SEPOLIA_USDC = '0x036CbD53842c5426634e7929541eC2318f3dCF7e';
export const L1_CEILINGS = {
  per_tx_usdc_raw: 1_000_000n, // 1 USDC
  daily_usdc_raw: 10_000_000n, // 10 USDC per rolling 24 h
  total_usdc_raw: 20_000_000n, // 20 USDC over the policy's life (the most a wallet is funded with)
  tx_per_day: 20,
  max_fee_wei: 100_000_000_000_000n, // 0.0001 ETH of gas per payment
  max_lifetime_s: 7 * 86_400,
} as const;
export const L1_DAY_S = 86_400;
const BINDING_PREFIX = 'l1.experiment.sha256:';

export const l1BindingId = (experimentPolicyId: string): string => `${BINDING_PREFIX}${experimentPolicyId}`;

/** The experiment policy, L1 edition: the §2 body with `level: 1`. */
export type L1ExperimentPolicy = Omit<ExperimentPolicy, 'level'> & { level: 1 };

export interface L1Config {
  /** The kernel subject: an agent id that exists nowhere else (a fresh one per arming). */
  subject: string;
  /** The wallet that signs. The executor pins it independently (L1_OWNER_ADDRESS). */
  owner: string;
  buyer: string;
  seller: string;
  per_tx_raw: string;
  daily_raw: string;
  total_raw: string;
  tx_per_day: number;
  max_fee_wei: string;
  not_before: number;
  expires_at: number;
  kill_switch_path: string;
  evaluator_sha256: string;
  nonce: string;
  /** Default: BASE_SEPOLIA_USDC. The dry run passes its devnet token. */
  usdc?: string;
}

export interface L1Artifacts {
  experiment: L1ExperimentPolicy;
  policy: OwnerPolicy;
  /** The exact string handed to eth_signTypedData_v4. Sign THESE bytes. */
  payload: string;
  payload_sha256: string;
  /** The EIP-712 digest: what the signature is over; equals the kernel's policyHash. */
  digest: string;
}

const big = (s: string): bigint => BigInt(s);
const UINT = /^(0|[1-9][0-9]*)$/;

/** Every way a config breaks the L1 ceilings or the shape, by name. Empty = within the spec. */
export function l1ConfigProblems(c: L1Config): string[] {
  const out: string[] = [];
  for (const k of ['owner', 'buyer', 'seller'] as const) if (!isAddress(c[k])) out.push(`${k} is not an address`);
  if (out.length) return out;
  const [o, b, s] = [c.owner, c.buyer, c.seller].map((a) => a.toLowerCase());
  if (b === s) out.push('buyer and seller must be two different wallets');
  if (o === b || o === s) out.push('the owner must not be one of the two disposable wallets');
  if (c.usdc !== undefined && !isAddress(c.usdc)) out.push('usdc is not an address');
  for (const k of ['per_tx_raw', 'daily_raw', 'total_raw', 'max_fee_wei', 'nonce'] as const) if (!UINT.test(c[k])) out.push(`${k} is not a decimal integer`);
  if (out.length) return out;
  if (big(c.per_tx_raw) === 0n || big(c.per_tx_raw) > L1_CEILINGS.per_tx_usdc_raw) out.push('per_tx_raw must be 1..1000000 (at most 1 USDC)');
  if (big(c.daily_raw) < big(c.per_tx_raw) || big(c.daily_raw) > L1_CEILINGS.daily_usdc_raw) out.push('daily_raw must be per_tx_raw..10000000 (at most 10 USDC a day)');
  if (big(c.total_raw) < big(c.daily_raw) || big(c.total_raw) > L1_CEILINGS.total_usdc_raw) out.push('total_raw must be daily_raw..20000000 (at most 20 USDC in all)');
  if (!Number.isSafeInteger(c.tx_per_day) || c.tx_per_day < 1 || c.tx_per_day > L1_CEILINGS.tx_per_day) out.push('tx_per_day must be 1..20');
  if (big(c.max_fee_wei) > L1_CEILINGS.max_fee_wei) out.push('max_fee_wei must be at most 100000000000000 (0.0001 ETH)');
  if (big(c.nonce) === 0n) out.push('nonce must be at least 1');
  if (!Number.isSafeInteger(c.not_before) || !Number.isSafeInteger(c.expires_at) || c.expires_at <= c.not_before) out.push('expires_at must be after not_before');
  else if (c.expires_at - c.not_before > L1_CEILINGS.max_lifetime_s) out.push('the policy may live at most 7 days');
  if (!isAbsolute(c.kill_switch_path)) out.push('kill_switch_path must be an absolute path');
  if (!/^[0-9a-f]{64}$/.test(c.evaluator_sha256)) out.push('evaluator_sha256 must be 64 lowercase hex characters');
  if (typeof c.subject !== 'string' || !/^[A-Za-z0-9._:-]{8,128}$/.test(c.subject)) out.push('subject must be 8..128 characters of letters, digits and . _ : -');
  return out;
}

/** The eth_signTypedData_v4 payload for a v2 kernel policy. */
export function l1TypedData(policy: OwnerPolicy): Record<string, unknown> {
  return {
    types: {
      EIP712Domain: [
        { name: 'name', type: 'string' },
        { name: 'version', type: 'string' },
        { name: 'chainId', type: 'uint256' },
      ],
      OwnerPolicy: POLICY_TYPES_V2['OwnerPolicy'],
    },
    primaryType: 'OwnerPolicy',
    domain: { ...POLICY_DOMAIN_V2 },
    message: policyTypedValueV2(policy),
  };
}

export function buildL1(c: L1Config): L1Artifacts {
  const problems = l1ConfigProblems(c);
  if (problems.length) throw new Error(`L1 config refused: ${problems.join('; ')}`);
  const buyer = getAddress(c.buyer);
  const seller = getAddress(c.seller);
  const body: Omit<L1ExperimentPolicy, 'policy_id'> = {
    level: 1,
    chain_id: L1_CHAIN_ID,
    assets: [{ symbol: 'USDC', contract: getAddress(c.usdc ?? BASE_SEPOLIA_USDC) as `0x${string}`, decimals: 6 }],
    wallets: { buyer: [buyer as `0x${string}`], seller: [seller as `0x${string}`] },
    counterparties: [seller as `0x${string}`],
    operations: ['pay'],
    per_tx_max_raw: { USDC: c.per_tx_raw },
    aggregate_max_raw: { USDC: c.daily_raw },
    max_tx_count: c.tx_per_day,
    max_fee_wei: c.max_fee_wei,
    not_before: c.not_before,
    expires_at: c.expires_at,
    kill_switch_path: c.kill_switch_path,
    evaluator_sha256: c.evaluator_sha256,
  };
  const experiment = { policy_id: sha256Hex(jcs(body)), ...body } as L1ExperimentPolicy;
  const policy: OwnerPolicy = {
    subject: c.subject,
    owner: getAddress(c.owner),
    actions: ['spend'],
    payees: [seller],
    per_tx_raw: c.per_tx_raw,
    daily_raw: c.daily_raw,
    total_raw: c.total_raw,
    expires_at: c.expires_at,
    nonce: c.nonce,
    authorized_impl_hashes: [l1BindingId(experiment.policy_id)],
  };
  const payload = JSON.stringify(l1TypedData(policy), null, 2);
  return { experiment, policy, payload, payload_sha256: sha256Utf8(payload), digest: policyHash(policy) };
}

const sha256Utf8 = (s: string): string => createHash('sha256').update(s, 'utf8').digest('hex');

// ── reading a payload back, strictly ──────────────────────────────────────────────────────────────────

const sameJson = (a: unknown, b: unknown): boolean => jcs(a) === jcs(b);

/** The kernel policy a payload encodes, or why it is not exactly an L1 v2 kernel policy payload. */
export function policyFromPayload(payload: string): { ok: true; policy: OwnerPolicy; digest: string } | { ok: false; error: string } {
  let t: Record<string, unknown>;
  try {
    t = JSON.parse(payload) as Record<string, unknown>;
  } catch {
    return { ok: false, error: 'the payload is not JSON' };
  }
  if (!t || typeof t !== 'object' || Array.isArray(t) || !sameJson(Object.keys(t).sort(), ['domain', 'message', 'primaryType', 'types'])) return { ok: false, error: 'the payload must be exactly { types, primaryType, domain, message }' };
  const expected = l1TypedData({ subject: 'x', owner: '0x0000000000000000000000000000000000000000', actions: [], payees: [], per_tx_raw: '0', daily_raw: '0', total_raw: '0', expires_at: 1, nonce: '0' });
  if (t['primaryType'] !== 'OwnerPolicy') return { ok: false, error: 'primaryType must be OwnerPolicy' };
  if (!sameJson(t['types'], expected['types'])) return { ok: false, error: 'the types are not the kernel v2 OwnerPolicy types' };
  if (!sameJson(t['domain'], expected['domain'])) return { ok: false, error: 'the domain is not "HyperDAG Kernel Owner Policy" v2 on chain 84532' };
  const m = t['message'] as Record<string, unknown> | null;
  if (!m || typeof m !== 'object' || !sameJson(Object.keys(m).sort(), Object.keys(expected['message'] as object).sort())) return { ok: false, error: 'the message fields are not the v2 OwnerPolicy fields' };
  const parsed = parsePolicy({
    subject: m['subject'], owner: m['owner'], actions: m['actions'], payees: m['payees'], per_tx_raw: m['perTxRaw'],
    daily_raw: m['dailyRaw'], total_raw: m['totalRaw'], expires_at: m['expiresAt'], nonce: m['nonce'], authorized_impl_hashes: m['authorizedImplHashes'],
  });
  if (!parsed.ok) return { ok: false, error: `the message is not a valid kernel policy: ${parsed.errors.join('; ')}` };
  // The kernel re-encodes what it parsed. If that is not byte-for-byte what is in the payload (a checksum-cased
  // address spelled differently, a number written as a string), the reviewer would read one thing and the
  // kernel verify another, so refuse rather than normalise.
  if (!sameJson(m, policyTypedValueV2(parsed.policy))) return { ok: false, error: 'the message is not in the canonical form the kernel verifies (address case, number types)' };
  const types = { OwnerPolicy: POLICY_TYPES_V2['OwnerPolicy']! };
  const digest = TypedDataEncoder.hash(POLICY_DOMAIN_V2, types, m);
  if (digest !== policyHash(parsed.policy)) return { ok: false, error: 'the payload does not hash to the policy the kernel would verify' };
  return { ok: true, policy: parsed.policy, digest };
}

// ── the L1 checks the kernel cannot express ───────────────────────────────────────────────────────────

/**
 * Does this experiment policy (as parsed from its file) match exactly the L1 shape and ceilings, and does
 * this kernel policy match it field for field? Every problem, by name; empty means "nothing here refuses".
 */
export function l1PairProblems(experiment: unknown, policy: OwnerPolicy): string[] {
  const out: string[] = [];
  const e = experiment as Record<string, unknown> | null;
  if (!e || typeof e !== 'object' || Array.isArray(e)) return ['the experiment policy is not an object'];
  try {
    const { policy_id, ...body } = e;
    if (policy_id !== sha256Hex(jcs(body))) out.push('the experiment policy does not hash to the id it carries');
  } catch {
    return ['the experiment policy is not canonical JSON data'];
  }
  const keys = ['aggregate_max_raw', 'assets', 'chain_id', 'counterparties', 'evaluator_sha256', 'expires_at', 'kill_switch_path', 'level', 'max_fee_wei', 'max_tx_count', 'not_before', 'operations', 'per_tx_max_raw', 'policy_id', 'wallets'];
  if (!sameJson(Object.keys(e).sort(), keys)) return [...out, 'the experiment policy fields are not the §2 fields'];
  const x = e as unknown as L1ExperimentPolicy;
  try {
    const cfg: L1Config = {
      subject: policy.subject, owner: policy.owner, buyer: String(x.wallets?.buyer?.[0]), seller: String(x.wallets?.seller?.[0]),
      per_tx_raw: policy.per_tx_raw, daily_raw: policy.daily_raw, total_raw: policy.total_raw, tx_per_day: x.max_tx_count,
      max_fee_wei: String(x.max_fee_wei), not_before: x.not_before, expires_at: policy.expires_at, kill_switch_path: String(x.kill_switch_path),
      evaluator_sha256: String(x.evaluator_sha256), nonce: policy.nonce, usdc: String(x.assets?.[0]?.contract),
    };
    const problems = l1ConfigProblems(cfg);
    if (problems.length) return [...out, ...problems];
    // Rebuild both documents from the fields read and compare: anything not reproduced is a field the
    // builder does not produce (a second asset, a widened list, a mismatched cap or expiry).
    const rebuilt = buildL1(cfg);
    if (!sameJson(e, rebuilt.experiment)) out.push('the experiment policy differs from the L1 shape built from the signed policy (a cap, expiry, wallet, asset, chain or list does not match)');
    if (!sameJson(policy, rebuilt.policy)) out.push('the signed policy differs from the L1 shape (actions must be exactly spend, payees exactly the seller, one binding to this experiment policy)');
  } catch (err) {
    out.push(`the pair could not be rebuilt: ${String((err as Error).message).slice(0, 120)}`);
  }
  return out;
}

export interface L1PolicyCheckInput {
  /** The experiment policy file, parsed. Untrusted. */
  experiment: unknown;
  /** The experiment policy id pinned when the executor was armed. */
  pinned_experiment_id: string;
  /** The latest owner-signed kernel policy the ledger holds for the subject. */
  signed: SignedOwnerPolicy | null;
  /** The owner address the executor was armed with, independent of anything in the policy. */
  pinned_owner: string;
  now_s: number;
  kill_switch_present: boolean;
}

/**
 * The policy-level refusals, run before any presentation is weighed. The signature itself is the kernel's
 * job (decide.ts `policy_signature`, on every call); this only refuses. Never authorises.
 */
export function checkL1Policy(i: L1PolicyCheckInput): PreflightRefusal[] {
  const out: PreflightRefusal[] = [];
  const no = (code: string, detail?: string) => out.push({ stage: 'policy', code, detail });
  if (i.kill_switch_present) no('kill_switch', 'the kill-switch file exists');
  if (!i.signed) {
    no('owner_policy_missing', 'the ledger holds no owner-signed policy for this subject');
    return out;
  }
  const p = parsePolicy(i.signed.policy);
  if (!p.ok) {
    no('owner_policy_malformed');
    return out;
  }
  const policy = p.policy;
  if (!isAddress(i.pinned_owner) || policy.owner.toLowerCase() !== i.pinned_owner.toLowerCase()) no('owner_not_pinned_owner', 'the policy names an owner other than the one this executor was armed with');
  const e = i.experiment as { policy_id?: unknown; level?: unknown; not_before?: unknown; expires_at?: unknown } | null;
  let hashed: string | null = null;
  try {
    const { policy_id: _id, ...body } = (e ?? {}) as Record<string, unknown>;
    hashed = sha256Hex(jcs(body));
  } catch {
    hashed = null;
  }
  if (!e || hashed !== e.policy_id) no('experiment_hash_mismatch', 'the experiment policy file does not hash to the id it carries (edited after signing)');
  if (!e || e.policy_id !== i.pinned_experiment_id) no('experiment_not_pinned', 'the experiment policy is not the one pinned at arming');
  if (e?.level !== 1) no('experiment_level_not_l1');
  if (!sameJson(policy.authorized_impl_hashes ?? [], [l1BindingId(String(e?.policy_id))])) no('binding_mismatch', 'the signed policy does not bind this experiment policy');
  for (const problem of l1PairProblems(i.experiment, policy)) no('l1_shape', problem);
  if (typeof e?.not_before === 'number' && i.now_s < e.not_before) no('policy_not_yet_valid');
  if (i.now_s >= policy.expires_at) no('policy_expired');
  return out;
}

/**
 * What has already been authorised in the rolling 24 h, read from the ledger: every ALLOW spend decision row
 * for the subject (a reservation, so a failed or unknown payment still counts; stricter than "settled").
 */
export function l1Tally(records: LedgerRecord[], subject: string, now_s: number): Tally {
  const tally: Tally = { spent: {}, count: 0 };
  for (const r of records) {
    if (r.kind !== 'receipt') continue;
    const rc = r.receipt;
    if (rc.decision.verdict !== 'ALLOW' || rc.decision.executed || rc.request.tool.class !== 'spend' || rc.subject.agent.agent_id !== subject) continue;
    if (Math.floor(Date.parse(rc.header.created_at) / 1000) < now_s - L1_DAY_S) continue;
    tally.count++;
    tally.spent['USDC'] = (tally.spent['USDC'] ?? 0n) + BigInt(rc.request.amount_raw ?? '0');
  }
  return tally;
}

/** The policy refusals, then the NPA preflight (npa-preflight.ts) against the L1 experiment policy. */
export function checkL1Presentation(i: L1PolicyCheckInput & { pres: unknown; tally: Tally; connected_chain_id: number; token_info: { symbol: string; decimals: number } | null }): PreflightRefusal[] {
  const policyRefusals = checkL1Policy(i);
  if (policyRefusals.length) return policyRefusals;
  // evaluateNpa never reads `level`; the cast only satisfies its L0 type.
  return evaluateNpa({ policy: i.experiment as ExperimentPolicy, pres: i.pres, now_s: i.now_s, tally: i.tally, connected_chain_id: i.connected_chain_id, token_info: i.token_info });
}

/**
 * Why a ledger path is not a durable L1 ledger path, or null. A relative path moves with the working
 * directory; the OS temp directory is wiped by restarts and redeploys (the RT-3 hole). Pass `tmp` = os.tmpdir().
 */
export function l1LedgerPathProblem(path: string, tmp: string): string | null {
  if (!path || !isAbsolute(path)) return 'the L1 ledger path must be absolute';
  const rel = relative(resolve(tmp).toLowerCase(), resolve(path).toLowerCase());
  if (rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))) return 'the L1 ledger must not live in the OS temp directory (a restart or redeploy wipes it)';
  return null;
}

// ── the review sheet ──────────────────────────────────────────────────────────────────────────────────

const usdc = (raw: string): string => `${formatUnits(BigInt(raw), 6)} USDC`;
const utc = (s: number): string => new Date(s * 1000).toISOString().replace('.000Z', 'Z');

/**
 * The human-readable authorization, from the payload bytes and the experiment policy file. Throws (with the
 * reason) instead of rendering when the two disagree or break an L1 ceiling: a sheet that renders is a sheet
 * whose every line is derived from the bytes the signature will cover.
 */
export function renderReviewSheet(payload: string, experimentJson: string): string {
  const fromPayload = policyFromPayload(payload);
  if (!fromPayload.ok) throw new Error(`review sheet refused: ${fromPayload.error}`);
  const policy = fromPayload.policy;
  let experiment: L1ExperimentPolicy;
  try {
    experiment = JSON.parse(experimentJson) as L1ExperimentPolicy;
  } catch {
    throw new Error('review sheet refused: the experiment policy is not JSON');
  }
  const problems = l1PairProblems(experiment, policy);
  if (!sameJson(policy.authorized_impl_hashes ?? [], [l1BindingId(experiment.policy_id)])) problems.push('the signed policy does not bind this experiment policy');
  if (experiment.level !== 1) problems.push('the experiment policy is not level 1');
  if (problems.length) throw new Error(`review sheet refused: ${problems.join('; ')}`);
  const asset = experiment.assets[0]!;
  const hours = Math.round(((policy.expires_at - experiment.not_before) / 3600) * 10) / 10;
  const L: string[] = [];
  L.push('# L1 owner authorization: review BEFORE signing');
  L.push('');
  L.push('**Signing moves no funds and needs no gas. But the signature IS an authorization: until it expires (or the');
  L.push('kill-switch file exists), it lets the L1 executor spend from the buyer wallet up to the caps below, without asking again.**');
  L.push('');
  L.push('Every value on this sheet was read from the two files below. If either file changes, this sheet changes or refuses to render.');
  L.push('');
  L.push('| What you are about to sign | Value |');
  L.push('|---|---|');
  L.push(`| Payload file sha256 (the signing page shows the same) | \`${sha256Utf8(payload)}\` |`);
  L.push(`| EIP-712 digest (what the signature covers; the kernel's policy hash) | \`${fromPayload.digest}\` |`);
  L.push(`| Signing method | \`eth_signTypedData_v4\`, from your own wallet. No key leaves it. |`);
  L.push(`| Verifier domain | name "${POLICY_DOMAIN_V2.name}", version "${POLICY_DOMAIN_V2.version}", chainId ${POLICY_DOMAIN_V2.chainId} (Base Sepolia). No verifyingContract: any HyperDAG kernel that reads this policy honours it. |`);
  L.push(`| Signer (owner) | \`${policy.owner}\`. Sign only if this is your address. |`);
  L.push(`| Agent (kernel subject) | \`${policy.subject}\`. A fresh id; no production agent has it. |`);
  L.push(`| Permitted actions | ${policy.actions.join(', ')} only. No post, no tool. Any other kind of call is refused. |`);
  L.push(`| Chain | ${experiment.chain_id} (Base Sepolia testnet). The executor refuses any other connected chain. |`);
  L.push(`| Asset | ${asset.symbol}, contract \`${asset.contract}\`, ${asset.decimals} decimals. Nothing else, no native ETH payments. |`);
  L.push(`| Paying wallet (buyer) | \`${experiment.wallets.buyer.join(', ')}\` |`);
  L.push(`| Recipients (payees) | \`${(policy.payees ?? []).join(', ')}\`. Nobody else can be paid. |`);
  L.push(`| Per payment | at most ${usdc(policy.per_tx_raw)} |`);
  L.push(`| Per rolling 24 h | at most ${usdc(policy.daily_raw)} and at most ${experiment.max_tx_count} payments |`);
  L.push(`| In total, for this policy | at most ${usdc(policy.total_raw)} |`);
  L.push(`| Gas per payment | at most ${formatUnits(BigInt(experiment.max_fee_wei), 18)} ETH (paid by the buyer wallet) |`);
  L.push(`| Valid | from ${utc(experiment.not_before)} until ${utc(policy.expires_at)} (${hours} h) |`);
  L.push(`| Nonce | ${policy.nonce} |`);
  L.push(`| Kill switch | the file \`${experiment.kill_switch_path}\`. While it exists, every payment is refused before any effect. |`);
  L.push(`| Binding | \`${(policy.authorized_impl_hashes ?? [])[0]}\` = the sha256 of the experiment policy below. Change one field of it and the executor refuses. |`);
  L.push(`| Evaluator (oracle sha256) | \`${experiment.evaluator_sha256}\` |`);
  L.push('');
  L.push('## How to stop it');
  L.push('');
  L.push(`1. **Kill switch (seconds):** create \`${experiment.kill_switch_path}\` (any content). Payments stop at the next check. A payment already broadcast cannot be recalled.`);
  L.push(`2. **Expiry (automatic):** at ${utc(policy.expires_at)} the kernel refuses every payment.`);
  L.push('3. **Empty the wallet:** move the test USDC out of the buyer wallet. The policy cannot spend what is not there.');
  L.push('');
  L.push('There is no revocation list. The signature itself stays valid until it expires; what stops spending early is the kill switch or an empty wallet. Only the L1 executor reads this policy: never post it to any other kernel.');
  L.push('');
  L.push('## What this signature does NOT do');
  L.push('');
  L.push('- It limits nothing outside the L1 executor: the kernel governs only what runs through it.');
  L.push('- The kernel checks the amount and payee the executor declares; the executor then reads the chain back, and an unconfirmed payment is recorded UNKNOWN, never SETTLED.');
  L.push('- The total resets if you sign a higher-nonce replacement (the total is per policy version).');
  L.push('- It moves no RepID and reaches no production database.');
  L.push('');
  L.push('## The experiment policy this signature binds (verbatim)');
  L.push('');
  L.push('```json');
  L.push(JSON.stringify(experiment, null, 2));
  L.push('```');
  L.push('');
  L.push('## The payload you will sign (verbatim)');
  L.push('');
  L.push('```json');
  L.push(payload);
  L.push('```');
  L.push('');
  return L.join('\n');
}
