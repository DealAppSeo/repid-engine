/**
 * kernel/gate.ts — runUnderKernel(): decide, WRITE DOWN the decision, and only then (and only on
 * ALLOW) run the tool.
 *
 *   parse → gather evidence → decide() → persist the decision row → [ALLOW only] tool() → outcome row
 *
 * THE ORDER IS THE POINT.
 *   - The decision row is written BEFORE the tool is called. If that write fails, the tool does not
 *     run: an action nobody can show was authorised is not one the kernel authorised. A failed
 *     write on a would-be ALLOW is reported NOT_CHECKED (`receipt_write_failed`), not DENY — we do
 *     not know it would have been refused, only that we cannot prove it was permitted.
 *   - On DENY and on NOT_CHECKED the tool is called ZERO times and the receipt says executed:false.
 *   - Every error while GATHERING evidence becomes NOT_CHECKED evidence. No exception escapes to
 *     decide(), and none is swallowed into a pass.
 *   - The tool is a closure the caller built around its own arguments. The kernel never receives
 *     them — only their hash — so neither the gate nor the ledger can leak what they were.
 *
 * NOT ATOMIC, AND SAYING SO. Cumulative spend is summed from receipts already written. Two calls in
 * flight at once can both read the same total. The receipt names this (`cumulative_total (no atomic
 * reservation)`); closing it needs a reservation row, which is a database change.
 */
import { randomUUID } from 'node:crypto';
import { decide, parseKernelRequest } from './decide';
import { loadPolicyEvidence } from './policy';
import { logCapabilityRegistryEmpty, screenCapability, type ToolImplementation } from './capability-registry';
import { DEFAULT_ENV, buildReceipt, validateReceipt } from './receipt';
import type {
  CapabilityState,
  DecisionLeg,
  GateDeps,
  GateResult,
  HalEvidence,
  HalState,
  KernelReceipt,
  KernelRequest,
  KernelTool,
  OwnerEvidence,
  PolicyEvidence,
  Reason,
  RunOptions,
  SpentEvidence,
} from './types';

const DAY_S = 86_400;
const HAL_VERDICTS = ['PASS', 'FLAG', 'VETO', 'ABSTAIN'];
const WALLET = /^0x[0-9a-fA-F]{40}$/;

export interface Assessment {
  request: KernelRequest;
  owner: OwnerEvidence;
  policy: PolicyEvidence;
  hal: HalState;
  capability: CapabilityState;
  /**
   * Under capability enforcement, the REGISTERED implementation the screen resolved and the gate must
   * run — reference-equal to the caller's declared closure, verified in `assess` (Draft 3). Null when
   * enforcement is off/not-applicable or the screen did not PASS. It is NOT serialised: it carries a
   * function object and never reaches a receipt.
   */
  capabilityRun: ToolImplementation | null;
  decision: DecisionLeg;
  now: number;
}

async function gatherOwner(deps: GateDeps, req: KernelRequest): Promise<OwnerEvidence> {
  const unknown: OwnerEvidence = { status: 'unknown', wallet: null, assurance: null, detail: 'owner lookup failed' };
  try {
    const o = await deps.resolveOwner(req.agent);
    if (o.status === 'resolved') {
      // A "resolved" owner we cannot compare a signature against is not resolved.
      return typeof o.wallet === 'string' && WALLET.test(o.wallet) ? o : unknown;
    }
    return o.status === 'none' ? { status: 'none', wallet: null, assurance: null } : unknown;
  } catch {
    return unknown;
  }
}

async function gatherSpent(deps: GateDeps, req: KernelRequest, policy: PolicyEvidence, now: number): Promise<SpentEvidence> {
  if (req.tool.class !== 'spend' || policy.state !== 'loaded' || policy.signature !== 'VERIFIED') return { state: 'not_needed' };
  try {
    const t = await deps.ledger.spentTotals({
      agent_id: req.agent.agent_id,
      policy_hash: policy.policy_hash,
      since_s: Math.floor(now / 1000) - DAY_S,
    });
    return { state: 'ok', daily_raw: t.daily_raw, total_raw: t.total_raw };
  } catch {
    return { state: 'not_checked', detail: 'spend totals could not be read' };
  }
}

function validHal(ev: unknown): ev is HalEvidence {
  const e = ev as Partial<HalEvidence> | null;
  return !!e && typeof e === 'object' && HAL_VERDICTS.includes(String(e.verdict)) && Array.isArray(e.votes);
}

