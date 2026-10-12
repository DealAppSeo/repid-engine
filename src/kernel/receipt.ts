/**
 * kernel/receipt.ts — the ONE receipt: `kernel-receipt/1`.
 *
 * One record per call carries three legs — the DECISION, the PAYMENT, the VERIFICATION — and a leg
 * that did not happen says so (NOT_APPLICABLE, or NOT_CHECKED when it should have). Before this,
 * "was it allowed", "did money move" and "was the content checked" lived in three shapes with three
 * vocabularies; a consumer joining them had to guess which "ok" meant what.
 *
 * INTEGRITY IS A HASH AND A CHAIN, NOT A SIGNATURE (header.signer is null in the MVP, and the
 * receipt says so). `receipt_hash` is keccak256 of the canonical JSON of the receipt with that
 * field removed; `prev_hash` names the entry before it. Edit any entry and its hash stops matching;
 * remove one and the next entry's `prev_hash` points at nothing.
 *
 * validateReceipt() is code, not JSON Schema, because the rules that matter are CROSS-FIELD: an
 * ALLOW that cleared fewer checks than its class requires, a payment on a refused call, a band
 * restore counted from a simulated run. A schema can say a field is a boolean; it cannot say the
 * boolean is wrong. The ledger runs this before it persists anything, so a receipt that breaks an
 * invariant cannot be written — and a decision that cannot be written does not run the tool.
 */
import { keccak256, toUtf8Bytes } from 'ethers';
import { canonicalJson } from '../services/owner-authorization';
import { CUMULATIVE_TOTAL_NOTE, REQUIRED_CHECKS, TOTAL_CAP_SCOPE_NOTE, parseAmountRaw } from './decide';
import type {
  ChainTip,
  DecisionLeg,
  HalState,
  KernelReceipt,
  KernelRequest,
  OwnerEvidence,
  PaymentLeg,
  PaymentObservation,
  ReceiptEnv,
  ReceiptRequest,
  ToolClass,
  ValidateContext,
  VerificationLeg,
} from './types';
import { KERNEL_RECEIPT_SCHEMA, KERNEL_RECEIPT_VERSION, TOOL_CLASSES } from './types';

/**
 * The MVP runs SIMULATED: no real value moves. That is the safe default — a simulated record can
 * never count toward restoring a band. Turning it off is a decision for whoever wires real spend.
 */
export const DEFAULT_ENV: ReceiptEnv = { network: 'base-sepolia', chain_id: 84532, is_simulated: true };

// ── hashing ─────────────────────────────────────────────────────────────────────────────────────

/** keccak256 of the canonical JSON of the arguments. Callers send THIS, never the arguments. */
export function hashArgs(args: unknown): string {
  return keccak256(toUtf8Bytes(canonicalJson(args)));
}

/** keccak256 of the canonical JSON of the receipt without `header.receipt_hash`. */
export function receiptHash(r: KernelReceipt): string {
  const { receipt_hash: _omit, ...header } = r.header;
  return keccak256(toUtf8Bytes(canonicalJson({ ...r, header })));
}

// ── the legs ────────────────────────────────────────────────────────────────────────────────────

const SETTLERS = ['holdout', 'known_answer', 'person'] as const;

/**
 * Derive the verification leg from what HAL said. Nothing here is supplied by a caller.
 *
 *   status        PASS → VERIFIED; FLAG / VETO → FAILED; ABSTAIN or no answer → NOT_CHECKED.
 *   verdict_label PROVISIONAL unless `settled_by` is a holdout, a known answer or a person. A vote
 *                 — 3-0 or 2-1 — never settles anything, because the voters are correlated.
 *   counts_toward_band_restore = grounded && same_domain && !is_simulated && verdict_label === 'SETTLED',
 *                 computed here. SETTLED is in it because "the score moves on a holdout, a known
 *                 answer or a person" (Sean): a vote, however unanimous, is PROVISIONAL, and a
 *                 PROVISIONAL verdict restoring a band would move a score on a vote. It was missing
 *                 until XC1's red team (RT-8): a grounded, same-domain 2-1 vote counted and the
 *                 receipt validated. Dormant while every env is simulated; armed by real spend.
 */
