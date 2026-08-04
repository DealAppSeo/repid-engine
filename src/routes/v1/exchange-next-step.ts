/**
 * exchange-next-step.ts — whose turn is it, and what exactly do they call?
 *
 * THE GAP THIS EXISTS FOR.
 *
 * A marketplace offer that is accepted, or an RFQ bid that is awarded, produces a
 * `service_contracts` row at status 'pending'. RepID only moves at the far end of
 * a three-call chain the caller has to already know:
 *
 *     pending  --POST /contracts/:id/escrow (buyer, X-PAYMENT)-->  escrowed
 *     escrowed --POST /contracts/:id/fulfill (provider)        -->  fulfilled
 *     fulfilled--POST /contracts/:id/satisfy (buyer)           -->  settled + RepID
 *
 * Nothing server-side walks that chain for anyone, and nothing tells a party they
 * are the one holding it up. The cost is visible in production: at the time this
 * was written 148 of 184 service_contracts sat at 'fulfilled' — delivered, unpaid,
 * and no settle-side RepID for the provider — the oldest from 2026-05-18 and the
 * newest from the day before. The escrowed→fulfilled edge has a drain (the cascade
 * settlement worker); fulfilled→settled has none, because only the buyer can
 * release, and the buyer was never told.
 *
 * So this module answers one question, purely and without IO: given the facts of a
 * contract, what is the stage, whose turn is it, what is the exact next call, and
 * what would refuse it. It is a description of the state machine already
 * implemented in routes/v1/contracts.ts — deliberately a mirror, never a second
 * implementation. It writes nothing and authorizes nothing.
 *
 * D-095: an EIP-3009 authorization is a SIGNATURE, not a transfer. Nothing here
 * may say funds are held. `authorization_taken` is the honest word, and the
 * accompanying note says plainly that verification is not a lock.
 */

export type ExchangeStage =
  | 'pending'
  | 'escrowed'
  | 'fulfilled'
  | 'satisfied'
  | 'settled'
  | 'disputed'
  | 'resolved'
  | 'cancelled'
  | 'unknown';

/** Which party the next call belongs to. */
export type Turn = 'buyer' | 'provider' | 'nobody';

/** A refusal the next call can hit, and the condition that produces it. */
export interface Refusal {
  /** The `error` string the route actually returns. */
  code: string;
  when: string;
}

export interface ExchangeFacts {
  /** service_contracts.status */
  status: string;
  /** agent_services.service_type of the contract's service. */
  serviceType: string | null;
  /** True when this service_type has a registered handler (direct fulfill refused). */
  handlerDelivered: boolean;
  /** service_contracts.x402_payment_id is present. */
  hasPaymentAuthorization: boolean;
  /** service_contracts.settled_at (ISO) or null. */
  settledAt: string | null;
  /** (service_contracts.result).verdict, upper-cased, or null. */
  resultVerdict: string | null;
  /** X402_SETTLE_ON_DELIVERY — pay-on-verified-delivery rather than pay-at-escrow. */
  settleOnDelivery: boolean;
  /** X402_ENFORCEMENT_ENABLED — a real X-PAYMENT header is required at escrow. */
  enforcementEnabled: boolean;
  /** Epoch ms, injected so the outcome window is testable. */
  now: number;
}

export interface NextStep {
  stage: ExchangeStage;
  turn: Turn;
  /** null when nobody has to act. */
  action: {
    method: 'POST';
    path: string;
    /** Body fields the route requires. */
    body: Record<string, string>;
    /** Headers the route requires beyond auth. */
    headers: string[];
  } | null;
  /** Plain-language statement of what happens when the action is taken. */
  why: string;
  refusals: Refusal[];
  /** No further call advances this exchange. */
  terminal: boolean;
  /** Set when the contract is settled and the optional outcome rating is in play. */
  optional_next?: {
    method: 'POST';
    path: string;
    body: Record<string, string>;
    turn: Turn;
    opens_at: string | null;
    expires_at: string | null;
    open_now: boolean;
    why: string;
  };
}

/** The T3 outcome window, mirroring routes/v1/contracts.ts. */
const OUTCOME_WINDOW_OPEN_MS = 24 * 60 * 60 * 1000;
const OUTCOME_WINDOW_CLOSE_MS = 7 * 24 * 60 * 60 * 1000;

const KNOWN_STAGES: ReadonlySet<string> = new Set([
  'pending',
  'escrowed',
  'fulfilled',
  'satisfied',
  'settled',
  'disputed',
  'resolved',
  'cancelled',
]);