async function gatherHal(deps: GateDeps, req: KernelRequest, worthAsking: boolean): Promise<HalState> {
  if (req.tool.class !== 'post') return { state: 'not_needed' };
  if (!worthAsking) return { state: 'not_needed' }; // already blocked upstream; do not spend a HAL call on it
  if (!deps.halCheck) return { state: 'not_checked', detail: 'HAL is not wired to the kernel' };
  try {
    const ev = await deps.halCheck(req);
    return validHal(ev) ? { state: 'consulted', evidence: ev } : { state: 'not_checked', detail: 'HAL returned an unreadable answer' };
  } catch {
    return { state: 'not_checked', detail: 'HAL could not be reached' };
  }
}

/**
 * The capability decision (poisoned-repo control). Present ONLY when the registry dep is wired, which
 * the route does only under the KERNEL_CAPABILITY_REGISTRY_ENABLED flag — so OFF this is always
 * `not_enforced` and decide() records nothing. Draft 4 screens EVERY class, including spend and post.
 * Those classes keep their own gates (limits, payee, HAL) in addition to the registry, not instead of
 * it. `tool.class` is caller-asserted, so it must not decide whether the registry applies. The
 * authorized set is read ONLY from a VERIFIED signed policy's bindings — the blanket `tool` action is
 * never consulted — so an unverified or binding-less policy authorizes no implementation and the
 * screen fails closed.
 *
 * DRAFT 3 — the executing closure is threaded in as `candidate`, so the screen verifies BY REFERENCE
 * EQUALITY that the function the gate will actually run IS the boot-registered implementation (via the
 * registry's `isRegisteredImplementation`). A caller that declares an authorized implId but supplies a
 * DIFFERENT closure fails closed here with `impl_reference_mismatch` BEFORE anything runs — closing the
 * "closure swap" (CWE-863). `screen.run` is returned so `runUnderKernel` runs the REGISTERED
 * implementation, never the caller-supplied closure. A dry decision passes no candidate (there is no
 * closure to run); the reference check is then skipped and the result must be read as NOT-RUNNABLE.
 */
function gatherCapability(
  deps: GateDeps,
  req: KernelRequest,
  policy: PolicyEvidence,
  candidate: unknown,
): { capability: CapabilityState; run: ToolImplementation | null } {
  if (!deps.capabilityRegistry) return { capability: { state: 'not_enforced' }, run: null };
  // Every class that reaches decide() is screened. Spend and post still have their own gates; those
  // run as well. An unknown or unregistered reference fails closed to FAIL (XC1 #7a, Draft 4).
  try {
    if (deps.capabilityRegistry.size === 0) logCapabilityRegistryEmpty('decision');
    const authorized =
      policy.state === 'loaded' && policy.signature === 'VERIFIED'
        ? new Set(policy.policy.authorized_impl_hashes ?? [])
        : new Set<string>();
    const screen = screenCapability({ implRef: req.tool.name, candidate }, deps.capabilityRegistry, authorized);
    return {
      capability: {
        state: 'enforced',
        decision: {
          outcome: screen.outcome,
          capability_id: screen.capabilityId,
          impl_id: screen.implId,
          code: screen.code,
          detail: screen.detail,
        },
      },
      // The REGISTERED implementation to run on an ALLOW (screen PASS). Null on any non-PASS, so the
      // gate never has a caller-supplied closure to fall back to under enforcement.
      run: screen.run,
    };
  } catch {
    // Fail closed: an un-screenable registry blocks rather than passes.
    return { capability: { state: 'not_checked', detail: 'the capability registry could not be screened' }, run: null };
  }
}

/**
 * Everything up to and including decide(). No writes, no tool. Shared by the gate and the dry route.
 *
 * `candidate` is the EXECUTING closure, threaded through so the capability screen can verify, by
 * reference equality, that the function the gate will run is the boot-registered implementation
 * (Draft 3). The gate (`runUnderKernel`) passes the caller's `tool`; the dry route passes nothing,
 * because a dry decision runs nothing — its capability outcome is a policy-level would-allow, NOT an
 * enforced ALLOW of execution.
 */
export async function assess(request: KernelRequest, deps: GateDeps, candidate?: unknown): Promise<Assessment> {
  const now = (deps.now ?? Date.now)();

  // Independent reads. Each one's failure is its own NOT_CHECKED, never another one's.
  const [owner, policy] = await Promise.all([
    gatherOwner(deps, request),
    loadPolicyEvidence(deps.policySource ?? { latest: (subject) => deps.ledger.latestPolicy(subject) }, request.agent.agent_id, deps.chain),
  ]);
  const spent = await gatherSpent(deps, request, policy, now);
  const worthAsking = owner.status === 'resolved' && policy.state === 'loaded' && policy.signature === 'VERIFIED';
  const hal = await gatherHal(deps, request, worthAsking);
  const { capability, run: capabilityRun } = gatherCapability(deps, request, policy, candidate);

  const decision = decide({ request, now_s: Math.floor(now / 1000), owner, policy, spent, hal, capability });
  return { request, owner, policy, hal, capability, capabilityRun, decision, now };
}