export function buildVerificationLeg(cls: ToolClass, hal: HalState, isSimulated: boolean): VerificationLeg {
  const none = (status: 'NOT_APPLICABLE' | 'NOT_CHECKED'): VerificationLeg => ({
    status,
    method: null,
    votes: [],
    verdict_label: 'PROVISIONAL',
    settled_by: null,
    grounded: false,
    same_domain: false,
    is_simulated: isSimulated,
    counts_toward_band_restore: false,
  });
  if (cls !== 'post') return none('NOT_APPLICABLE');
  if (hal.state !== 'consulted' || hal.evidence.verdict === 'ABSTAIN') return none('NOT_CHECKED');

  const ev = hal.evidence;
  const settledBy = (SETTLERS as readonly unknown[]).includes(ev.settled_by) ? ev.settled_by : null;
  const grounded = ev.grounded === true;
  const sameDomain = ev.same_domain === true;
  const verdictLabel = settledBy ? 'SETTLED' : 'PROVISIONAL';
  return {
    status: ev.verdict === 'PASS' ? 'VERIFIED' : 'FAILED',
    method: typeof ev.method === 'string' ? ev.method.slice(0, 64) : null,
    votes: (Array.isArray(ev.votes) ? ev.votes : []).map((v) => ({ family: String(v.family).slice(0, 64), verdict: v.verdict })),
    verdict_label: verdictLabel,
    settled_by: settledBy,
    grounded,
    same_domain: sameDomain,
    is_simulated: isSimulated,
    counts_toward_band_restore: grounded && sameDomain && !isSimulated && verdictLabel === 'SETTLED',
  };
}

function emptyPayment(status: PaymentLeg['status'], isSimulated: boolean): PaymentLeg {
  return {
    status,
    scheme: null,
    amount_raw: null,
    payer: null,
    payee: null,
    authorization_nonce: null,
    tx_hash: null,
    block: null,
    observed_amount_raw: null,
    settlement_evidence: 'NOT_CHECKED',
    is_simulated: isSimulated,
  };
}

/**
 * The payment leg. NOT_APPLICABLE unless the verdict is ALLOW and the call is a spend.
 *   decision row   AUTHORIZED   — the kernel said yes; nothing has moved; settlement NOT_CHECKED.
 *   outcome row    SUBMITTED    — the tool ran and reported something.
 *                  SETTLED      — only with a read-back (`measured`) on a non-simulated run.
 *                  FAILED       — the tool threw.
 */
export function buildPaymentLeg(args: {
  verdict: DecisionLeg['verdict'];
  req: ReceiptRequest;
  phase: 'decision' | 'outcome';
  toolFailed: boolean;
  observation?: PaymentObservation | undefined;
  isSimulated: boolean;
}): PaymentLeg {
  const { verdict, req, phase, toolFailed, observation: obs, isSimulated } = args;
  if (verdict !== 'ALLOW' || req.tool.class !== 'spend') return emptyPayment('NOT_APPLICABLE', isSimulated);

  const base: PaymentLeg = {
    ...emptyPayment('AUTHORIZED', isSimulated),
    amount_raw: req.amount_raw,
    payee: req.payee,
  };
  if (phase === 'decision') return base;
  if (toolFailed) return { ...base, status: 'FAILED' };

  const measured = obs?.measured === true && !isSimulated && typeof obs.tx_hash === 'string' && typeof obs.observed_amount_raw === 'string';
  return {
    ...base,
    status: measured ? 'SETTLED' : 'SUBMITTED',
    scheme: obs?.scheme ?? null,
    payer: obs?.payer ?? null,
    authorization_nonce: obs?.authorization_nonce ?? null,
    tx_hash: obs?.tx_hash ?? null,
    block: obs?.block ?? null,
    observed_amount_raw: obs?.observed_amount_raw ?? null,
    settlement_evidence: measured ? 'MEASURED' : 'NOT_CHECKED',
  };
}

// ── building ────────────────────────────────────────────────────────────────────────────────────

