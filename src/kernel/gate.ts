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
import { DEFAULT_ENV, buildReceipt, validateReceipt } from './receipt';
import type {
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

/** Everything up to and including decide(). No writes, no tool. Shared by the gate and the dry route. */
export async function assess(request: KernelRequest, deps: GateDeps): Promise<Assessment> {
  const now = (deps.now ?? Date.now)();

  // Independent reads. Each one's failure is its own NOT_CHECKED, never another one's.
  const [owner, policy] = await Promise.all([
    gatherOwner(deps, request),
    loadPolicyEvidence(deps.policySource ?? { latest: (subject) => deps.ledger.latestPolicy(subject) }, request.agent.agent_id, deps.chain),
  ]);
  const spent = await gatherSpent(deps, request, policy, now);
  const worthAsking = owner.status === 'resolved' && policy.state === 'loaded' && policy.signature === 'VERIFIED';
  const hal = await gatherHal(deps, request, worthAsking);

  const decision = decide({ request, now_s: Math.floor(now / 1000), owner, policy, spent, hal });
  return { request, owner, policy, hal, decision, now };
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

  const a = await assess(parsed.request, deps);
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
  let result: T | undefined;
  let toolError: string | undefined;
  try {
    result = await tool();
  } catch (e) {
    toolError = e instanceof Error ? e.name : 'Error'; // the class of failure, never its message
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
      : { ...a.decision, reasons: [...a.decision.reasons, { code: 'tool_error', detail: `the tool ran and threw (${toolError})` }] };

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
  if (toolError === undefined) out.result = result as T;
  else out.tool_error = toolError;
  return out;
}

export interface DryDecision {
  verdict: DecisionLeg['verdict'];
  blocking: boolean;
  /** Always false: a dry decision writes nothing and runs nothing. */
  persisted: false;
  decision: DecisionLeg;
  /** A well-formed, validated kernel-receipt/1 for this decision. NOT chained and NOT in the ledger. */
  receipt_preview: KernelReceipt | null;
  reasons: Reason[];
}

/** decide() without the side effects: nothing is written and nothing runs. Backs POST /decide. */
export async function dryDecision(rawRequest: unknown, deps: GateDeps): Promise<DryDecision | { malformed: Reason[] }> {
  const parsed = parseKernelRequest(rawRequest);
  if (!parsed.ok) return { malformed: parsed.reasons };
  const a = await assess(parsed.request, deps);
  const env = deps.env ?? DEFAULT_ENV;
  let preview: KernelReceipt | null = null;
  try {
    const candidate = buildReceipt({
      receipt_id: (deps.newId ?? randomUUID)(),
      prev: null,
      created_at: new Date(a.now).toISOString(),
      env,
      request: a.request,
      owner: a.owner,
      decision: a.decision,
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
    decision: a.decision,
    receipt_preview: preview,
    reasons: a.decision.reasons,
  };
}