/** Objects, arrays, and functions. Null and scalars are not opaque. */
function isOpaqueReturn(result: unknown): boolean {
  if (typeof result === 'function') return true;
  return typeof result === 'object' && result !== null;
}

function refused<T>(verdict: 'DENY' | 'NOT_CHECKED', reasons: Reason[]): GateResult<T> {
  return {
    verdict,
    blocking: true,
    executed: false,
    reasons,
    persisted: false,
    decision_receipt: null,
    final_receipt: null,
    outcome_unrecorded: false,
  };
}

/**
 * The enforcement point. `request` is untrusted input (a body, an LLM's tool call); `tool` is the
 * thing to run. Returns what happened — it does not throw for a refusal.
 */
export async function runUnderKernel<T>(
  rawRequest: unknown,
  tool: KernelTool<T>,
  deps: GateDeps,
  opts: RunOptions<T> = {},
): Promise<GateResult<T>> {
  if (typeof tool !== 'function') {
    return refused('DENY', [{ code: 'malformed_request', detail: 'there is no tool to run' }]);
  }
  const parsed = parseKernelRequest(rawRequest);
  if (!parsed.ok) {
    // Nothing trustworthy to attribute a receipt to, so none is written. The refusal is still a refusal.
    return refused('DENY', parsed.reasons);
  }

  // The EXECUTING closure is threaded into the screen so the capability check verifies, by reference
  // equality, that the function we will run IS the boot-registered implementation (Draft 3).
  const a = await assess(parsed.request, deps, tool);
  const env = deps.env ?? DEFAULT_ENV;
  const newId = deps.newId ?? randomUUID;
  const receiptId = newId();
  const createdAt = new Date(a.now).toISOString();

  // 1. Write the decision down FIRST. No row, no run.
  let decisionRow: KernelReceipt;
  try {
    decisionRow = await deps.ledger.appendReceipt((tip) =>
      buildReceipt({
        receipt_id: receiptId,
        prev: tip,
        created_at: createdAt,
        env,
        request: a.request,
        owner: a.owner,
        decision: a.decision,
        executed: false,
        phase: 'decision',
        hal: a.hal,
      }),
    );
  } catch {
    const reasons: Reason[] = [...a.decision.reasons, { code: 'receipt_write_failed', detail: 'the decision could not be written to the ledger, so nothing was run' }];
    return refused(a.decision.verdict === 'DENY' ? 'DENY' : 'NOT_CHECKED', reasons);
  }

  // 2. DENY and NOT_CHECKED stop here. The tool is not called.
  if (a.decision.verdict !== 'ALLOW') {
    return {
      verdict: a.decision.verdict,
      blocking: true,
      executed: false,
      reasons: a.decision.reasons,
      persisted: true,
      decision_receipt: decisionRow,
      final_receipt: decisionRow,
      outcome_unrecorded: false,
    };
  }

  // 3. ALLOW: run, then record what happened. A throw is data, not an escape.
  //
  // Under capability enforcement the gate runs the REGISTERED implementation the screen resolved
  // (`a.capabilityRun`) — reference-equal to the caller's declared closure, already verified in
  // assess — and NEVER a caller-supplied closure under an authorized name. There is no delegation or
  // passthrough hole: a reference mismatch is a FAIL in assess, which makes the verdict DENY and never
  // reaches here. OFF (the flag unset, no registry dep) runs the caller's `tool` exactly as before —
  // byte-identical. If enforcement somehow yielded no registered
  // implementation on an ALLOW (it cannot: screen PASS always returns `run`), `executing` is null and
  // the call throws — recorded as a tool error, with the caller's closure still never run (fail closed).
  const executing: KernelTool<T> =
    a.capability.state === 'enforced' ? ((a.capabilityRun as unknown) as KernelTool<T>) : tool;
  let result: T | undefined;
  let toolError: string | undefined;
  try {
    result = await executing();
  } catch (e) {
    toolError = e instanceof Error ? e.name : 'Error'; // the class of failure, never its message
  }
  // Opaque returns (objects, arrays, functions) are withheld. Scalars stay: the kernel suite's
  // positive control returns the number 42, and GateResult<T> is generic. A receipt never carries
  // the value either way. Strings, numbers, and booleans are handed back unchanged.
  if (toolError === undefined && isOpaqueReturn(result)) {
    toolError = 'OpaqueReturn';
    result = undefined;
  }

  let observation: ReturnType<NonNullable<RunOptions<T>['observePayment']>>;
  if (toolError === undefined && opts.observePayment) {
    try {
      observation = opts.observePayment(result as T);
    } catch {
      observation = undefined;
    }
  }

  const outcomeDecision: DecisionLeg =
    toolError === undefined
      ? a.decision
      : {
          ...a.decision,
          reasons: [
            ...a.decision.reasons,
            toolError === 'OpaqueReturn'
              ? { code: 'tool_error', detail: 'the tool returned an opaque value; the value was withheld' }
              : { code: 'tool_error', detail: `the tool ran and threw (${toolError})` },
          ],
        };

  let outcomeRow: KernelReceipt | null = null;
  try {
    outcomeRow = await deps.ledger.appendReceipt((tip) =>
      buildReceipt({
        receipt_id: receiptId,
        prev: tip,
        created_at: new Date((deps.now ?? Date.now)()).toISOString(),
        env,
        request: a.request,
        owner: a.owner,
        decision: outcomeDecision,
        executed: true,
        phase: 'outcome',
        hal: a.hal,
        toolFailed: toolError !== undefined,
        observation,
      }),
    );
  } catch {
    outcomeRow = null; // it ran; the record of it is incomplete — and the result says so
  }

  const out: GateResult<T> = {
    verdict: 'ALLOW',
    blocking: false,
    executed: true,
    reasons: outcomeDecision.reasons,
    persisted: true,
    decision_receipt: decisionRow,
    final_receipt: outcomeRow,
    outcome_unrecorded: outcomeRow === null,
  };
  // FAIL-CLOSED OUTPUT GATE. The tool's return value enters the gate result only when the tool
  // returned a scalar (string, number, or boolean) AND its outcome row was recorded. On a throw, an
  // opaque return, or a failed outcome write (`outcome_unrecorded`), the value is withheld. A receipt
  // never carries a return value, only an args_hash.
  if (toolError === undefined && outcomeRow !== null) out.result = result as T;
  else if (toolError !== undefined) out.tool_error = toolError;
  return out;
}

