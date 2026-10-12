/**
 * kernel/decide.ts — the decision. PURE: no I/O, no clock, no randomness, no module state.
 *
 * Everything decide() weighs has already been gathered by the gate and handed over as EVIDENCE
 * (owner, policy, spend totals, HAL). Every read that failed arrives as `not_checked`; decide()
 * never sees an exception and never invents a pass for something it was not shown.
 *
 * THE SHAPE OF THE ANSWER.
 *   - A check that FAILED is a DENY. A check that could not be performed is NOT_CHECKED. Both
 *     block. If one thing failed and another could not be looked at, the verdict is DENY: a
 *     definite no is not softened into "unknown" by an unrelated gap.
 *   - ALLOW exists in exactly one place, at the bottom, and only when EVERY check REQUIRED for the
 *     call's class is present and PASS. A missing required check is not a pass: it falls through
 *     to DENY(default_deny). The verdict starts at DENY and has to be earned.
 *   - The spend limit is "0" until a verified policy says otherwise.
 *
 * Why the checks are listed per class rather than looped: a reviewer must be able to see, in one
 * place, what an ALLOW rests on. `REQUIRED_CHECKS` is that place, and receipt.ts reads the same
 * table so an ALLOW receipt that lacks one of them is rejected at the ledger.
 */
import type {
  Check,
  DecideInput,
  DecisionLeg,
  KernelRequest,
  LimitBindingTerm,
  Reason,
  ReasonCode,
  ToolClass,
} from './types';
import { TOOL_CLASSES } from './types';

// ── amounts ─────────────────────────────────────────────────────────────────────────────────────

/** 2^53. Above this a JS number is no longer exact, and a downstream Number() would round it. */
export const MAX_AMOUNT = 2n ** 53n;
const CANONICAL_UINT = /^(0|[1-9][0-9]*)$/;
export const UINT256_MAX = 2n ** 256n - 1n;

export type AmountParse = { ok: true; value: bigint; canonical: string } | { ok: false; reason: string };

/**
 * Parse a spend amount without ever passing it through floating point.
 *
 * Accepts a canonical decimal string ("10000") or a non-negative SAFE-integer number. Rejects:
 * NaN and Infinity, negatives, fractions, hex ("0x10"), exponent ("1e3"), padded (" 10", "010"),
 * empty, anything that is not a string/number, and anything above 2^53 — a string above it parses
 * exactly but is refused, because the payment signer downstream reads the amount as a Number.
 */
export function parseAmountRaw(raw: unknown): AmountParse {
  let value: bigint;
  if (typeof raw === 'number') {
    if (!Number.isFinite(raw)) return { ok: false, reason: 'amount is not a finite number' };
    if (!Number.isSafeInteger(raw)) return { ok: false, reason: 'amount is not a safe integer' };
    if (raw < 0) return { ok: false, reason: 'amount is negative' };
    value = BigInt(raw);
  } else if (typeof raw === 'bigint') {
    if (raw < 0n) return { ok: false, reason: 'amount is negative' };
    value = raw;
  } else if (typeof raw === 'string') {
    if (!CANONICAL_UINT.test(raw)) return { ok: false, reason: 'amount is not a canonical non-negative decimal integer' };
    value = BigInt(raw);
  } else {
    return { ok: false, reason: 'amount is missing or not a number or decimal string' };
  }
  if (value > MAX_AMOUNT) return { ok: false, reason: 'amount is above 2^53' };
  return { ok: true, value, canonical: value.toString() };
}

/** A policy limit: canonical decimal string, any size up to uint256. Never floats, never negative. */
export function parseLimitRaw(raw: unknown): { ok: true; value: bigint; canonical: string } | { ok: false; reason: string } {
  if (typeof raw === 'number') {
    if (!Number.isSafeInteger(raw) || raw < 0) return { ok: false, reason: 'limit is not a non-negative safe integer' };
    return { ok: true, value: BigInt(raw), canonical: String(raw) };
  }
  if (typeof raw !== 'string' || !CANONICAL_UINT.test(raw)) return { ok: false, reason: 'limit is not a canonical non-negative decimal integer' };
  const value = BigInt(raw);
  if (value > UINT256_MAX) return { ok: false, reason: 'limit is above uint256' };
  return { ok: true, value, canonical: raw };
}

