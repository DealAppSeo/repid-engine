/**
 * contract-party-guard.ts — close the authorization hole for callers that have no
 * agent identity at all.
 *
 * ════════════════════════════════════════════════════════════════════════════════
 * THE GAP, EXACTLY
 * ════════════════════════════════════════════════════════════════════════════════
 * `auth.ts` already refuses a bound key that is not a party to a contract — that check
 * was added 2026-07-30 and it is correct. But the entire block it lives in is nested
 * inside `if (dbAgentId) { … }`, and `dbAgentId` is set ONLY for a key issued from the
 * database and bound to one agent.
 *
 * A shared `REPID_API_KEYS` environment key authenticates perfectly well and leaves
 * `dbAgentId` undefined. Every line of party checking is therefore skipped. The caller
 * is authenticated, unidentified, and unrestricted on somebody else's contract.
 *
 * Two of the six contract mutations noticed and defend themselves — `/fulfill` and
 * `/satisfy` return `unbound_caller`. **`/escrow`, `/cancel`, `/dispute` and
 * `/resolve` do not.** `/escrow` is the money one: with `X402_ENFORCEMENT_ENABLED`
 * unset — and it is compared against the literal string `'true'`, so unset means OFF —
 * the legacy branch moves a contract `pending → escrowed` with no payment.
 *
 * Found by the MARKETPLACE lane, which correctly reported it instead of reaching
 * outside its fence.
 *
 * ════════════════════════════════════════════════════════════════════════════════
 * WHY THIS IS A SEPARATE MODULE AND NOT AN EDIT TO THE EXISTING CHECK
 * ════════════════════════════════════════════════════════════════════════════════
 * The bound-key path is correct and load-bearing; changing it risks breaking the A2A
 * lifecycle that the 2026-07-30 fix restored. This adds the MISSING branch — the one
 * that runs when there is no bound identity — and leaves the working one untouched.
 * Fix only what is named.
 *
 * ════════════════════════════════════════════════════════════════════════════════
 * SHADOW FIRST, BECAUSE ENFORCING IS A LIVE BEHAVIOUR CHANGE
 * ════════════════════════════════════════════════════════════════════════════════
 * `off` is byte-identical to today. `shadow` logs what it WOULD refuse and refuses
 * nothing — so the real question ("does any legitimate integration still drive
 * contracts with a shared env key?") gets answered from traffic instead of from
 * argument. `enforce` refuses.
 *
 * That ordering matters here more than usual: this is the path a real buyer uses to
 * put money behind a contract. Turning it off wrongly is an outage on the revenue
 * path; leaving it open is an authorization hole. Measure, then choose.
 *
 * The refusal reuses the `unbound_caller` code that `/fulfill` and `/satisfy` already
 * return, so the API keeps one vocabulary for one condition.
 */

export type PartyEnforcementMode = 'off' | 'shadow' | 'enforce';

export const PARTY_ENFORCEMENT_ENV = 'CONTRACT_PARTY_ENFORCEMENT';

export function parsePartyMode(raw: string | undefined | null): PartyEnforcementMode {
  const v = (raw ?? '').trim().toLowerCase();
  if (v === 'enforce') return 'enforce';
  if (v === 'shadow') return 'shadow';
  return 'off';
}

export function partyEnforcementMode(): PartyEnforcementMode {
  return parsePartyMode(process.env[PARTY_ENFORCEMENT_ENV]);
}

/**
 * Contract paths, with or without the `/api/v1` prefix — both mount points exist.
 * Captures the contract id and the action so a refusal can name what it refused.
 */
const CONTRACT_PATH =
  /^(?:\/api\/v1)?\/contracts\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:\/([a-z-]+))?\/?$/i;

/**
 * Methods that can change a contract's state.
 *
 * GET is deliberately absent. A read by an unidentified caller is a different and much
 * smaller problem, and blocking reads here would break the marketplace status
 * endpoints without closing the hole that matters.
 */
const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

export interface UnboundAccessAssessment {
  /** True when this request is an unidentified caller mutating a contract. */
  isUnboundContractMutation: boolean;
  contractId: string | null;
  action: string | null;
  mode: PartyEnforcementMode;
  /** True only when the request should actually be refused. */
  refuse: boolean;
  reason: string | null;
}

/**
 * Assess one request. Pure — no express, no database, no I/O — so the rule can be
 * tested exhaustively without standing up the app.
 *
 * `hasBoundAgent` is the whole hinge: when the caller HAS a bound agent, the existing
 * party check in `auth.ts` already handled them and this must stay out of the way.
 */
export function assessUnboundContractAccess(input: {
  path: string;
  method: string;
  hasBoundAgent: boolean;
  mode?: PartyEnforcementMode;
}): UnboundAccessAssessment {
  const mode = input.mode ?? partyEnforcementMode();
  const base: UnboundAccessAssessment = {
    isUnboundContractMutation: false,
    contractId: null,
    action: null,
    mode,
    refuse: false,
    reason: null,
  };

  // A bound key is already covered. Saying so explicitly keeps the two paths from
  // ever both claiming responsibility.
  if (input.hasBoundAgent) return base;

  if (!MUTATING.has(input.method.toUpperCase())) return base;

  const m = CONTRACT_PATH.exec(input.path.split('?')[0] ?? input.path);
  if (!m) return base;

  const contractId = m[1] ?? null;
  const action = m[2] ?? null;

  const assessment: UnboundAccessAssessment = {
    ...base,
    isUnboundContractMutation: true,
    contractId,
    action,
    refuse: mode === 'enforce',
    reason:
      `caller is authenticated but has no bound agent identity, so it cannot be ` +
      `checked against this contract's buyer or provider`,
  };
  return assessment;
}

/** The body returned on a refusal — same shape and code `/fulfill` already uses. */
export function unboundRefusalBody(a: UnboundAccessAssessment) {
  return {
    error: 'unbound_caller',
    message:
      `This API key is not bound to an agent, so it cannot act on contract ` +
      `${a.contractId}${a.action ? ` (${a.action})` : ''}. Use an agent-issued key.`,
    contract_id: a.contractId,
    action: a.action,
  };
}

/**
 * One line per observation, so a shadow run can be counted from logs.
 *
 * Deliberately loud and greppable: the point of shadow mode is to find out whether any
 * real integration still does this, and a quiet log answers nothing.
 */
export function partyGuardLogLine(a: UnboundAccessAssessment): string {
  return (
    `[contract-party-guard] ${a.refuse ? 'REFUSED' : 'WOULD-REFUSE'} ` +
    `mode=${a.mode} contract=${a.contractId} action=${a.action ?? 'root'} — ${a.reason}`
  );
}