/** Inside a dry preview receipt. Persisted execution receipts do not carry this line. */
export const DRY_PREVIEW_DOES_NOT_ATTEST = 'dry_preview (this receipt is not an authorization to execute)';

export interface DryDecision {
  verdict: DecisionLeg['verdict'];
  blocking: boolean;
  /** Always false: a dry decision writes nothing and runs nothing. */
  persisted: false;
  /**
   * ALWAYS false (Draft 3). A dry decision runs no tool, so its verdict must NEVER be read as an
   * enforced ALLOW of execution: an ALLOW here means only that the owner's signed policy WOULD permit
   * the call. Under the capability registry a dry decide verifies the policy binding but NOT the
   * executing closure (there is none to check by reference equality), so even a capability-PASS dry
   * ALLOW is a would-allow, not a run. `runUnderKernel` is the only path that runs anything, and it is
   * where the executing closure is pinned to the registered implementation.
   */
  runnable: false;
  decision: DecisionLeg;
  /** A well-formed, validated kernel-receipt/1 for this decision. NOT chained and NOT in the ledger. */
  receipt_preview: KernelReceipt | null;
  reasons: Reason[];
}

/** decide() without the side effects: nothing is written and nothing runs. Backs POST /decide. */
export async function dryDecision(rawRequest: unknown, deps: GateDeps): Promise<DryDecision | { malformed: Reason[] }> {
  const parsed = parseKernelRequest(rawRequest);
  if (!parsed.ok) return { malformed: parsed.reasons };
  // NO candidate: a dry decision runs nothing, so there is no executing closure to verify by reference
  // equality. The capability screen therefore resolves + authorizes + prohibits only, and the result
  // is marked `runnable: false` below so it can never be read as an enforced ALLOW of execution.
  const a = await assess(parsed.request, deps);
  const env = deps.env ?? DEFAULT_ENV;
  let preview: KernelReceipt | null = null;
  try {
    // The schema has no `runnable` field. The preview is told apart from a persisted decision row by
    // this line inside the hashed decision. `decision.executed: false` is not enough: a real run writes
    // a decision row with executed false before the tool runs.
    const previewDecision = {
      ...a.decision,
      does_not_attest: [...a.decision.does_not_attest, DRY_PREVIEW_DOES_NOT_ATTEST],
    };
    const candidate = buildReceipt({
      receipt_id: (deps.newId ?? randomUUID)(),
      prev: null,
      created_at: new Date(a.now).toISOString(),
      env,
      request: a.request,
      owner: a.owner,
      decision: previewDecision,
      executed: false,
      phase: 'decision',
      hal: a.hal,
    });
    preview = validateReceipt(candidate).ok ? candidate : null;
  } catch {
    preview = null;
  }
  return {
    verdict: a.decision.verdict,
    blocking: a.decision.verdict !== 'ALLOW',
    persisted: false,
    // A dry decision never runs a tool. ALLOW here is a policy-level would-allow, not an enforced run.
    runnable: false,
    decision: a.decision,
    receipt_preview: preview,
    reasons: a.decision.reasons,
  };
}
