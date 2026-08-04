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

/* ══════════════════════════════════════════════════════════════════════════════
 * THE SAME HOLE, ONE RESOURCE UPSTREAM: SERVICE LISTINGS
 * ══════════════════════════════════════════════════════════════════════════════
 * The guard above closes `/contracts/<uuid>/…`. It does not close the listings
 * those contracts are created FROM, and there the nesting bug is not merely a
 * gap — it is INVERTED. On `PATCH /services/<id>` and `DELETE /services/<id>`
 * the bound-key path fails the generic path-UUID equality check in `auth.ts`
 * (a service id is a UUID and is never equal to the caller's agent id), so an
 * identified agent is refused on every row INCLUDING ITS OWN. The unidentified
 * caller skips that check with the rest of the block and reaches every row.
 * The only caller who can mutate a listing is the one nobody can attribute.
 *
 * On `POST /services` the shape is the ordinary one: `provider_agent_id` comes
 * from the body, `auth.ts` checks it against the bound identity (it is in
 * IDENTITY_FIELDS), and an unbound caller is not checked at all — so a listing
 * can be created under another agent's provider identity.
 *
 * Why this is worth closing and not just noting: the listing row is read back
 * as authority at award time. `routes/v1/negotiation.ts` re-asserts `active`
 * and `min_repid_to_purchase` from `agent_services` when a buyer accepts a bid
 * (`service_inactive` / `buyer_repid_below_service_minimum`). So flipping one
 * boolean on a rival's row denies an award that was already won — no forged
 * identity, no signature, no payment involved. `agent_services.provider_agent_id`
 * is a NOT NULL uuid and is the ownership column (verified against
 * information_schema, not the generated types, which are stale).
 *
 * SAME SWITCH, DELIBERATELY. The condition is identical — an authenticated
 * caller with no bound agent identity performing an identity-scoped mutation —
 * so this reads `CONTRACT_PARTY_ENFORCEMENT` rather than adding a second knob.
 * One shadow run measures both surfaces; one flip enforces both. A second flag
 * for the same condition is how half a rule ends up enabled.
 *
 * The bound-key path is again untouched: `hasBoundAgent` short-circuits first.
 * Note that this means the INVERTED refusal above is NOT fixed here — a bound
 * agent still cannot edit its own listing. That is a real defect, it lives in
 * the load-bearing bound-key block, and widening that block is exactly the
 * change this lane was told not to make. It is reported, not patched.
 */

/** `/services/<uuid>` — the mutate/delist target. Both mount prefixes. */
const SERVICE_ITEM_PATH =
  /^(?:\/api\/v1)?\/services\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/?$/i;

/** `/services` — the collection root, where a listing is created. */
const SERVICE_COLLECTION_PATH = /^(?:\/api\/v1)?\/services\/?$/i;

export type ServiceMutationAction = 'create' | 'update' | 'delist';

export interface UnboundServiceAssessment {
  /** True when this request is an unidentified caller mutating a service listing. */
  isUnboundServiceMutation: boolean;
  serviceId: string | null;
  action: ServiceMutationAction | null;
  mode: PartyEnforcementMode;
  /**
   * True only when the observation should be LOGGED — i.e. `shadow` or `enforce`.
   *
   * Deliberately different from `assessUnboundContractAccess`, which its caller
   * logs whenever it matches, including at `off`. That means a listing mutation
   * would start emitting warn lines in production the moment this merged, with
   * no flag flipped — and it would make `shadow` unmeasurable, because `off`
   * would already produce the identical line. `off` here means off: silent,
   * behaviourally identical, nothing to grep. Logging is what you opt INTO.
   *
   * (That the contract assessor logs at `off` is a real inconsistency, but it
   * belongs to the PR that added it and is reported rather than changed here.)
   */
  observe: boolean;
  /** True only when the request should actually be refused. */
  refuse: boolean;
  reason: string | null;
}

/**
 * Assess one request against the service-listing surface. Pure — no express, no
 * database, no I/O.
 *
 * Only the three shapes that correspond to real routes are matched
 * (`POST /services`, `PATCH /services/<id>`, `DELETE /services/<id>`). Flagging
 * shapes that 404 anyway would only add noise to the shadow log that has to be
 * read to make the enforce decision.
 *
 * GET is absent for the same reason it is absent above, and more so here:
 * `/services` browse and `/services/<id>` detail are the marketplace discovery
 * surface — `/services/<id>/manifest.json` is even mounted BEFORE auth on the
 * stated grounds that a discovery surface behind a key is not a discovery
 * surface. Blocking reads would break discovery without closing anything.
 */
export function assessUnboundServiceMutation(input: {
  path: string;
  method: string;
  hasBoundAgent: boolean;
  mode?: PartyEnforcementMode;
}): UnboundServiceAssessment {
  const mode = input.mode ?? partyEnforcementMode();
  const base: UnboundServiceAssessment = {
    isUnboundServiceMutation: false,
    serviceId: null,
    action: null,
    mode,
    observe: false,
    refuse: false,
    reason: null,
  };

  // A bound key is the other path's responsibility. Stated explicitly so the two
  // can never both claim one request.
  if (input.hasBoundAgent) return base;

  const method = input.method.toUpperCase();
  const path = input.path.split('?')[0] ?? input.path;

  let serviceId: string | null = null;
  let action: ServiceMutationAction | null = null;

  if (method === 'POST' && SERVICE_COLLECTION_PATH.test(path)) {
    action = 'create';
  } else {
    const m = SERVICE_ITEM_PATH.exec(path);
    if (m) {
      if (method === 'PATCH') action = 'update';
      else if (method === 'DELETE') action = 'delist';
      if (action) serviceId = m[1] ?? null;
    }
  }

  if (!action) return base;

  return {
    ...base,
    isUnboundServiceMutation: true,
    serviceId,
    action,
    observe: mode !== 'off',
    refuse: mode === 'enforce',
    reason:
      action === 'create'
        ? `caller is authenticated but has no bound agent identity, so the ` +
          `provider_agent_id it declares for this listing cannot be checked ` +
          `against it`
        : `caller is authenticated but has no bound agent identity, so it cannot ` +
          `be checked against this listing's provider`,
  };
}

/** Refusal body — same `unbound_caller` code, so one condition keeps one name. */
export function unboundServiceRefusalBody(a: UnboundServiceAssessment) {
  return {
    error: 'unbound_caller',
    message:
      a.action === 'create'
        ? `This API key is not bound to an agent, so it cannot create a service ` +
          `listing on another agent's behalf. Use an agent-issued key.`
        : `This API key is not bound to an agent, so it cannot ${a.action} service ` +
          `listing ${a.serviceId}. Use an agent-issued key.`,
    service_id: a.serviceId,
    action: a.action,
  };
}

/**
 * Same `[contract-party-guard]` prefix and same REFUSED/WOULD-REFUSE verbs as the
 * contract line, so the single grep that answers "is anything still doing this?"
 * covers both surfaces. `resource=` tells them apart.
 */
export function serviceGuardLogLine(a: UnboundServiceAssessment): string {
  return (
    `[contract-party-guard] ${a.refuse ? 'REFUSED' : 'WOULD-REFUSE'} ` +
    `resource=service mode=${a.mode} service=${a.serviceId ?? 'new'} ` +
    `action=${a.action} — ${a.reason}`
  );
}
