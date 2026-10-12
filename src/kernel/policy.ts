/**
 * kernel/policy.ts — the SIGNED OWNER POLICY: what the owner's wallet permits an agent to do.
 *
 * MODELLED ON `agent-delegation.ts`'s EIP-712 Delegation (same shape of thinking: a human wallet
 * signs a typed message naming the agent, a per-transaction ceiling, a total ceiling, an expiry
 * and a nonce), and VERIFIED through `wallet-signature.ts`, so a smart-wallet owner (ERC-1271 /
 * ERC-6492) works the same as a key-pair wallet. That file is read, not edited.
 *
 * WHAT IS DIFFERENT FROM THE DELEGATION.
 *   - A limit the owner does not state is "0", not "unlimited" and not "ask someone". A policy that
 *     omits `per_tx_raw` permits a per-transaction spend of nothing.
 *   - There are three limits (per-transaction, daily, total) and the one that binds is the smallest.
 *   - It lists ACTIONS (`spend`, `post`, `tool`, `tool:<name>`); anything unlisted is denied.
 *   - It is verified against the agent's ACCOUNTABLE ROOT (accountable-root.ts), not against
 *     whoever claims to be the owner: the signature must be the root's, or the policy is void.
 *
 * THREE OUTCOMES. Verification yields VERIFIED / FAILED / NOT_CHECKED, mapped one-for-one from
 * wallet-signature's ok / invalid / not_checked. A chain that will not answer is NOT_CHECKED, and
 * NOT_CHECKED blocks; it is never read as "the signature was bad" and never as "it was fine".
 *
 * REVOCATION is supersession: a policy is replaced by one for the same subject with a higher
 * nonce. There is no revocation list in the MVP and the receipt says so (does_not_attest).
 */
import { TypedDataEncoder, getAddress, isAddress } from 'ethers';
import type { RootResult } from '../services/accountable-root';
import { verifyWalletTypedData, type SignatureChain } from '../services/wallet-signature';
import { parseLimitRaw } from './decide';
import type {
  OwnerEvidence,
  OwnerPolicy,
  PolicyEvidence,
  PolicySource,
  SignatureStatus,
  SignedOwnerPolicy,
} from './types';

export const POLICY_DOMAIN = { name: 'HyperDAG Kernel Owner Policy', version: '1', chainId: 84532 } as const;

/**
 * Field names and order are part of the EIP-712 type hash. Do not reorder or rename without bumping
 * POLICY_DOMAIN.version.
 */
export const POLICY_TYPES: Record<string, Array<{ name: string; type: string }>> = {
  OwnerPolicy: [
    { name: 'subject', type: 'string' },
    { name: 'owner', type: 'address' },
    { name: 'actions', type: 'string[]' },
    { name: 'perTxRaw', type: 'uint256' },
    { name: 'dailyRaw', type: 'uint256' },
    { name: 'totalRaw', type: 'uint256' },
    { name: 'expiresAt', type: 'uint64' },
    { name: 'nonce', type: 'uint256' },
  ],
};

/** The EIP-712 message for a policy. */
export function policyTypedValue(p: OwnerPolicy): Record<string, unknown> {
  return {
    subject: p.subject,
    owner: p.owner,
    actions: p.actions,
    perTxRaw: p.per_tx_raw,
    dailyRaw: p.daily_raw,
    totalRaw: p.total_raw,
    expiresAt: p.expires_at,
    nonce: p.nonce,
  };
}

/** The digest the owner signs. It doubles as the policy's identity in receipts. */
export function policyHash(p: OwnerPolicy): string {
  return TypedDataEncoder.hash(POLICY_DOMAIN, POLICY_TYPES, policyTypedValue(p));
}

// ── parsing ─────────────────────────────────────────────────────────────────────────────────────

const POLICY_KEYS = new Set(['subject', 'owner', 'actions', 'per_tx_raw', 'daily_raw', 'total_raw', 'expires_at', 'nonce']);
const ACTION = /^(spend|post|tool|tool:[A-Za-z0-9_.:-]{1,128})$/;
const SIGNATURE = /^0x(?:[0-9a-fA-F]{2}){2,10000}$/;
const MAX_ACTIONS = 64;

export type PolicyParse =
  | { ok: true; policy: OwnerPolicy; /** limits the owner left out, which are now "0" */ defaulted: string[] }
  | { ok: false; errors: string[] };

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/**
 * Strictly parse the policy an owner signed. Unknown keys are errors. A MISSING limit becomes "0"
 * (and is reported in `defaulted`); a PRESENT but malformed limit is an error, never quietly zeroed
 * and never quietly accepted.
 */
