/**
 * kernel/types.ts — THE HAND-OFF SEAM. Request, decision, policy and receipt types, plus the
 * signatures of `decide()` and `runUnderKernel()`. Types only: nothing in this file runs.
 *
 * WHAT THE KERNEL IS. A policy kernel that sits between an agent and a tool and answers one
 * question BEFORE the tool runs: does a signed owner policy permit this call? It is built on four
 * rules, each of which the code enforces rather than documents:
 *
 *   1. DEFAULT DENY. A call is allowed only when every required check for its class comes back
 *      PASS. An unknown tool class, a missing policy, a missing check: all of them deny.
 *   2. NOT_CHECKED BLOCKS. "We could not look" is its own verdict and it never reads as a pass: an
 *      unreachable policy store, an unresolvable owner, an RPC that will not answer, HAL abstaining.
 *      It blocks a spend and a post (and every other class) exactly as a DENY does.
 *   3. THE SPEND LIMIT DEFAULTS TO ZERO. A policy that omits a limit has set it to "0". No policy,
 *      no limit, no spend.
 *   4. ONE RECEIPT SCHEMA, `kernel-receipt/1`, for the decision, the payment and the verification.
 *      Three legs on every record; a leg that did not happen says so (NOT_APPLICABLE / NOT_CHECKED).
 *
 * WHAT THE RECEIPT DOES NOT CONTAIN. Raw arguments (only `args_hash`), claim / prompt / user_id,
 * and anything key- or secret-shaped. `validateReceipt` (receipt.ts) rejects all of it.
 *
 * WHO BUILDS AGAINST THIS. The implementation is in decide.ts / policy.ts / receipt.ts / gate.ts /
 * store.ts; the HTTP surface is routes/kernel.ts; trustshell's `src/lib/kernel-client.ts` is the
 * client. If a field here changes, `schemas/kernel-receipt.v1.json` in trustshell changes with it
 * and both repos' shared-vector tests go red until they agree.
 *
 * NO BEHAVIOUR LIVES HERE: every import is a type, erased at compile time.
 */

// ── schema constants ────────────────────────────────────────────────────────────────────────────

export const KERNEL_RECEIPT_SCHEMA = 'kernel-receipt/1' as const;
export const KERNEL_RECEIPT_VERSION = 1 as const;

/** The classes a tool call can be filed under. Anything else is `unknown_tool_class` → DENY. */
export type ToolClass = 'read' | 'spend' | 'post' | 'other';
export const TOOL_CLASSES: readonly ToolClass[] = ['read', 'spend', 'post', 'other'];

/**
 * The three outcomes, never two. NOT_CHECKED is a verdict in its own right and it is BLOCKING.
 */
export type Verdict = 'ALLOW' | 'DENY' | 'NOT_CHECKED';
export type CheckOutcome = 'PASS' | 'FAIL' | 'NOT_CHECKED';
export type SignatureStatus = 'VERIFIED' | 'FAILED' | 'NOT_CHECKED';
export type RevocationStatus = 'VERIFIED' | 'NOT_CHECKED';

/** accountable-root's tri-state, flattened: resolved / nobody answers / could not look. */
export type OwnerStatus = 'resolved' | 'none' | 'unknown';

/** Every reason a decision can carry. A DENY or NOT_CHECKED always carries at least one. */
export type ReasonCode =
  // request
  | 'malformed_request'
  | 'unknown_tool_class'
  | 'invalid_amount'
  // owner
  | 'owner_none'
  | 'owner_not_checked'
  // policy
  | 'policy_missing'
  | 'policy_store_unavailable'
  | 'policy_subject_mismatch'
  | 'policy_signer_not_owner'
  | 'policy_signature_invalid'
  | 'policy_signature_not_checked'
  | 'policy_expired'
  | 'policy_revocation_not_checked'
  | 'action_not_permitted'
  // spend
  | 'payee_not_allowed'
  | 'spend_limit_zero'
  | 'spend_limit_exceeded'
  | 'spend_totals_not_checked'
  // post
  | 'hal_vetoed'
  | 'hal_flagged'
  | 'hal_abstained'
  | 'hal_not_checked'
  // gate
  | 'default_deny'
  | 'receipt_write_failed'
  | 'tool_error';