export interface BuildReceiptInput {
  /** The call's id, minted before the tool runs. */
  receipt_id: string;
  prev: ChainTip | null;
  /** ISO-8601. */
  created_at: string;
  env: ReceiptEnv;
  request: KernelRequest;
  owner: OwnerEvidence;
  decision: DecisionLeg;
  /** true only for the outcome row written after the tool was called. */
  executed: boolean;
  phase: 'decision' | 'outcome';
  hal: HalState;
  toolFailed?: boolean;
  observation?: PaymentObservation | undefined;
}

function receiptRequest(req: KernelRequest): ReceiptRequest {
  const cls: ToolClass = (TOOL_CLASSES as readonly string[]).includes(req.tool.class) ? req.tool.class : 'other';
  const amt = parseAmountRaw(req.amount_raw);
  return {
    tool: { name: req.tool.name, class: cls },
    origin: req.origin,
    args_hash: req.args_hash,
    amount_raw: amt.ok ? amt.canonical : null,
    payee: req.payee ?? null,
    asset: req.asset ?? null,
    chain_id: req.chain_id ?? null,
  };
}

/** Assemble a receipt and seal it with its hash. Does not validate; the ledger validates. */
export function buildReceipt(input: BuildReceiptInput): KernelReceipt {
  const request = receiptRequest(input.request);
  const decision: DecisionLeg = {
    ...input.decision,
    executed: input.executed,
    blocking: input.decision.verdict !== 'ALLOW',
  };
  const draft: KernelReceipt = {
    header: {
      schema: KERNEL_RECEIPT_SCHEMA,
      version: KERNEL_RECEIPT_VERSION,
      receipt_id: input.receipt_id,
      prev_receipt_id: input.prev?.receipt_id ?? null,
      prev_hash: input.prev?.receipt_hash ?? null,
      created_at: input.created_at,
      receipt_hash: '',
      env: input.env,
      signer: null,
    },
    subject: {
      agent: { agent_id: input.request.agent.agent_id, agent_name: input.request.agent.agent_name },
      owner: { wallet: input.owner.wallet, assurance: input.owner.assurance, status: input.owner.status },
    },
    request,
    decision,
    payment: buildPaymentLeg({
      verdict: decision.verdict,
      req: request,
      phase: input.phase,
      toolFailed: input.toolFailed === true,
      observation: input.observation,
      isSimulated: input.env.is_simulated,
    }),
    verification: buildVerificationLeg(request.tool.class, input.hal, input.env.is_simulated),
  };
  draft.header.receipt_hash = receiptHash(draft);
  return draft;
}

// ── validation ──────────────────────────────────────────────────────────────────────────────────

export type InvariantCode =
  | 'structure'
  | 'hash_mismatch'
  | 'blocking_mismatch'
  | 'payment_without_allow' // (1)
  | 'executed_without_allow' // (2)
  | 'spend_over_effective_limit' // (3)
  | 'allow_with_unresolved_check' // (4)
  | 'allow_missing_required_check'
  | 'refusal_without_reason'
  | 'settled_without_settler' // (5)
  | 'unverified_leg_carries_evidence'
  | 'band_restore_not_derived' // (6)
  | 'executed_without_persisted_decision' // (7)
  | 'secret_shaped_material' // (8)
  | 'forbidden_key' // (8)
  | 'does_not_attest_missing_cumulative_total'
  | 'does_not_attest_missing_total_scope'
  | 'simulation_mismatch'
  | 'settlement_unmeasured';

export interface ReceiptViolation {
  code: InvariantCode;
  path: string;
  detail: string;
}

export type ReceiptValidation = { ok: true } | { ok: false; errors: ReceiptViolation[] };

const HEX32 = /^0x[0-9a-fA-F]{64}$/;
const UINT = /^(0|[1-9][0-9]*)$/;
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;

/** Fields that are allowed to hold a 32-byte 0x value. Anywhere else it is key-shaped. */
const HASH_PATHS = new Set([
  'header.receipt_hash',
  'header.prev_hash',
  'request.args_hash',
  'decision.policy.policy_hash',
  'payment.tx_hash',
  'payment.authorization_nonce',
]);