export function toStage(status: string | null | undefined): ExchangeStage {
  const s = String(status ?? '').trim().toLowerCase();
  return KNOWN_STAGES.has(s) ? (s as ExchangeStage) : 'unknown';
}

/**
 * The next call, derived from the contract's own facts.
 *
 * Every refusal listed here is one that routes/v1/contracts.ts actually returns —
 * if a code appears here that the route does not emit, this description has drifted
 * and is worse than nothing.
 */
export function describeNextStep(facts: ExchangeFacts): NextStep {
  const stage = toStage(facts.status);
  const id = ':id';

  switch (stage) {
    case 'pending':
      return {
        stage,
        turn: 'buyer',
        action: {
          method: 'POST',
          path: `/api/v1/contracts/${id}/escrow`,
          body: {},
          headers: facts.enforcementEnabled
            ? ['X-PAYMENT: base64 EIP-3009 transferWithAuthorization payload']
            : [],
        },
        why: facts.settleOnDelivery
          ? 'The buyer presents a payment authorization. It is verified and recorded, and NOT broadcast — ' +
            'no funds move here. Settlement happens after the deliverable is verified.'
          : 'The buyer presents a payment authorization at escrow.',
        refusals: [
          { code: 'contract_not_found', when: 'no contract with that id' },
          { code: 'wrong_status', when: 'the contract has already left pending' },
          { code: 'Payment required', when: 'no X-PAYMENT header, while X402_ENFORCEMENT_ENABLED=true' },
          { code: 'payment_already_used', when: 'that X-PAYMENT header was already settled (replay)' },
          {
            code: 'per_contract_cap_exceeded / daily_cumulative_cap_exceeded',
            when: 'the price or the day\'s volume is over the configured value cap',
          },
        ],
        terminal: false,
      };

    case 'escrowed': {
      const handlerPath = '/api/v1/agent/process-contracts';
      return {
        stage,
        turn: 'provider',
        action: {
          method: 'POST',
          path: facts.handlerDelivered ? handlerPath : `/api/v1/contracts/${id}/fulfill`,
          body: facts.handlerDelivered ? {} : { result: 'the deliverable, including its verdict' },
          headers: [],
        },
        why: facts.handlerDelivered
          ? `'${facts.serviceType}' is delivered by a registered handler, so it goes through the handler path ` +
            'where the PCP/HAL verdict gate actually runs. A self-declared result would make the buyer\'s ' +
            'verdict equal to whatever the provider typed.'
          : 'The provider delivers the work. No handler is registered for this service type, so the ' +
            'deliverable is submitted directly.',
        refusals: [
          { code: 'unbound_caller', when: 'a shared tier API key was used — delivery requires an agent-bound key' },
          { code: 'not_the_provider', when: 'the caller is not the provider named on the contract' },
          {
            code: 'handler_delivery_required',
            when: 'this service type has a handler and direct fulfill was attempted (ALLOW_DIRECT_FULFILL off)',
          },
        ],
        terminal: false,
      };
    }

    case 'fulfilled':
      return {
        stage,
        turn: 'buyer',
        action: {
          method: 'POST',
          path: `/api/v1/contracts/${id}/satisfy`,
          body: { satisfaction_score: 'number' },
          headers: [],
        },
        why: facts.settleOnDelivery
          ? 'THIS IS THE CALL THAT MOVES MONEY AND REPID. The buyer accepts the verified deliverable and the ' +
            'authorization taken at escrow is broadcast. Reject it instead and the authorization is voided — ' +
            'nothing is transferred and the buyer keeps the funds.'
          : 'The buyer accepts the deliverable; the contract settles and RepID is applied to both sides.',
        refusals: [
          { code: 'unbound_caller', when: 'a shared tier API key was used — releasing payment requires an agent-bound key' },
          { code: 'self_satisfaction_forbidden', when: 'the provider tried to accept its own deliverable' },
          { code: 'not_the_buyer', when: 'the caller is not the buyer named on the contract' },
          {
            code: 'deliverable_rejected',
            when: `the result verdict is not PASS or satisfaction_score is not positive (verdict here: ${
              facts.resultVerdict ?? 'NONE'
            })`,
          },
          { code: 'payment_release_failed', when: 'the deliverable passed but the transfer could not be broadcast' },
        ],
        terminal: false,
      };

    case 'satisfied':
      return {
        stage,
        turn: 'nobody',
        action: null,
        why:
          'The deliverable was accepted and the settlement is finalizing. This is an intermediate state the ' +
          'settle path writes on its way to settled; no party call advances it.',
        refusals: [],
        terminal: false,
      };

    case 'settled': {
      const settledMs = facts.settledAt ? Date.parse(facts.settledAt) : NaN;
      const haveWindow = Number.isFinite(settledMs);
      const opensAt = haveWindow ? new Date(settledMs + OUTCOME_WINDOW_OPEN_MS) : null;
      const expiresAt = haveWindow ? new Date(settledMs + OUTCOME_WINDOW_CLOSE_MS) : null;
      const openNow =
        opensAt !== null &&
        expiresAt !== null &&
        facts.now >= opensAt.getTime() &&
        facts.now <= expiresAt.getTime();

      return {
        stage,
        turn: 'nobody',
        action: null,
        why:
          'The exchange is complete. Payment settled and RepID was applied to both sides. Nothing further is ' +
          'required of either party.',
        refusals: [],
        terminal: true,
        optional_next: {
          method: 'POST',
          path: `/api/v1/contracts/${id}/outcome`,
          body: { rating: "'good' | 'ok' | 'bad'", rater_agent_id: 'the buyer agent id', note: 'optional' },
          turn: 'buyer',
          opens_at: opensAt ? opensAt.toISOString() : null,
          expires_at: expiresAt ? expiresAt.toISOString() : null,
          open_now: openNow,
          why:
            'Optional and absence-neutral: the buyer may report whether the work held up in use, 24h to 7d after ' +
            'settlement. Only an actual rating moves RepID; not rating costs nobody anything.',
        },
      };
    }

    case 'disputed':
      return {
        stage,
        turn: 'nobody',
        action: null,
        why:
          'The exchange is in dispute and sits with the dispute validation queue. Neither party advances it by ' +
          'calling the exchange path; resolution arrives through POST /api/v1/contracts/:id/resolve.',
        refusals: [],
        terminal: false,
      };

    case 'resolved':
      return {
        stage,
        turn: 'nobody',
        action: null,
        why: 'A dispute on this exchange was resolved. It does not re-enter the settle path.',
        refusals: [],
        terminal: true,
      };

    case 'cancelled':
      return {
        stage,
        turn: 'nobody',
        action: null,
        why: 'This exchange was cancelled. No money moved and no RepID was applied.',
        refusals: [],
        terminal: true,
      };

    default:
      return {
        stage: 'unknown',
        turn: 'nobody',
        action: null,
        why:
          `The contract is in status '${facts.status}', which is not a stage of the exchange path this surface ` +
          'describes. Reporting a guess here would be worse than reporting that it does not know.',
        refusals: [],
        terminal: false,
      };
  }
}