export interface Reason {
  code: ReasonCode;
  /** Short, safe to show. Never raw arguments, never a key, never prose from a user. */
  detail: string;
}

export interface Check {
  /** e.g. `owner_resolved`, `policy_signature`, `spend_limit`, `hal_verdict`. */
  name: string;
  outcome: CheckOutcome;
  /** Which component produced the outcome, e.g. `accountable-root`, `wallet-signature`. */
  source: string;
}

// ── the request ─────────────────────────────────────────────────────────────────────────────────

/**
 * What a caller asks the kernel to permit. ARGUMENTS ARE NEVER HERE: the caller hashes them
 * (`hashArgs` in receipt.ts) and sends the hash, so the kernel — and the ledger — never holds them.
 *
 * `tool.class` is CALLER-ASSERTED in the MVP (there is no tool registry), and the receipt says so
 * in `does_not_attest`. Money fields are legal only on a `spend` call: a `read` or `post` that
 * carries `amount_raw` / `payee` / `asset` is a spend in disguise and is denied.
 */
export interface KernelRequest {
  agent: { agent_id: string; agent_name: string };
  tool: { name: string; class: ToolClass };
  /** Where the turn came from, as the caller stamped it: Cli | Site | Mcp | Market | … */
  origin: string;
  /** 0x + 32 bytes: keccak256 of the canonical JSON of the arguments. */
  args_hash: string;
  /**
   * Smallest-unit amount for a spend. Accepts a canonical decimal string or a safe integer;
   * rejects NaN, negative, fractional, hex, exponent forms and anything above 2^53.
   */
  amount_raw: string | number | null;
  payee: string | null;
  asset: string | null;
  chain_id: number | null;
}

// ── the signed owner policy ─────────────────────────────────────────────────────────────────────

/**
 * What the owner signs (EIP-712 `OwnerPolicy`, see policy.ts). Limits are raw smallest-unit
 * strings; a limit the owner did not set is "0", never "unlimited".
 */
export interface OwnerPolicy {
  /** The agent id this policy governs. */
  subject: string;
  /** The wallet that signed. Must equal the agent's accountable root, or the policy is void. */
  owner: string;
  /** `spend` | `post` | `tool` | `tool:<name>`. Anything not listed is denied. */
  actions: string[];
  /**
   * The wallets a spend may pay. DEFAULT DENY, like the limits: omitted (or empty) means NO payee is
   * allowed, so an un-provisioned spend is refused, never allowed. Optional on the wire and in this
   * type; `parsePolicy` always fills it. Matched case-insensitively. Only a `spend` consults it.
   * It is an EIP-712 field: a policy signed before it existed does not verify under these types.
   */
  payees?: string[];
  per_tx_raw: string;
  daily_raw: string;
  total_raw: string;
  /** Unix seconds. The policy is void at and after this instant. */
  expires_at: number;
  /** Decimal string. A policy supersedes another for the same subject only with a higher nonce. */
  nonce: string;
}

export interface SignedOwnerPolicy {
  policy: OwnerPolicy;
  signature: string;
}

// ── evidence handed to decide() ─────────────────────────────────────────────────────────────────
// decide() is PURE. The gate gathers evidence (and turns every thrown error into NOT_CHECKED);
// decide() only weighs it. That split is what makes the refusal reproducible by a reviewer.

export interface OwnerEvidence {
  status: OwnerStatus;
  /** The accountable root's wallet when `resolved`; null otherwise. */
  wallet: string | null;
  /** wallet-proven | proof-of-human | operator-assigned | null */
  assurance: string | null;
  detail?: string;
}