/** Keys that must never appear anywhere in a receipt: the receipt carries hashes, not content. */
const FORBIDDEN_KEYS = new Set(['claim', 'prompt', 'user_id', 'args', 'raw_args', 'arguments']);
const SECRET_KEY_NAME = /(private[_-]?key|secret|mnemonic|seed[_-]?phrase|api[_-]?key|password|passwd|bearer|access[_-]?token|auth[_-]?token)/i;
const SECRET_VALUES: RegExp[] = [
  /eyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\./, // JWT
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\b(?:sk-[A-Za-z0-9]{16,}|gsk_[A-Za-z0-9]{16,}|xai-[A-Za-z0-9]{16,}|AIza[0-9A-Za-z_-]{20,}|sb_secret_[A-Za-z0-9_-]{8,}|ghp_[A-Za-z0-9]{20,})/,
  /(?<![0-9a-zA-Z])[0-9a-fA-F]{64}(?![0-9a-zA-Z])/, // 32 bytes of hex with no 0x: the shape of a private key
];
const HEX32_ANYWHERE = /0x[0-9a-fA-F]{64}/;

function walk(node: unknown, path: string, visit: (path: string, key: string | null, value: unknown) => void, key: string | null = null): void {
  visit(path, key, node);
  if (Array.isArray(node)) node.forEach((v, i) => walk(v, `${path}[${i}]`, visit, null));
  else if (node !== null && typeof node === 'object') {
    for (const [k, v] of Object.entries(node as Record<string, unknown>)) walk(v, path ? `${path}.${k}` : k, visit, k);
  }
}

/** Paths holding key-shaped material or a forbidden key. Exported so the demo can show it firing. */
export function findForbidden(receipt: unknown): Array<{ code: 'secret_shaped_material' | 'forbidden_key'; path: string }> {
  const out: Array<{ code: 'secret_shaped_material' | 'forbidden_key'; path: string }> = [];
  walk(receipt, '', (path, key, value) => {
    if (key !== null && FORBIDDEN_KEYS.has(key.toLowerCase())) out.push({ code: 'forbidden_key', path });
    if (key !== null && SECRET_KEY_NAME.test(key)) out.push({ code: 'secret_shaped_material', path });
    if (typeof value === 'string') {
      if (SECRET_VALUES.some((re) => re.test(value))) out.push({ code: 'secret_shaped_material', path });
      else if (HEX32_ANYWHERE.test(value) && !HASH_PATHS.has(path)) out.push({ code: 'secret_shaped_material', path });
    }
  });
  return out;
}

const isStr = (v: unknown): v is string => typeof v === 'string';
const isStrOrNull = (v: unknown): boolean => v === null || typeof v === 'string';
const isBool = (v: unknown): v is boolean => typeof v === 'boolean';
const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
const oneOf = (v: unknown, set: readonly unknown[]): boolean => set.includes(v);