// ── the request, strictly parsed ────────────────────────────────────────────────────────────────

const REQUEST_KEYS = new Set(['agent', 'tool', 'origin', 'args_hash', 'amount_raw', 'payee', 'asset', 'chain_id']);
const HEX32 = /^0x[0-9a-fA-F]{64}$/;

export type RequestParse =
  | { ok: true; request: KernelRequest }
  | { ok: false; reasons: Reason[] };

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function boundedString(v: unknown, max: number): v is string {
  return typeof v === 'string' && v.length > 0 && v.length <= max;
}

/**
 * Turn an untrusted body into a KernelRequest, or say why not.
 *
 * STRICT. An unknown key is a rejection, not something to ignore: that is what keeps `claim`,
 * `prompt`, `user_id`, raw `args`, and a supplied `counts_toward_band_restore` out of the kernel
 * rather than relying on every later stage to drop them. Only the NAME of an offending key is ever
 * echoed back, never its value.
 */
export function parseKernelRequest(raw: unknown): RequestParse {
  const bad = (code: ReasonCode, detail: string): RequestParse => ({ ok: false, reasons: [{ code, detail }] });
  if (!isPlainObject(raw)) return bad('malformed_request', 'the request must be a JSON object');

  for (const k of Object.keys(raw)) {
    if (!REQUEST_KEYS.has(k)) return bad('malformed_request', `unknown field "${k.slice(0, 40)}" (not part of the request)`);
  }

  const agent = raw['agent'];
  if (!isPlainObject(agent) || !boundedString(agent['agent_id'], 128) || typeof agent['agent_name'] !== 'string' || agent['agent_name'].length > 128) {
    return bad('malformed_request', 'agent must be { agent_id, agent_name }');
  }
  for (const k of Object.keys(agent)) {
    if (k !== 'agent_id' && k !== 'agent_name') return bad('malformed_request', `unknown field "agent.${k.slice(0, 40)}"`);
  }

  const tool = raw['tool'];
  if (!isPlainObject(tool) || !boundedString(tool['name'], 128) || typeof tool['class'] !== 'string') {
    return bad('malformed_request', 'tool must be { name, class }');
  }
  for (const k of Object.keys(tool)) {
    if (k !== 'name' && k !== 'class') return bad('malformed_request', `unknown field "tool.${k.slice(0, 40)}"`);
  }
  if (!(TOOL_CLASSES as readonly string[]).includes(tool['class'])) {
    return bad('unknown_tool_class', 'the tool class is not one of read, spend, post, other');
  }

  if (!boundedString(raw['origin'], 64)) return bad('malformed_request', 'origin must be a short string');
  const argsHash = raw['args_hash'];
  if (typeof argsHash !== 'string' || !HEX32.test(argsHash)) {
    return bad('malformed_request', 'args_hash must be 0x followed by 64 hex characters (hash the arguments; never send them)');
  }

  const optString = (k: string): string | null | undefined => {
    const v = raw[k];
    if (v === undefined || v === null) return null;
    return boundedString(v, 128) ? v : undefined;
  };
  const payee = optString('payee');
  const asset = optString('asset');
  if (payee === undefined || asset === undefined) return bad('malformed_request', 'payee and asset must be short strings or null');

  const chain = raw['chain_id'];
  if (chain !== undefined && chain !== null && !(typeof chain === 'number' && Number.isSafeInteger(chain) && chain > 0)) {
    return bad('malformed_request', 'chain_id must be a positive integer or null');
  }

  const amount = raw['amount_raw'];
  if (amount !== undefined && amount !== null && typeof amount !== 'string' && typeof amount !== 'number') {
    return bad('malformed_request', 'amount_raw must be a decimal string, a safe integer, or null');
  }

  return {
    ok: true,
    request: {
      agent: { agent_id: agent['agent_id'] as string, agent_name: agent['agent_name'] as string },
      tool: { name: tool['name'] as string, class: tool['class'] as ToolClass },
      origin: raw['origin'] as string,
      args_hash: argsHash.toLowerCase(),
      amount_raw: (amount ?? null) as string | number | null,
      payee,
      asset,
      chain_id: (chain ?? null) as number | null,
    },
  };
}