export type PolicyEvidence =
  /** The store was read and holds no policy for this agent. Default deny, not a failure to look. */
  | { state: 'absent' }
  /** The store could not be read. */
  | { state: 'not_checked'; detail: string }
  | {
      state: 'loaded';
      policy: OwnerPolicy;
      /** The EIP-712 digest the owner signed. */
      policy_hash: string;
      signature: SignatureStatus;
      signature_detail?: string;
      revocation: RevocationStatus;
    };

/** Cumulative spend already recorded for this agent. Computed from receipts: NOT atomic. */
export type SpentEvidence =
  | { state: 'ok'; daily_raw: string; total_raw: string }
  | { state: 'not_checked'; detail: string }
  | { state: 'not_needed' };

export type SettledBy = null | 'holdout' | 'known_answer' | 'person';

/**
 * HAL's answer for a `post`. The kernel asks HAL itself (`GateDeps.halCheck`); a caller can never
 * supply this, because a caller that could say PASS would not need the kernel to say ALLOW.
 */
export interface HalEvidence {
  /** ABSTAIN is HAL not answering — a NOT_CHECKED, never a PASS and never a VETO. */
  verdict: 'PASS' | 'FLAG' | 'VETO' | 'ABSTAIN';
  method: string;
  votes: Array<{ family: string; verdict: 'PASS' | 'FAIL' | 'ABSTAIN' }>;
  /** Set only when a holdout, a known answer or a person settled it. A vote alone never does. */
  settled_by: SettledBy;
  grounded: boolean;
  same_domain: boolean;
}

export type HalState =
  | { state: 'consulted'; evidence: HalEvidence }
  | { state: 'not_checked'; detail: string }
  | { state: 'not_needed' };

export interface DecideInput {
  request: KernelRequest;
  /** Unix seconds. Injected so the decision is reproducible. */
  now_s: number;
  owner: OwnerEvidence;
  policy: PolicyEvidence;
  spent: SpentEvidence;
  hal: HalState;
}

// ── the receipt: kernel-receipt/1 ───────────────────────────────────────────────────────────────

export interface ReceiptEnv {
  network: string;
  chain_id: number;
  /**
   * True whenever no real value moved. The MVP runs simulated, which is the safe default: a
   * simulated record can never count toward restoring a band.
   */
  is_simulated: boolean;
}

export interface ReceiptHeader {
  schema: typeof KERNEL_RECEIPT_SCHEMA;
  version: typeof KERNEL_RECEIPT_VERSION;
  /**
   * The CALL's id, minted BEFORE the tool runs. An executed call has two ledger entries with the
   * same id: the decision row (executed:false) written first, then the outcome row (executed:true).
   * Chain linkage is by `prev_hash`, which names exactly one entry.
   */
  receipt_id: string;
  prev_receipt_id: string | null;
  prev_hash: string | null;
  /** ISO-8601. */
  created_at: string;
  /** keccak256 of the canonical JSON of this receipt with this field removed. */
  receipt_hash: string;
  env: ReceiptEnv;
  /** Unsigned in the MVP: integrity is the hash plus the chain, not an attestation. */
  signer: null;
}

export interface ReceiptSubject {
  agent: { agent_id: string; agent_name: string };
  owner: { wallet: string | null; assurance: string | null; status: OwnerStatus };
}

export interface ReceiptRequest {
  tool: { name: string; class: ToolClass };
  origin: string;
  args_hash: string;
  /** null for any call that is not a valid spend. */
  amount_raw: string | null;
  payee: string | null;
  asset: string | null;
  chain_id: number | null;
}

export type LimitBindingTerm = 'per_tx' | 'daily' | 'total' | 'default_zero' | 'not_computed';