/** The shape, field by field. Returns messages; empty means well-formed. */
function structureErrors(r: unknown): string[] {
  const e: string[] = [];
  const need = (cond: boolean, msg: string): void => {
    if (!cond) e.push(msg);
  };
  if (!isObj(r)) return ['receipt must be an object'];
  const { header: h, subject: s, request: q, decision: d, payment: p, verification: v } = r as Record<string, unknown>;
  if (![h, s, q, d, p, v].every(isObj)) return ['receipt needs header, subject, request, decision, payment and verification'];
  const H = h as Record<string, any>;
  const S = s as Record<string, any>;
  const Q = q as Record<string, any>;
  const D = d as Record<string, any>;
  const P = p as Record<string, any>;
  const V = v as Record<string, any>;

  need(H['schema'] === KERNEL_RECEIPT_SCHEMA && H['version'] === KERNEL_RECEIPT_VERSION, 'header.schema/version');
  need(isStr(H['receipt_id']) && H['receipt_id'].length > 0, 'header.receipt_id');
  need(isStrOrNull(H['prev_receipt_id']) && (H['prev_receipt_id'] === null) === (H['prev_hash'] === null), 'header.prev_receipt_id/prev_hash must both be set or both null');
  need(H['prev_hash'] === null || (isStr(H['prev_hash']) && HEX32.test(H['prev_hash'])), 'header.prev_hash');
  need(isStr(H['created_at']) && !Number.isNaN(Date.parse(H['created_at'])), 'header.created_at');
  need(isStr(H['receipt_hash']) && HEX32.test(H['receipt_hash']), 'header.receipt_hash');
  need(isObj(H['env']) && isStr(H['env']['network']) && Number.isSafeInteger(H['env']['chain_id']) && isBool(H['env']['is_simulated']), 'header.env');
  need(H['signer'] === null, 'header.signer must be null in kernel-receipt/1');

  need(isObj(S['agent']) && isStr(S['agent']['agent_id']) && isStr(S['agent']['agent_name']), 'subject.agent');
  need(isObj(S['owner']) && isStrOrNull(S['owner']['wallet']) && isStrOrNull(S['owner']['assurance']) && oneOf(S['owner']['status'], ['resolved', 'none', 'unknown']), 'subject.owner');

  need(isObj(Q['tool']) && isStr(Q['tool']['name']) && oneOf(Q['tool']['class'], TOOL_CLASSES), 'request.tool');
  need(isStr(Q['origin']), 'request.origin');
  need(isStr(Q['args_hash']) && HEX32.test(Q['args_hash']), 'request.args_hash');
  need(Q['amount_raw'] === null || (isStr(Q['amount_raw']) && UINT.test(Q['amount_raw'])), 'request.amount_raw');
  need(isStrOrNull(Q['payee']) && isStrOrNull(Q['asset']), 'request.payee/asset');
  need(Q['chain_id'] === null || Number.isSafeInteger(Q['chain_id']), 'request.chain_id');

  need(oneOf(D['verdict'], ['ALLOW', 'DENY', 'NOT_CHECKED']), 'decision.verdict');
  need(isBool(D['blocking']) && isBool(D['executed']), 'decision.blocking/executed');
  need(Array.isArray(D['reasons']) && D['reasons'].every((x: any) => isObj(x) && isStr(x['code']) && isStr(x['detail'])), 'decision.reasons');
  need(Array.isArray(D['checks']) && D['checks'].every((x: any) => isObj(x) && isStr(x['name']) && oneOf(x['outcome'], ['PASS', 'FAIL', 'NOT_CHECKED']) && isStr(x['source'])), 'decision.checks');
  need(Array.isArray(D['does_not_attest']) && D['does_not_attest'].every(isStr), 'decision.does_not_attest');
  const pol = D['policy'];
  need(isObj(pol) && isStrOrNull(pol['policy_hash']) && isStrOrNull(pol['signer']) && oneOf(pol['signature'], ['VERIFIED', 'FAILED', 'NOT_CHECKED']) && (pol['expires_at'] === null || Number.isSafeInteger(pol['expires_at'])) && oneOf(pol['revocation'], ['VERIFIED', 'NOT_CHECKED']), 'decision.policy');
  const lim = D['limits'];
  need(isObj(lim) && ['per_tx_raw', 'daily_raw', 'total_raw', 'effective_per_tx_raw'].every((k) => isStr(lim[k]) && UINT.test(lim[k])) && oneOf(lim['binding_term'], ['per_tx', 'daily', 'total', 'default_zero', 'not_computed']), 'decision.limits');
  need(isObj(D['laya']) && D['laya']['mode'] === 'shadow' && D['laya']['consulted'] === false && isStrOrNull(D['laya']['lane']), 'decision.laya must be shadow / not consulted');

  need(oneOf(P['status'], ['NOT_APPLICABLE', 'AUTHORIZED', 'SUBMITTED', 'SETTLED', 'FAILED']), 'payment.status');
  need(['scheme', 'payer', 'payee', 'authorization_nonce', 'tx_hash', 'observed_amount_raw'].every((k) => isStrOrNull(P[k])), 'payment string fields');
  need(P['amount_raw'] === null || (isStr(P['amount_raw']) && UINT.test(P['amount_raw'])), 'payment.amount_raw');
  need(P['block'] === null || Number.isSafeInteger(P['block']), 'payment.block');
  need(oneOf(P['settlement_evidence'], ['MEASURED', 'NOT_CHECKED']) && isBool(P['is_simulated']), 'payment.settlement_evidence/is_simulated');
  need(P['tx_hash'] === null || HEX32.test(String(P['tx_hash'])), 'payment.tx_hash');
  need(P['payer'] === null || ADDRESS.test(String(P['payer'])), 'payment.payer');

  need(oneOf(V['status'], ['VERIFIED', 'FAILED', 'NOT_CHECKED', 'NOT_APPLICABLE']), 'verification.status');
  need(isStrOrNull(V['method']), 'verification.method');
  need(Array.isArray(V['votes']) && V['votes'].every((x: any) => isObj(x) && isStr(x['family']) && oneOf(x['verdict'], ['PASS', 'FAIL', 'ABSTAIN'])), 'verification.votes');
  need(oneOf(V['verdict_label'], ['PROVISIONAL', 'SETTLED']) && (V['settled_by'] === null || oneOf(V['settled_by'], SETTLERS)), 'verification label/settled_by');
  need(isBool(V['grounded']) && isBool(V['same_domain']) && isBool(V['is_simulated']) && isBool(V['counts_toward_band_restore']), 'verification booleans');
  return e;
}