// ── the table of what an ALLOW rests on ─────────────────────────────────────────────────────────

const COMMON_CHECKS = [
  'request_wellformed',
  'owner_resolved',
  'policy_present',
  'policy_subject',
  'policy_signer_is_owner',
  'policy_signature',
  'policy_unexpired',
  'policy_revocation',
  'action_permitted',
] as const;

/**
 * The checks an ALLOW needs, by class. A name missing from `checks` or not PASS means no ALLOW.
 * receipt.ts validates every ALLOW receipt against this same table.
 */
export const REQUIRED_CHECKS: Readonly<Record<ToolClass, readonly string[]>> = {
  read: COMMON_CHECKS,
  other: COMMON_CHECKS,
  spend: [...COMMON_CHECKS, 'amount_valid', 'payee_allowed', 'spend_totals', 'spend_limit'],
  post: [...COMMON_CHECKS, 'hal_verdict'],
};

/** Standing statements about what no kernel decision establishes in the MVP. */
export const CUMULATIVE_TOTAL_NOTE = 'cumulative_total (no atomic reservation)';
/**
 * The total limit is summed over spends recorded under ONE policy hash, and the hash includes the
 * nonce. A higher-nonce policy therefore starts a fresh total. Whether the total should instead be
 * per agent for its lifetime is the owner-of-the-decision's call (Sean's); until it is made, the
 * receipt must not let a cap that resets read as one that does not.
 */
export const TOTAL_CAP_SCOPE_NOTE =
  'total_cap_scope (the total limit is per policy version, not lifetime: it is keyed to the policy hash, which includes the nonce, so it resets when a policy is superseded)';
const STANDING_DOES_NOT_ATTEST = [
  CUMULATIVE_TOTAL_NOTE,
  TOTAL_CAP_SCOPE_NOTE,
  'tool_class (caller-asserted; there is no tool registry in the MVP)',
  'explicit_revocation (revocation is supersession by a higher nonce inside this ledger only)',
  'laya (shadow mode; not consulted)',
  'receipt_signature (unsigned in the MVP; integrity is the hash and the chain)',
] as const;

function isToolClass(v: unknown): v is ToolClass {
  return typeof v === 'string' && (TOOL_CLASSES as readonly string[]).includes(v);
}

function actionPermitted(actions: readonly string[], req: KernelRequest): boolean {
  switch (req.tool.class) {
    case 'spend':
      return actions.includes('spend');
    case 'post':
      return actions.includes('post');
    case 'read':
    case 'other':
      return actions.includes('tool') || actions.includes(`tool:${req.tool.name}`);
  }
}

function safeBig(s: string): bigint {
  try {
    return BigInt(s);
  } catch {
    return 0n;
  }
}

// ── decide ──────────────────────────────────────────────────────────────────────────────────────