export interface DecisionLeg {
  verdict: Verdict;
  /** Always `verdict !== 'ALLOW'`. Stored so a consumer never has to infer it. */
  blocking: boolean;
  /** Was the tool invoked? false on every DENY and NOT_CHECKED. */
  executed: boolean;
  reasons: Reason[];
  checks: Check[];
  /** What this decision did not establish. Always contains `cumulative_total (no atomic reservation)`. */
  does_not_attest: string[];
  policy: {
    policy_hash: string | null;
    signer: string | null;
    signature: SignatureStatus;
    expires_at: number | null;
    revocation: RevocationStatus;
  };
  limits: {
    per_tx_raw: string;
    daily_raw: string;
    total_raw: string;
    /** What a single spend may actually be: min(per_tx, daily remaining, total remaining). "0" by default. */
    effective_per_tx_raw: string;
    binding_term: LimitBindingTerm;
  };
  /** Laya is not consulted in the MVP. `lane` is null because nothing assigned one. */
  laya: { lane: string | null; mode: 'shadow'; consulted: false };
}

export type PaymentStatus = 'NOT_APPLICABLE' | 'AUTHORIZED' | 'SUBMITTED' | 'SETTLED' | 'FAILED';

export interface PaymentLeg {
  /** NOT_APPLICABLE unless the verdict is ALLOW. */
  status: PaymentStatus;
  scheme: string | null;
  amount_raw: string | null;
  payer: string | null;
  payee: string | null;
  authorization_nonce: string | null;
  tx_hash: string | null;
  block: number | null;
  observed_amount_raw: string | null;
  /** MEASURED only when something was read back from the chain. A payment we authorised is not one we observed. */
  settlement_evidence: 'MEASURED' | 'NOT_CHECKED';
  is_simulated: boolean;
}

export type VerificationStatus = 'VERIFIED' | 'FAILED' | 'NOT_CHECKED' | 'NOT_APPLICABLE';

export interface VerificationLeg {
  status: VerificationStatus;
  method: string | null;
  votes: Array<{ family: string; verdict: 'PASS' | 'FAIL' | 'ABSTAIN' }>;
  /** A vote alone is PROVISIONAL. SETTLED needs `settled_by`. */
  verdict_label: 'PROVISIONAL' | 'SETTLED';
  settled_by: SettledBy;
  grounded: boolean;
  same_domain: boolean;
  /** Mirrors env.is_simulated. Derived, never supplied. */
  is_simulated: boolean;
  /**
   * DERIVED = grounded && same_domain && !is_simulated && verdict_label === 'SETTLED'. Never supplied
   * by a caller; a receipt whose stored value disagrees with the derivation is invalid. A vote alone
   * is PROVISIONAL and never counts (RT-8). Consumers should ALSO require `status === 'VERIFIED'`
   * before restoring a band: this flag does not look at it.
   */
  counts_toward_band_restore: boolean;
}

export interface KernelReceipt {
  header: ReceiptHeader;
  subject: ReceiptSubject;
  request: ReceiptRequest;
  decision: DecisionLeg;
  payment: PaymentLeg;
  verification: VerificationLeg;
}

export interface ChainTip {
  receipt_id: string;
  receipt_hash: string;
}

// ── persistence (append-only; NO DDL) ───────────────────────────────────────────────────────────

/** One line of the ledger. */
export type LedgerRecord =
  | { kind: 'receipt'; receipt: KernelReceipt }
  | { kind: 'policy'; recorded_at: string; policy: SignedOwnerPolicy };

/** The injected sink. MVP: an append-only JSONL file. Anything with these two methods will do. */
export interface KernelSink {
  append(record: LedgerRecord): Promise<void>;
  readAll(): Promise<LedgerRecord[]>;
}

/** What validateReceipt needs from the ledger to check "executed:true needs a persisted decision row". */
export interface ValidateContext {
  /** Call ids that already have a persisted ALLOW decision row (executed:false). */
  persisted_decision_ids?: ReadonlySet<string>;
}