export function parsePolicy(input: unknown): PolicyParse {
  if (!isPlainObject(input)) return { ok: false, errors: ['policy must be an object'] };
  const errors: string[] = [];

  for (const k of Object.keys(input)) {
    if (!POLICY_KEYS.has(k)) errors.push(`unknown field "${k.slice(0, 40)}"`);
  }

  const subject = input['subject'];
  if (typeof subject !== 'string' || subject.length === 0 || subject.length > 128) errors.push('subject must be the agent id');

  const owner = input['owner'];
  let ownerAddr = '';
  if (typeof owner !== 'string' || !isAddress(owner)) errors.push('owner must be a wallet address');
  else ownerAddr = getAddress(owner);

  const actionsRaw = input['actions'];
  const actions: string[] = [];
  if (!Array.isArray(actionsRaw) || actionsRaw.length > MAX_ACTIONS) {
    errors.push('actions must be a list of spend, post, tool or tool:<name>');
  } else {
    for (const a of actionsRaw) {
      if (typeof a !== 'string' || !ACTION.test(a)) errors.push('actions holds an entry that is not spend, post, tool or tool:<name>');
      else if (actions.includes(a)) errors.push(`actions lists "${a.slice(0, 40)}" twice`);
      else actions.push(a);
    }
  }

  const defaulted: string[] = [];
  const limit = (key: 'per_tx_raw' | 'daily_raw' | 'total_raw'): string => {
    const v = input[key];
    if (v === undefined || v === null) {
      defaulted.push(key);
      return '0';
    }
    const r = parseLimitRaw(v);
    if (!r.ok) {
      errors.push(`${key}: ${r.reason}`);
      return '0';
    }
    return r.canonical;
  };
  const perTx = limit('per_tx_raw');
  const daily = limit('daily_raw');
  const total = limit('total_raw');

  const exp = input['expires_at'];
  if (typeof exp !== 'number' || !Number.isSafeInteger(exp) || exp <= 0) errors.push('expires_at must be unix seconds');

  const nonceRaw = input['nonce'];
  let nonce = '0';
  const n = parseLimitRaw(nonceRaw);
  if (!n.ok) errors.push('nonce must be a non-negative decimal integer');
  else nonce = n.canonical;

  if (errors.length > 0) return { ok: false, errors };
  return {
    ok: true,
    defaulted,
    policy: {
      subject: subject as string,
      owner: ownerAddr,
      actions,
      per_tx_raw: perTx,
      daily_raw: daily,
      total_raw: total,
      expires_at: exp as number,
      nonce,
    },
  };
}

export type SignedPolicyParse = { ok: true; signed: SignedOwnerPolicy; defaulted: string[] } | { ok: false; errors: string[] };

/** Parse a `{ policy, signature }` body. */
export function parseSignedPolicy(body: unknown): SignedPolicyParse {
  if (!isPlainObject(body)) return { ok: false, errors: ['the body must be { policy, signature }'] };
  const extra = Object.keys(body).filter((k) => k !== 'policy' && k !== 'signature');
  if (extra.length > 0) return { ok: false, errors: extra.map((k) => `unknown field "${k.slice(0, 40)}"`) };
  const sig = body['signature'];
  if (typeof sig !== 'string' || !SIGNATURE.test(sig)) return { ok: false, errors: ['signature must be hex'] };
  const p = parsePolicy(body['policy']);
  if (!p.ok) return p;
  return { ok: true, signed: { policy: p.policy, signature: sig }, defaulted: p.defaulted };
}

// ── verification ────────────────────────────────────────────────────────────────────────────────

export interface PolicyVerification {
  status: SignatureStatus;
  detail: string;
  /** eoa | erc1271 | erc6492, when VERIFIED. */
  kind?: string;
}

/**
 * Did `policy.owner` sign exactly this policy? Never throws. A chain that cannot be reached for a
 * smart-wallet check is NOT_CHECKED (wallet-signature's `not_checked`), not FAILED.
 */
export async function verifyOwnerPolicy(policy: OwnerPolicy, signature: string, chain?: SignatureChain): Promise<PolicyVerification> {
  try {
    const r = await verifyWalletTypedData(policy.owner, POLICY_DOMAIN, POLICY_TYPES, policyTypedValue(policy), signature, chain);
    if (r.ok) return { status: 'VERIFIED', detail: 'the owner signed this policy', kind: r.kind };
    return r.reason === 'not_checked'
      ? { status: 'NOT_CHECKED', detail: r.detail }
      : { status: 'FAILED', detail: r.detail };
  } catch {
    // A throw is neither a pass nor proof the signature was bad: we could not complete the check.
    return { status: 'NOT_CHECKED', detail: 'the signature check could not be completed' };
  }
}

/**
 * Read the latest policy for an agent and verify it. Every failure to look becomes `not_checked`;
 * "the store was read and holds nothing" becomes `absent`. They are different facts and decide()
 * treats them differently (DENY vs NOT_CHECKED), so they must stay different here.
 */
export async function loadPolicyEvidence(source: PolicySource, subject: string, chain?: SignatureChain): Promise<PolicyEvidence> {
  let signed: SignedOwnerPolicy | null;
  try {
    signed = await source.latest(subject);
  } catch {
    return { state: 'not_checked', detail: 'the policy store could not be read' };
  }
  if (!signed) return { state: 'absent' };

  // The store is not trusted to hold well-formed policies.
  const reparsed = parsePolicy(signed.policy);
  if (!reparsed.ok || typeof signed.signature !== 'string') {
    return { state: 'not_checked', detail: 'the stored policy is malformed' };
  }
  const policy = reparsed.policy;
  const v = await verifyOwnerPolicy(policy, signed.signature, chain);
  return {
    state: 'loaded',
    policy,
    policy_hash: policyHash(policy),
    signature: v.status,
    signature_detail: v.detail,
    // `latest()` returned the highest-nonce policy in the store we just read, so nothing newer
    // supersedes it there. That is all this establishes; explicit revocation is not modelled.
    revocation: 'VERIFIED',
  };
}

// ── the owner, from accountable-root's tri-state ────────────────────────────────────────────────

/**
 * Flatten accountable-root's result. `not_found` / `no_root` and the grant-chain refusals mean
 * "nobody answers for this agent" (none); `not_checked` and `ambiguous` mean "we could not tell"
 * (unknown), which blocks as NOT_CHECKED rather than as a denial of the agent's standing.
 */
export function ownerEvidenceFromRoot(r: RootResult): OwnerEvidence {
  if (r.ok) return { status: 'resolved', wallet: r.root.wallet, assurance: r.root.assurance };
  if (r.code === 'not_checked' || r.code === 'ambiguous') {
    return { status: 'unknown', wallet: null, assurance: null, detail: r.code };
  }
  return { status: 'none', wallet: null, assurance: null, detail: r.code };
}