/**
 * Check the invariants a schema cannot express. `ctx.persisted_decision_ids` is how invariant (7)
 * is decided: the ledger passes the call ids that already have a persisted ALLOW decision row.
 */
export function validateReceipt(receipt: unknown, ctx: ValidateContext = {}): ReceiptValidation {
  const errors: ReceiptViolation[] = [];
  const add = (code: InvariantCode, path: string, detail: string): void => {
    errors.push({ code, path, detail });
  };

  // (8) first and on the raw value: it must hold even when the shape is wrong.
  for (const f of findForbidden(receipt)) {
    add(f.code, f.path, f.code === 'forbidden_key' ? 'a receipt carries hashes, not content' : 'key- or secret-shaped material');
  }

  const shape = structureErrors(receipt);
  if (shape.length > 0) {
    for (const m of shape) add('structure', m, m);
    return { ok: false, errors };
  }
  const r = receipt as KernelReceipt;
  const d = r.decision;
  const allow = d.verdict === 'ALLOW';

  if (receiptHash(r) !== r.header.receipt_hash) add('hash_mismatch', 'header.receipt_hash', 'the hash does not match the receipt body');
  if (d.blocking !== !allow) add('blocking_mismatch', 'decision.blocking', 'blocking must equal verdict !== ALLOW');

  // (1) payment only on an ALLOW
  if (r.payment.status !== 'NOT_APPLICABLE' && !allow) add('payment_without_allow', 'payment.status', `payment is ${r.payment.status} on a ${d.verdict}`);

  // (2) a refusal never ran
  if (d.executed && !allow) add('executed_without_allow', 'decision.executed', `a ${d.verdict} cannot have executed`);

  // (3) an allowed spend fits under the effective limit
  if (allow && r.request.tool.class === 'spend') {
    const amt = r.request.amount_raw === null ? null : BigInt(r.request.amount_raw);
    if (amt === null || amt > BigInt(d.limits.effective_per_tx_raw)) {
      add('spend_over_effective_limit', 'request.amount_raw', 'an allowed spend must not exceed effective_per_tx_raw');
    }
  }

  // (4) NOT_CHECKED never reads as a pass: an ALLOW rests on checks that all PASSED, and on
  //     every check its class requires. Stronger than "spend and post": it holds for every class,
  //     because the class is the caller's own claim.
  if (allow) {
    for (const c of d.checks) {
      if (c.outcome !== 'PASS') add('allow_with_unresolved_check', `decision.checks.${c.name}`, `ALLOW with a ${c.outcome} check`);
    }
    for (const name of REQUIRED_CHECKS[r.request.tool.class]) {
      if (d.checks.find((c) => c.name === name)?.outcome !== 'PASS') add('allow_missing_required_check', `decision.checks.${name}`, 'ALLOW without a passing required check');
    }
  } else if (d.reasons.length === 0) {
    add('refusal_without_reason', 'decision.reasons', 'a DENY or NOT_CHECKED must say why');
  }

  // (5) a vote alone is PROVISIONAL; SETTLED needs a settler
  const v = r.verification;
  if (v.verdict_label === 'SETTLED' && !oneOf(v.settled_by, SETTLERS)) {
    add('settled_without_settler', 'verification.verdict_label', 'SETTLED requires settled_by of holdout, known_answer or person');
  }
  const verdicts = new Set(v.votes.map((x) => x.verdict));
  if (verdicts.has('PASS') && verdicts.has('FAIL') && v.settled_by === null && v.verdict_label !== 'PROVISIONAL') {
    add('settled_without_settler', 'verification.verdict_label', 'a split vote with no settler is PROVISIONAL');
  }
  if ((v.status === 'NOT_APPLICABLE' || v.status === 'NOT_CHECKED') && (v.votes.length > 0 || v.grounded || v.same_domain || v.settled_by !== null || v.verdict_label !== 'PROVISIONAL')) {
    add('unverified_leg_carries_evidence', 'verification', `a ${v.status} verification cannot carry votes, grounding or a settler`);
  }

  // (6) derived, never supplied
  if (v.counts_toward_band_restore !== (v.grounded && v.same_domain && !v.is_simulated && v.verdict_label === 'SETTLED')) {
    add('band_restore_not_derived', 'verification.counts_toward_band_restore', "must equal grounded && same_domain && !is_simulated && verdict_label === 'SETTLED'");
  }

  // (7) an executed record needs the decision row to exist first
  if (d.executed && !ctx.persisted_decision_ids?.has(r.header.receipt_id)) {
    add('executed_without_persisted_decision', 'decision.executed', 'executed:true needs a persisted decision row for this call first');
  }

  // honesty about what is not attested
  if (!d.does_not_attest.includes(CUMULATIVE_TOTAL_NOTE)) {
    add('does_not_attest_missing_cumulative_total', 'decision.does_not_attest', `must name "${CUMULATIVE_TOTAL_NOTE}"`);
  }

  // A cap that silently resets must not read as a lifetime guarantee: any spend record says so.
  if (r.request.tool.class === 'spend' && !d.does_not_attest.includes(TOTAL_CAP_SCOPE_NOTE)) {
    add('does_not_attest_missing_total_scope', 'decision.does_not_attest', 'a spend receipt must say the total cap is per policy version');
  }

  // the legs agree with the environment, and "settled" means something was measured
  const sim = r.header.env.is_simulated;
  if (sim && (!r.payment.is_simulated || !v.is_simulated)) add('simulation_mismatch', 'header.env.is_simulated', 'a simulated environment cannot hold a leg that claims to be real');
  if (r.payment.settlement_evidence === 'MEASURED' && (r.payment.is_simulated || r.payment.tx_hash === null || r.payment.observed_amount_raw === null)) {
    add('settlement_unmeasured', 'payment.settlement_evidence', 'MEASURED needs a transaction and an observed amount, and cannot be simulated');
  }
  if (r.payment.status === 'SETTLED' && r.payment.settlement_evidence !== 'MEASURED') {
    add('settlement_unmeasured', 'payment.status', 'SETTLED needs settlement_evidence MEASURED');
  }

  return errors.length === 0 ? { ok: true } : { ok: false, errors };
}

// ── the chain ───────────────────────────────────────────────────────────────────────────────────

export type ChainVerification = { ok: true } | { ok: false; index: number; code: 'hash_mismatch' | 'broken_link' | 'bad_start'; detail: string };

/** Walk receipts in ledger order: each hash matches its body, each prev_hash names the entry before. */
export function verifyReceiptChain(receipts: readonly KernelReceipt[]): ChainVerification {
  let prev: KernelReceipt | null = null;
  for (let i = 0; i < receipts.length; i++) {
    const r = receipts[i]!;
    if (receiptHash(r) !== r.header.receipt_hash) return { ok: false, index: i, code: 'hash_mismatch', detail: 'entry body does not match its hash' };
    if (prev === null) {
      if (r.header.prev_hash !== null) return { ok: false, index: i, code: 'bad_start', detail: 'the first entry must have no predecessor' };
    } else if (r.header.prev_hash !== prev.header.receipt_hash || r.header.prev_receipt_id !== prev.header.receipt_id) {
      return { ok: false, index: i, code: 'broken_link', detail: 'prev_hash does not name the previous entry' };
    }
    prev = r;
  }
  return { ok: true };
}