/** The ledger the gate talks to. Receipts, policies and spend totals, over one sink. */
export interface KernelLedger {
  /** Build, validate and persist under a lock so the chain cannot fork. Throws if any step fails. */
  appendReceipt(build: (tip: ChainTip | null) => KernelReceipt): Promise<KernelReceipt>;
  appendPolicy(signed: SignedOwnerPolicy, recordedAt: string): Promise<void>;
  /** The policy with the highest nonce for this agent, or null. THROWS if the store cannot be read. */
  latestPolicy(subject: string): Promise<SignedOwnerPolicy | null>;
  spentTotals(q: { agent_id: string; policy_hash: string; since_s: number }): Promise<{ daily_raw: string; total_raw: string }>;
  /** Every ledger entry for one call id, oldest first. */
  findReceipts(call_id: string): Promise<KernelReceipt[]>;
}

// ── the gate ────────────────────────────────────────────────────────────────────────────────────

export interface PolicySource {
  /** THROWS when the store cannot be read: that is NOT_CHECKED, not "no policy". */
  latest(subject: string): Promise<SignedOwnerPolicy | null>;
}

export type OwnerResolver = (agent: { agent_id: string; agent_name: string }) => Promise<OwnerEvidence>;

export type HalCheck = (request: KernelRequest) => Promise<HalEvidence>;

export interface GateDeps {
  ledger: KernelLedger;
  resolveOwner: OwnerResolver;
  /** Defaults to the ledger. Injectable so a test can make the policy store fail on its own. */
  policySource?: PolicySource;
  /** Required for a `post` to be allowed. Absent → HAL is NOT_CHECKED → the post is blocked. */
  halCheck?: HalCheck;
  /** Chain reads for ERC-1271 / ERC-6492 smart-wallet owners. Absent → the default Base Sepolia client. */
  chain?: import('../services/wallet-signature').SignatureChain;
  env?: ReceiptEnv;
  /** Milliseconds. Injected for reproducible decisions. */
  now?: () => number;
  newId?: () => string;
}

/** What a spend tool may report back so the outcome row can say what happened. */
export interface PaymentObservation {
  scheme?: string | null;
  payer?: string | null;
  authorization_nonce?: string | null;
  tx_hash?: string | null;
  block?: number | null;
  observed_amount_raw?: string | null;
  /** Set only when the tx was read back from the chain. */
  measured?: boolean;
}

export interface RunOptions<T> {
  /** Called with the tool's result to describe the payment that actually happened, if any. */
  observePayment?: (result: T) => PaymentObservation | undefined;
}

export type KernelTool<T> = () => Promise<T> | T;

export interface GateResult<T> {
  verdict: Verdict;
  blocking: boolean;
  /** Was the tool called? */
  executed: boolean;
  reasons: Reason[];
  /** Was the decision row written to the ledger? false only for a malformed request or a write failure. */
  persisted: boolean;
  /** The decision row. null when nothing could be persisted. */
  decision_receipt: KernelReceipt | null;
  /** The outcome row after a run; equal to `decision_receipt` when the tool did not run. */
  final_receipt: KernelReceipt | null;
  /** True when the tool ran but its outcome row could not be written. The run happened; the record is incomplete. */
  outcome_unrecorded: boolean;
  /** Present only when the tool ran and returned. */
  result?: T;
  /** Present only when the tool ran and threw: the error's class name, never its message. */
  tool_error?: string;
}

/**
 * Weigh the evidence and decide. PURE: no I/O, no clock, no randomness. Verdict is DENY unless every
 * required check for the class passed; NOT_CHECKED when nothing failed but something could not be
 * looked at; ALLOW only when all of them passed.
 */
export type Decide = (input: DecideInput) => DecisionLeg;

/**
 * decide → persist the decision row → run the tool ONLY on ALLOW → persist the outcome row.
 * A failed write of the decision row means the tool does not run. On DENY / NOT_CHECKED the tool is
 * called zero times and the receipt says executed:false.
 */
export type RunUnderKernel = <T>(
  request: unknown,
  tool: KernelTool<T>,
  deps: GateDeps,
  opts?: RunOptions<T>,
) => Promise<GateResult<T>>;