export function decide(input: DecideInput): DecisionLeg {
  const { request, owner, policy, spent, hal } = input;
  const reasons: Reason[] = [];
  const checks: Check[] = [];

  const record = (name: string, outcome: Check['outcome'], source: string, reason?: Reason): void => {
    checks.push({ name, outcome, source });
    if (reason) reasons.push(reason);
  };
  const skip = (name: string, because: string): void => {
    // Not looked at because something upstream already blocked it. Recorded, not hidden.
    checks.push({ name, outcome: 'NOT_CHECKED', source: `kernel/decide (not reached: ${because})` });
  };

  const cls = request?.tool?.class;
  const classKnown = isToolClass(cls);

  // 1. the request itself ----------------------------------------------------------------------
  let wellformed = true;
  if (!classKnown) {
    wellformed = false;
    record('request_wellformed', 'FAIL', 'kernel/decide', { code: 'unknown_tool_class', detail: 'the tool class is not one of read, spend, post, other' });
  } else if (cls !== 'spend' && (request.amount_raw !== null && request.amount_raw !== undefined || request.payee || request.asset)) {
    // A read or a post that carries money fields is a spend in disguise.
    wellformed = false;
    record('request_wellformed', 'FAIL', 'kernel/decide', { code: 'malformed_request', detail: 'money fields (amount, payee, asset) on a call that is not a spend' });
  } else {
    record('request_wellformed', 'PASS', 'kernel/decide');
  }

  // 2. who answers for this agent --------------------------------------------------------------
  const ownerWallet = owner.status === 'resolved' ? owner.wallet : null;
  if (owner.status === 'resolved' && ownerWallet) {
    record('owner_resolved', 'PASS', 'accountable-root');
  } else if (owner.status === 'none') {
    record('owner_resolved', 'FAIL', 'accountable-root', { code: 'owner_none', detail: 'nobody answers for this agent, so no policy can be authoritative' });
  } else {
    // 'unknown', or 'resolved' without a wallet (which is not an owner we can compare against).
    record('owner_resolved', 'NOT_CHECKED', 'accountable-root', { code: 'owner_not_checked', detail: 'the owner of this agent could not be established' });
  }

  // 3. the signed policy -----------------------------------------------------------------------
  let verified = false; // a policy we may rely on for LIMITS: loaded and its signature VERIFIED
  let signature: DecisionLeg['policy']['signature'] = 'NOT_CHECKED';
  let revocation: DecisionLeg['policy']['revocation'] = 'NOT_CHECKED';
  let policyHash: string | null = null;
  let policySigner: string | null = null;
  let expiresAt: number | null = null;

  if (policy.state === 'absent') {
    record('policy_present', 'FAIL', 'policy-store', { code: 'policy_missing', detail: 'no owner policy is on record for this agent; the default is deny' });
    for (const n of ['policy_subject', 'policy_signer_is_owner', 'policy_signature', 'policy_unexpired', 'policy_revocation', 'action_permitted']) skip(n, 'policy_missing');
  } else if (policy.state === 'not_checked') {
    record('policy_present', 'NOT_CHECKED', 'policy-store', { code: 'policy_store_unavailable', detail: 'the policy store could not be read' });
    for (const n of ['policy_subject', 'policy_signer_is_owner', 'policy_signature', 'policy_unexpired', 'policy_revocation', 'action_permitted']) skip(n, 'policy_store_unavailable');
  } else {
    const p = policy.policy;
    policyHash = policy.policy_hash;
    policySigner = p.owner;
    expiresAt = p.expires_at;
    signature = policy.signature;
    revocation = policy.revocation;
    record('policy_present', 'PASS', 'policy-store');

    record(
      'policy_subject',
      p.subject === request.agent.agent_id ? 'PASS' : 'FAIL',
      'kernel/decide',
      p.subject === request.agent.agent_id ? undefined : { code: 'policy_subject_mismatch', detail: 'the policy was signed for a different agent' },
    );

    if (ownerWallet) {
      const same = ownerWallet.toLowerCase() === p.owner.toLowerCase();
      record('policy_signer_is_owner', same ? 'PASS' : 'FAIL', 'accountable-root', same ? undefined : { code: 'policy_signer_not_owner', detail: "the policy was not signed by this agent's accountable owner" });
    } else {
      skip('policy_signer_is_owner', 'owner not resolved');
    }

    if (policy.signature === 'VERIFIED') record('policy_signature', 'PASS', 'wallet-signature');
    else if (policy.signature === 'FAILED') record('policy_signature', 'FAIL', 'wallet-signature', { code: 'policy_signature_invalid', detail: 'the policy signature did not verify against its stated owner' });
    else record('policy_signature', 'NOT_CHECKED', 'wallet-signature', { code: 'policy_signature_not_checked', detail: policy.signature_detail ?? 'the policy signature could not be checked (chain unreachable)' });

    const live = input.now_s < p.expires_at;
    record('policy_unexpired', live ? 'PASS' : 'FAIL', 'kernel/decide', live ? undefined : { code: 'policy_expired', detail: 'the owner policy has expired' });

    if (policy.revocation === 'VERIFIED') record('policy_revocation', 'PASS', 'policy-store');
    else record('policy_revocation', 'NOT_CHECKED', 'policy-store', { code: 'policy_revocation_not_checked', detail: 'whether a newer policy supersedes this one could not be established' });

    record(
      'action_permitted',
      actionPermitted(p.actions, request) ? 'PASS' : 'FAIL',
      'kernel/decide',
      actionPermitted(p.actions, request) ? undefined : { code: 'action_not_permitted', detail: 'the owner policy does not list this kind of action' },
    );

    verified = policy.signature === 'VERIFIED';
  }

  // 4. limits -----------------------------------------------------------------------------------
  // Shown only from a policy whose signature verified: a forged policy's numbers are not a fact.
  const perTx = verified && policy.state === 'loaded' ? safeBig(policy.policy.per_tx_raw) : 0n;
  const daily = verified && policy.state === 'loaded' ? safeBig(policy.policy.daily_raw) : 0n;
  const total = verified && policy.state === 'loaded' ? safeBig(policy.policy.total_raw) : 0n;

  let effective = 0n;
  let binding: LimitBindingTerm = 'default_zero';
  if (verified) {
    binding = 'not_computed';
    if (spent.state === 'ok') {
      const dailyLeft = daily > safeBig(spent.daily_raw) ? daily - safeBig(spent.daily_raw) : 0n;
      const totalLeft = total > safeBig(spent.total_raw) ? total - safeBig(spent.total_raw) : 0n;
      const candidates: Array<[LimitBindingTerm, bigint]> = [['per_tx', perTx], ['daily', dailyLeft], ['total', totalLeft]];
      let best = candidates[0]!;
      for (const c of candidates) if (c[1] < best[1]) best = c;
      binding = best[0];
      effective = best[1];
    } else if (perTx === 0n) {
      // Cumulative totals are unknown, but min(0, anything) is 0.
      binding = 'per_tx';
      effective = 0n;
    }
  }

  // 5. spend ------------------------------------------------------------------------------------
  if (cls === 'spend') {
    const amt = parseAmountRaw(request.amount_raw);
    let amount: bigint | null = null;
    if (!amt.ok) {
      record('amount_valid', 'FAIL', 'kernel/decide', { code: 'invalid_amount', detail: amt.reason });
    } else if (amt.value === 0n) {
      record('amount_valid', 'FAIL', 'kernel/decide', { code: 'invalid_amount', detail: 'a spend must be greater than zero' });
    } else {
      amount = amt.value;
      record('amount_valid', 'PASS', 'kernel/decide');
    }

    // The payee must be on the owner's list. An omitted list is an EMPTY list: nobody is allowed.
    if (!verified || policy.state !== 'loaded') {
      skip('payee_allowed', 'policy not verified');
    } else {
      const payee = typeof request.payee === 'string' ? request.payee.trim().toLowerCase() : '';
      const listed = (policy.policy.payees ?? []).map((a) => a.toLowerCase());
      if (payee === '') {
        record('payee_allowed', 'FAIL', 'kernel/decide', { code: 'payee_not_allowed', detail: 'a spend must name its payee' });
      } else if (listed.length === 0) {
        record('payee_allowed', 'FAIL', 'kernel/decide', { code: 'payee_not_allowed', detail: 'the owner policy lists no payees (an unset list allows none)' });
      } else if (!listed.includes(payee)) {
        record('payee_allowed', 'FAIL', 'kernel/decide', { code: 'payee_not_allowed', detail: 'the payee is not on the owner policy\'s list' });
      } else {
        record('payee_allowed', 'PASS', 'kernel/decide');
      }
    }

    if (!verified) {
      skip('spend_totals', 'policy not verified');
    } else if (spent.state === 'ok') {
      record('spend_totals', 'PASS', 'ledger');
    } else {
      record('spend_totals', 'NOT_CHECKED', 'ledger', {
        code: 'spend_totals_not_checked',
        detail: spent.state === 'not_checked' ? 'spend already recorded could not be read' : 'spend already recorded was not supplied',
      });
    }

    if (!verified) {
      skip('spend_limit', 'policy not verified');
    } else if (amount === null) {
      skip('spend_limit', 'amount invalid');
    } else if (amount > perTx) {
      // Definitive whatever the totals say: the per-transaction ceiling alone refuses it.
      record('spend_limit', 'FAIL', 'kernel/decide', perTx === 0n
        ? { code: 'spend_limit_zero', detail: 'the per-transaction spend limit is 0 (an unset limit is 0)' }
        : { code: 'spend_limit_exceeded', detail: `amount ${amount} exceeds the per-transaction limit ${perTx}` });
    } else if (spent.state === 'ok') {
      if (amount <= effective) record('spend_limit', 'PASS', 'kernel/decide');
      else {
        record('spend_limit', 'FAIL', 'kernel/decide', effective === 0n
          ? { code: 'spend_limit_zero', detail: `the effective spend limit is 0 (binding term: ${binding})` }
          : { code: 'spend_limit_exceeded', detail: `amount ${amount} exceeds the effective limit ${effective} (binding term: ${binding})` });
      }
    } else {
      skip('spend_limit', 'spend totals not checked');
    }
  }

  // 6. post -------------------------------------------------------------------------------------
  if (cls === 'post') {
    if (hal.state === 'consulted') {
      const v = hal.evidence.verdict;
      if (v === 'PASS') record('hal_verdict', 'PASS', 'hal');
      else if (v === 'VETO') record('hal_verdict', 'FAIL', 'hal', { code: 'hal_vetoed', detail: 'HAL vetoed this post' });
      else if (v === 'FLAG') record('hal_verdict', 'FAIL', 'hal', { code: 'hal_flagged', detail: 'HAL flagged this post; flagged is not cleared' });
      else record('hal_verdict', 'NOT_CHECKED', 'hal', { code: 'hal_abstained', detail: 'HAL abstained; an abstention is not a pass' });
    } else {
      record('hal_verdict', 'NOT_CHECKED', 'hal', {
        code: 'hal_not_checked',
        detail: hal.state === 'not_checked' ? hal.detail : 'HAL was not consulted',
      });
    }
  }

  // 7. the verdict: starts at DENY, ALLOW has to be earned ---------------------------------------
  const anyFail = checks.some((c) => c.outcome === 'FAIL');
  const anyNotChecked = checks.some((c) => c.outcome === 'NOT_CHECKED');
  const required = classKnown ? REQUIRED_CHECKS[cls] : [];
  const everyRequiredPassed =
    classKnown && wellformed && required.every((name) => checks.find((c) => c.name === name)?.outcome === 'PASS');

  let verdict: DecisionLeg['verdict'] = 'DENY';
  if (anyFail) verdict = 'DENY';
  else if (anyNotChecked) verdict = 'NOT_CHECKED';
  else if (everyRequiredPassed) verdict = 'ALLOW';
  if (verdict === 'DENY' && reasons.length === 0) {
    reasons.push({ code: 'default_deny', detail: 'no rule allowed this call' });
  }

  // 8. what this decision does not establish -----------------------------------------------------
  const doesNotAttest: string[] = [...STANDING_DOES_NOT_ATTEST];
  if (cls === 'post') {
    if (hal.state !== 'consulted' || hal.evidence.verdict === 'ABSTAIN') doesNotAttest.push('hal_content_verdict (HAL did not answer)');
    else if (hal.evidence.settled_by === null) doesNotAttest.push('verification_settled (votes alone are PROVISIONAL; no holdout, known answer or person settled it)');
  }
  if (cls === 'spend') {
    doesNotAttest.push('asset_and_chain (the owner policy does not constrain which asset or chain a spend uses)');
    // The payee gate checks the payee the CALLER DECLARED. The tool is a closure the kernel never sees
    // into, so what it then actually pays is not observed here.
    doesNotAttest.push('declared_payment_fields (amount and payee are as the caller declared them; the kernel does not observe what the tool then pays)');
  }
  if (cls === 'spend' && verdict === 'ALLOW') doesNotAttest.push('settlement (this is an authorisation, not an observed payment)');

  return {
    verdict,
    blocking: verdict !== 'ALLOW',
    executed: false,
    reasons,
    checks,
    does_not_attest: doesNotAttest,
    policy: { policy_hash: policyHash, signer: policySigner, signature, expires_at: expiresAt, revocation },
    limits: {
      per_tx_raw: perTx.toString(),
      daily_raw: daily.toString(),
      total_raw: total.toString(),
      effective_per_tx_raw: effective.toString(),
      binding_term: binding,
    },
    laya: { lane: null, mode: 'shadow', consulted: false },
  };
}