/**
 * A listing's `kind` decides who pays, and getting it backwards pays the wrong
 * party. Mirrors services/listing-bridge.resolveRoles; kept here so the read
 * surface never has to import the write path.
 */
export function offerRoles(kind: string): { buyer: 'poster' | 'offerer'; provider: 'poster' | 'offerer' } | null {
  if (kind === 'have') return { buyer: 'offerer', provider: 'poster' };
  if (kind === 'want') return { buyer: 'poster', provider: 'offerer' };
  return null;
}

/** What a viewer is on a contract, given every agent id they act as. */
export function viewerRole(
  contract: { buyer_agent_id: string; provider_agent_id: string },
  viewerAgentIds: readonly string[],
): 'buyer' | 'provider' | null {
  const mine = new Set(viewerAgentIds.map((x) => String(x).trim().toLowerCase()).filter(Boolean));
  if (mine.has(String(contract.buyer_agent_id).trim().toLowerCase())) return 'buyer';
  if (mine.has(String(contract.provider_agent_id).trim().toLowerCase())) return 'provider';
  return null;
}

/**
 * The one sentence that must never become "funds are held" (D-095). Verification
 * is not a lock: an EIP-3009 authorization is a signature the payer can still
 * invalidate, and calling it custody would be a claim the system cannot back.
 */
export const AUTHORIZATION_NOTE =
  'Escrow takes a payment AUTHORIZATION (an EIP-3009 signature), not a transfer. No funds have moved and none ' +
  'are locked — verification is not custody. Payment is broadcast only when the buyer accepts a verified ' +
  'deliverable, and a rejected deliverable costs nothing on-chain.';
