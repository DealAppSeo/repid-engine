/**
 * a2a-negotiation.ts — RFQ → sealed bids → bounded counter-rounds → single award.
 *
 * WHAT THIS EXISTS TO FIX
 * -----------------------
 * `service_contracts.agreed_price_usdc_raw` is a misnomer today. `POST
 * /api/v1/contracts` (src/routes/v1/contracts.ts:91) takes whatever number the
 * buyer put in the body and calls it "agreed". Nothing was agreed; one party
 * asserted a price. This module makes the word true: the accept request has NO
 * price field anywhere in its body type, and the contract price is read
 * server-side out of the referenced `a2a_bid_rounds` row whose `offer_hash` is
 * recomputed and must match.
 *
 * WHAT THIS DOES **NOT** DO — read this before quoting it at anyone
 * -----------------------------------------------------------------
 * 1. It does NOT prevent collusion. Two independently-keyed identities may
 *    transact at any price they both accept. What is retained is every losing
 *    offer plus a frozen decision snapshot, so a suspicious award is
 *    *inspectable*. A two-agent wash trade under one operator still produces a
 *    clean-looking record; the mitigations here (price floor, buyer↔provider
 *    relatedness flag, award-concentration counters, forced written reason on
 *    every uncontested award) raise its cost and make it *countable*, not
 *    impossible.
 * 2. It does NOT gate post-award delivery validation. An earlier draft of this
 *    design claimed `evaluateCosign` (src/services/cosign-consumer.ts) would
 *    keep the counterparty from validating its own delivery. **That claim was
 *    false and is retracted here.** That module reads only `trinity_tasks`, is
 *    reachable only from `scripts/dispatch/cosign-consumer.ts`, and is gated
 *    behind `COSIGN_CONSUMER_ENABLED` (default false, explicitly not wired into
 *    the boot path). It cannot see a `service_contract`. The real validator on
 *    the contract path is the BUYER, via `POST /contracts/:id/satisfy` and the
 *    T3 outcome rating — i.e. counterparty self-validation, unguarded. Every
 *    award response says so in `post_award_validation`.
 * 3. RepID reward is PRICE-DECOUPLED. `applyServiceFulfilledDeltas` /
 *    `applyServiceSatisfiedDeltas` / `applyServiceOutcomeDeltas` contain no
 *    price term. A $0.01 contract pays the same RepID as a $10 one. A
 *    system-wide minimum price (`A2A_MIN_PRICE_USDC_RAW`, default 10_000 raw =
 *    $0.01) exists solely to stop a 1-raw-unit RepID minting loop; it does not
 *    make RepID value-weighted. Every response carries
 *    `repid_reward_price_coupled: false` so nobody reads a negotiated contract
 *    as evidence of economic value.
 * 4. `offer_hash` is an UNKEYED sha256 over the row's own fields. It detects
 *    mutation by anyone without write access; it proves nothing against a
 *    writer who can UPDATE the row (the table owner is not bound by the
 *    REVOKE). The only real counterparty attestation available is an actor
 *    signature over the offer tuple, verified against the agent's own
 *    `signing_address` / `wallet_address` — supported here and reported as
 *    `attestation_level: 'counterparty_signed'`. Without it the honest label is
 *    `'server_attested'`, and that is what is stored.
 *
 * RepID-NEUTRAL BY CONSTRUCTION: nothing in this module calls `updateRepId`,
 * writes `repid_score_events`, or enqueues `repid_proof_queue`. Bidding,
 * countering, withdrawing and losing move no score — otherwise bid volume is a
 * farming strategy. RepID moves only downstream on the awarded contract via the
 * existing fulfilled/satisfied/outcome/dispute path.
 *
 * ATOMICITY: the accept is a single Postgres function call
 * (`a2a_accept_and_award`). PostgREST gives one transaction per call, so the
 * CAS on the RFQ + the `service_contracts` insert + the `a2a_awards` insert +
 * the losing-bid sweep either all land or none do. Doing this as sequential
 * supabase-js calls would let a rejected `a2a_awards` CHECK leave a live,
 * payable, un-provenanced contract behind — which is the exact bug this feature
 * exists to remove. If the function is not installed the accept fails CLOSED
 * (501); there is no partial-write fallback.
 */
import { createHash } from 'crypto';
import { verifyMessage } from 'ethers';
import { db } from '../db';
import { canonicalJson } from './auditChainWriter';

// ─────────────────────────────────────────────────────────────────────────────
// Config
// ─────────────────────────────────────────────────────────────────────────────

export interface NegotiationConfig {
  /** System-wide minimum price for any bid/counter/award, in raw USDC units. */
  minPriceUsdcRaw: number;
  /** Floor on `a2a_rfqs.min_provider_repid` a buyer may set. */
  minProviderRepidFloor: number;
  /** Concurrent open RFQs a single buyer may hold. */
  maxOpenRfqsPerBuyer: number;
  /** Bids landing within this many seconds of close push the close out. */
  snipeWindowSec: number;
  /** Hard cap on soft-close extensions (mirrors the DB CHECK). */
  maxCloseExtensions: number;
  /** Default lifetime of a single offer round. */
  roundTtlSec: number;
  /** Max lifetime of a single offer round. */
  maxRoundTtlSec: number;
  /** Min/max distance from now for `bids_close_at` / `expires_at`. */
  minWindowSec: number;
  maxWindowSec: number;
  /** Threads a single operator (shared wallet/signing/builder) may hold per RFQ. */
  maxThreadsPerOperator: number;
  /** When false (default) the buyer does not see sealed prices before close. */
  buyerSeesSealedPrices: boolean;
  /** When true, an unsigned round is rejected outright. */
  requireSignedRounds: boolean;
}

function num(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export function negotiationConfig(): NegotiationConfig {
  return {
    minPriceUsdcRaw: num('A2A_MIN_PRICE_USDC_RAW', 10_000),
    minProviderRepidFloor: num('A2A_MIN_PROVIDER_REPID_FLOOR', 1000),
    maxOpenRfqsPerBuyer: num('A2A_MAX_OPEN_RFQS_PER_BUYER', 5),
    snipeWindowSec: num('A2A_SNIPE_WINDOW_SEC', 60),
    maxCloseExtensions: num('A2A_MAX_CLOSE_EXTENSIONS', 3),
    roundTtlSec: num('A2A_ROUND_TTL_SEC', 24 * 60 * 60),
    maxRoundTtlSec: num('A2A_MAX_ROUND_TTL_SEC', 7 * 24 * 60 * 60),
    minWindowSec: num('A2A_MIN_WINDOW_SEC', 60 * 60),
    maxWindowSec: num('A2A_MAX_WINDOW_SEC', 30 * 24 * 60 * 60),
    maxThreadsPerOperator: num('A2A_MAX_THREADS_PER_OPERATOR', 2),
    buyerSeesSealedPrices: (process.env.A2A_BUYER_SEES_SEALED_PRICES || 'false').toLowerCase() === 'true',
    requireSignedRounds: (process.env.A2A_REQUIRE_SIGNED_ROUNDS || 'false').toLowerCase() === 'true',
  };
}

/**
 * Mirrors `checkGlobalValueCaps` in src/routes/v1/contracts.ts (same env vars,
 * same semantics). It is duplicated rather than imported because that function
 * is not exported and this task may not edit that file — see `wiringNeeded`.
 */
export interface ValueCapResult {
  allowed: boolean;
  error?: string;
  cap?: number;
  requested?: number;
}

export function checkValueCaps(priceUsdcRaw: number, settledTodayRaw: number): ValueCapResult {
  const enforcement = process.env.VALUE_CAP_ENFORCEMENT || 'enforce';
  const perContractCapRaw = (Number(process.env.VALUE_CAP_PER_CONTRACT_USDC) || 10) * 1_000_000;
  const dailyCapRaw = (Number(process.env.VALUE_CAP_DAILY_USDC) || 100) * 1_000_000;

  if (enforcement === 'off') return { allowed: true };

  if (priceUsdcRaw > perContractCapRaw) {
    if (enforcement === 'warn') return { allowed: true };
    return { allowed: false, error: 'per_contract_cap_exceeded', cap: perContractCapRaw, requested: priceUsdcRaw };
  }
  if (settledTodayRaw + priceUsdcRaw > dailyCapRaw) {
    if (enforcement === 'warn') return { allowed: true };
    return {
      allowed: false,
      error: 'daily_cumulative_cap_exceeded',
      cap: dailyCapRaw,
      requested: settledTodayRaw + priceUsdcRaw,
    };
  }
  return { allowed: true };
}

// ─────────────────────────────────────────────────────────────────────────────
// Row shapes (live column names — see reports/2026-07-31/E2E_GROUND_TRUTH.md
// for repid_agents / agent_services / service_contracts)
// ─────────────────────────────────────────────────────────────────────────────

export type RfqStatus = 'open' | 'closed' | 'awarded' | 'expired' | 'cancelled';
export type RfqOutcome = 'awarded' | 'expired_no_award' | 'expired_no_bids' | 'cancelled_by_buyer';
export type AwardMode = 'sealed_close' | 'immediate';
export type BidStatus = 'open' | 'countered' | 'withdrawn' | 'accepted' | 'lost' | 'expired' | 'rejected';
export type OfferedBy = 'provider' | 'buyer';
export type AttestationLevel = 'server_attested' | 'counterparty_signed';

export interface RfqRow {
  id: string;
  buyer_agent_id: string;
  service_type: string;
  scope: unknown;
  min_price_usdc_raw: number;
  max_price_usdc_raw: number | null;
  min_provider_repid: number;
  award_mode: AwardMode;
  max_rounds: number;
  max_bids: number;
  bids_close_at: string;
  close_extensions: number;
  expires_at: string;
  deadline_at: string | null;
  status: RfqStatus;
  outcome: RfqOutcome | null;
  created_at: string;
  closed_at: string | null;
}

export interface BidRow {
  id: string;
  rfq_id: string;
  provider_agent_id: string;
  service_id: string;
  status: BidStatus;
  rounds_used: number;
  current_round_id: string | null;
  provider_repid_at_bid: number | null;
  bond_repid: number;
  bond_enforcement: 'not_implemented' | 'recorded' | 'enforced';
  related_bidder_flag: boolean;
  related_to_buyer_flag: boolean;
  created_at: string;
  updated_at: string;
}

export interface RoundRow {
  id: string;
  bid_id: string;
  rfq_id: string;
  round_no: number;
  offered_by: OfferedBy;
  actor_agent_id: string;
  price_usdc_raw: number;
  eta_seconds: number;
  terms: unknown;
  accepts_round_id: string | null;
  offer_hash: string;
  actor_signature: string | null;
  actor_signing_address: string | null;
  signature_verified: boolean;
  attestation_level: AttestationLevel;
  expires_at: string;
  created_at: string;
}

export interface AgentIdentity {
  id: string;
  agent_name?: string | null;
  current_repid?: number | null;
  tier?: string | null;
  lifecycle_status?: string | null;
  wallet_address?: string | null;
  signing_address?: string | null;
  builder_id?: string | null;
  erc8004_address?: string | null;
  erc8004_token_id?: string | null;
  reputation_write_count?: number | null;
  last_reputation_tx_hash?: string | null;
  last_reputation_block_number?: number | null;
  last_reputation_written_at?: string | null;
  mint_tx_hash?: string | null;
  mint_chain_id?: number | null;
}

/** Columns pulled for every counterparty panel. Keep in sync with AgentIdentity. */
export const AGENT_PANEL_COLUMNS =
  'id, agent_name, current_repid, tier, lifecycle_status, wallet_address, signing_address, builder_id, ' +
  'erc8004_address, erc8004_token_id, reputation_write_count, last_reputation_tx_hash, ' +
  'last_reputation_block_number, last_reputation_written_at, mint_tx_hash, mint_chain_id';

// ─────────────────────────────────────────────────────────────────────────────
// Identity binding — route level, NOT delegated to the auth middleware
// ─────────────────────────────────────────────────────────────────────────────

/**
 * `authMiddleware`'s f2-authz check (src/middleware/auth.ts:145-153) resolves
 * ONE target from an OR chain — `agent_id || buyer_agent_id || ... ||
 * provider_agent_id` — so a body carrying both `agent_id` (own, matching) and
 * `provider_agent_id` (a victim's) passes: only the first truthy value is ever
 * compared. Bidding under someone else's identity would poison their delivery
 * record AND, because of UNIQUE(rfq_id, provider_agent_id), permanently lock
 * them out of that RFQ. So every negotiation write compares the claimed id
 * DIRECTLY against the key's bound agent, here.
 */
export function boundAgentId(req: { agent_id?: unknown }): string | null {
  const id = (req as { agent_id?: unknown }).agent_id;
  return typeof id === 'string' && id.trim().length > 0 ? id.trim() : null;
}

export function sameAgent(a: unknown, b: unknown): boolean {
  return (
    typeof a === 'string' &&
    typeof b === 'string' &&
    a.trim().length > 0 &&
    a.trim().toLowerCase() === b.trim().toLowerCase()
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Offer hash + counterparty signature
// ─────────────────────────────────────────────────────────────────────────────

export interface OfferTuple {
  bid_id: string;
  round_no: number;
  offered_by: OfferedBy;
  actor_agent_id: string;
  price_usdc_raw: number;
  eta_seconds: number;
  terms: unknown;
  expires_at: string;
}

/** Canonical, order-fixed serialization of an offer. The hash preimage. */
export function offerPreimage(o: OfferTuple): string {
  return [
    o.bid_id,
    String(o.round_no),
    o.offered_by,
    o.actor_agent_id,
    String(o.price_usdc_raw),
    String(o.eta_seconds),
    canonicalJson(o.terms ?? {}),
    new Date(o.expires_at).toISOString(),
  ].join('|');
}

export function computeOfferHash(o: OfferTuple): string {
  return createHash('sha256').update(offerPreimage(o)).digest('hex');
}

/** The exact string an actor signs. Never the raw preimage — domain-separated. */
export function offerSigningMessage(offerHash: string): string {
  return `A2A-OFFER-v1:${offerHash}`;
}

/** Recompute a stored round's hash. A mismatch means the row was mutated. */
export function verifyStoredOfferHash(round: RoundRow): boolean {
  const recomputed = computeOfferHash({
    bid_id: round.bid_id,
    round_no: round.round_no,
    offered_by: round.offered_by,
    actor_agent_id: round.actor_agent_id,
    price_usdc_raw: Number(round.price_usdc_raw),
    eta_seconds: Number(round.eta_seconds),
    terms: round.terms,
    expires_at: round.expires_at,
  });
  return recomputed === round.offer_hash;
}

/**
 * Verify an actor's signature over the offer hash against an address the agent
 * already published (`signing_address`, else `wallet_address`). Returns the
 * address that was matched, or null. Never throws.
 */
export function verifyOfferSignature(
  offerHash: string,
  signature: string | null | undefined,
  actor: Pick<AgentIdentity, 'signing_address' | 'wallet_address'>,
): { verified: boolean; address: string | null; reason?: string } {
  if (!signature) return { verified: false, address: null, reason: 'no_signature' };
  const candidates = [actor.signing_address, actor.wallet_address]
    .filter((a): a is string => typeof a === 'string' && /^0x[0-9a-fA-F]{40}$/.test(a))
    .filter((a) => a.toLowerCase() !== '0x0000000000000000000000000000000000000000');
  if (candidates.length === 0) return { verified: false, address: null, reason: 'no_published_address' };
  let recovered: string;
  try {
    recovered = verifyMessage(offerSigningMessage(offerHash), signature);
  } catch {
    return { verified: false, address: null, reason: 'malformed_signature' };
  }
  const match = candidates.find((a) => a.toLowerCase() === recovered.toLowerCase());
  return match
    ? { verified: true, address: match }
    : { verified: false, address: null, reason: 'signer_not_bound_to_agent' };
}

// ─────────────────────────────────────────────────────────────────────────────
// Relatedness — a FLAG, never a block. Detection is not claimed to be complete.
// ─────────────────────────────────────────────────────────────────────────────

const ZERO_ADDR = '0x0000000000000000000000000000000000000000';

function normKey(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const t = v.trim().toLowerCase();
  if (t.length === 0 || t === ZERO_ADDR) return null;
  return t;
}

export type IdentityKeyField = 'wallet_address' | 'signing_address' | 'builder_id';

/**
 * Which published identity keys two agents share. Applied bidder↔bidder AND
 * buyer↔bidder — the buyer↔bidder axis is the one that matters for a two-agent
 * wash trade, and an earlier draft omitted it entirely.
 */
export function sharedIdentityKeys(
  a: Pick<AgentIdentity, IdentityKeyField>,
  b: Pick<AgentIdentity, IdentityKeyField>,
): IdentityKeyField[] {
  const fields: IdentityKeyField[] = ['wallet_address', 'signing_address', 'builder_id'];
  return fields.filter((f) => {
    const av = normKey(a[f]);
    const bv = normKey(b[f]);
    return av !== null && bv !== null && av === bv;
  });
}

export function isRelated(
  a: Pick<AgentIdentity, IdentityKeyField>,
  b: Pick<AgentIdentity, IdentityKeyField>,
): boolean {
  return sharedIdentityKeys(a, b).length > 0;
}

/** Operator grouping key for the per-operator thread cap. */
export function operatorFingerprint(a: Pick<AgentIdentity, IdentityKeyField>): string | null {
  return normKey(a.builder_id) ?? normKey(a.signing_address) ?? normKey(a.wallet_address);
}

// ─────────────────────────────────────────────────────────────────────────────
// Window / expiry / round-cap arithmetic (pure)
// ─────────────────────────────────────────────────────────────────────────────

export interface WindowValidationInput {
  bids_close_at: string;
  expires_at: string;
  deadline_at?: string | null;
  now: Date;
  cfg: NegotiationConfig;
}

export function validateWindows(i: WindowValidationInput): { ok: true } | { ok: false; error: string; message: string } {
  const close = Date.parse(i.bids_close_at);
  const expires = Date.parse(i.expires_at);
  if (!Number.isFinite(close) || !Number.isFinite(expires)) {
    return { ok: false, error: 'invalid_window', message: 'bids_close_at and expires_at must be ISO-8601 timestamps' };
  }
  const nowMs = i.now.getTime();
  const minMs = nowMs + i.cfg.minWindowSec * 1000;
  const maxMs = nowMs + i.cfg.maxWindowSec * 1000;
  if (close < minMs) {
    return { ok: false, error: 'window_too_short', message: `bids_close_at must be at least ${i.cfg.minWindowSec}s from now` };
  }
  if (expires > maxMs) {
    return { ok: false, error: 'window_too_long', message: `expires_at must be within ${i.cfg.maxWindowSec}s of now` };
  }
  if (close > expires) {
    return { ok: false, error: 'invalid_window', message: 'bids_close_at must be <= expires_at' };
  }
  if (i.deadline_at) {
    const deadline = Date.parse(i.deadline_at);
    if (!Number.isFinite(deadline)) {
      return { ok: false, error: 'invalid_deadline', message: 'deadline_at must be an ISO-8601 timestamp' };
    }
    if (deadline < close) {
      return { ok: false, error: 'invalid_deadline', message: 'deadline_at cannot precede bids_close_at' };
    }
  }
  return { ok: true };
}

export function isPastBidClose(rfq: Pick<RfqRow, 'bids_close_at'>, now: Date): boolean {
  return now.getTime() >= Date.parse(rfq.bids_close_at);
}

export function isRfqExpired(rfq: Pick<RfqRow, 'expires_at'>, now: Date): boolean {
  return now.getTime() >= Date.parse(rfq.expires_at);
}

/**
 * LAZY EXPIRY. Returns the patch an endpoint should apply on touch, or null.
 * The buyer award ratio is deliberately NOT computed from `status` (see
 * `computeBuyerPanel`) precisely because a harvester can freeze `status` by
 * never touching the row again — this transition is a convenience, never the
 * statistic's source of truth.
 */
export function deriveLazyTransition(
  rfq: Pick<RfqRow, 'status' | 'bids_close_at' | 'expires_at'>,
  bidCount: number,
  now: Date,
): { status: RfqStatus; outcome?: RfqOutcome; closed_at?: string } | null {
  if (rfq.status !== 'open' && rfq.status !== 'closed') return null;
  if (isRfqExpired(rfq, now)) {
    return {
      status: 'expired',
      outcome: bidCount > 0 ? 'expired_no_award' : 'expired_no_bids',
      closed_at: now.toISOString(),
    };
  }
  if (rfq.status === 'open' && isPastBidClose(rfq, now)) {
    return { status: 'closed' };
  }
  return null;
}

/** Total offers allowed on one thread. `max_rounds` counts round-trips. */
export function offerCap(rfq: Pick<RfqRow, 'max_rounds'>): number {
  return rfq.max_rounds * 2;
}

export function roundCapExceeded(bid: Pick<BidRow, 'rounds_used'>, rfq: Pick<RfqRow, 'max_rounds'>): boolean {
  return bid.rounds_used >= offerCap(rfq);
}

/**
 * Soft close. A bid landing inside the snipe window pushes `bids_close_at` out,
 * capped by `close_extensions` so the extension cannot itself be a DoS.
 */
export function applySnipeExtension(
  rfq: Pick<RfqRow, 'bids_close_at' | 'expires_at' | 'close_extensions'>,
  now: Date,
  cfg: NegotiationConfig,
): { bids_close_at: string; expires_at: string; close_extensions: number } | null {
  const closeMs = Date.parse(rfq.bids_close_at);
  const windowMs = cfg.snipeWindowSec * 1000;
  if (now.getTime() < closeMs - windowMs) return null;
  if (now.getTime() >= closeMs) return null;
  if (rfq.close_extensions >= cfg.maxCloseExtensions) return null;
  const newClose = closeMs + windowMs;
  const expiresMs = Date.parse(rfq.expires_at);
  return {
    bids_close_at: new Date(newClose).toISOString(),
    expires_at: new Date(Math.max(expiresMs, newClose)).toISOString(),
    close_extensions: rfq.close_extensions + 1,
  };
}

export function roundExpiry(now: Date, ttlSec: number | undefined, cfg: NegotiationConfig): string {
  const ttl = Math.min(Math.max(Math.floor(ttlSec ?? cfg.roundTtlSec), 60), cfg.maxRoundTtlSec);
  return new Date(now.getTime() + ttl * 1000).toISOString();
}

// ─────────────────────────────────────────────────────────────────────────────
// Price validation
// ─────────────────────────────────────────────────────────────────────────────

export interface PriceCheck {
  ok: boolean;
  error?: string;
  message?: string;
}

export function validatePrice(
  price: unknown,
  rfq: Pick<RfqRow, 'min_price_usdc_raw' | 'max_price_usdc_raw'>,
  cfg: NegotiationConfig,
): PriceCheck {
  if (typeof price !== 'number' || !Number.isInteger(price) || price <= 0) {
    return { ok: false, error: 'invalid_price', message: 'price_usdc_raw must be a positive integer (raw USDC units)' };
  }
  const floor = Math.max(cfg.minPriceUsdcRaw, Number(rfq.min_price_usdc_raw));
  if (price < floor) {
    return {
      ok: false,
      error: 'price_below_floor',
      message:
        `price_usdc_raw ${price} is below the floor ${floor}. RepID reward is price-decoupled, so a ` +
        `sub-cent contract would pay the same reputation as a real one — the floor is what stops that.`,
    };
  }
  if (rfq.max_price_usdc_raw !== null && price > Number(rfq.max_price_usdc_raw)) {
    return { ok: false, error: 'price_above_rfq_max', message: `price_usdc_raw exceeds the RFQ max ${rfq.max_price_usdc_raw}` };
  }
  return { ok: true };
}

export function validateEta(eta: unknown): PriceCheck {
  if (typeof eta !== 'number' || !Number.isInteger(eta) || eta <= 0) {
    return { ok: false, error: 'invalid_eta', message: 'eta_seconds must be a positive integer' };
  }
  if (eta > 365 * 24 * 60 * 60) {
    return { ok: false, error: 'invalid_eta', message: 'eta_seconds may not exceed one year' };
  }
  return { ok: true };
}

// ─────────────────────────────────────────────────────────────────────────────
// Award rationale — structured, and long enough to actually be a reason
// ─────────────────────────────────────────────────────────────────────────────

export const AWARD_REASON_CODES = [
  'faster_eta',
  'better_delivery_record',
  'scope_fit',
  'sole_eligible_bid',
  'risk_concentration',
  'prior_dispute_with_cheaper_bidder',
  'other',
] as const;
export type AwardReasonCode = (typeof AWARD_REASON_CODES)[number];

export const AWARD_RATIONALE_MIN_LENGTH = 24;
export const AWARD_RATIONALE_MAX_LENGTH = 1000;

/**
 * `length(btrim(x)) > 0` is satisfied by "x". A single character is not a
 * reason. A structured code plus real prose is the minimum that makes the
 * permanent record readable by a third party later.
 */
export function validateAwardRationale(
  reasonCode: unknown,
  rationale: unknown,
): { ok: true; reason_code: AwardReasonCode; rationale: string } | { ok: false; error: string; message: string } {
  if (typeof reasonCode !== 'string' || !(AWARD_REASON_CODES as readonly string[]).includes(reasonCode)) {
    return {
      ok: false,
      error: 'invalid_award_reason_code',
      message: `award_reason_code must be one of: ${AWARD_REASON_CODES.join(', ')}`,
    };
  }
  if (typeof rationale !== 'string') {
    return { ok: false, error: 'award_rationale_required', message: 'award_rationale must be a string' };
  }
  const trimmed = rationale.trim();
  if (trimmed.length < AWARD_RATIONALE_MIN_LENGTH) {
    return {
      ok: false,
      error: 'award_rationale_too_short',
      message: `award_rationale must be at least ${AWARD_RATIONALE_MIN_LENGTH} characters of actual explanation`,
    };
  }
  if (trimmed.length > AWARD_RATIONALE_MAX_LENGTH) {
    return {
      ok: false,
      error: 'award_rationale_too_long',
      message: `award_rationale must be at most ${AWARD_RATIONALE_MAX_LENGTH} characters`,
    };
  }
  return { ok: true, reason_code: reasonCode as AwardReasonCode, rationale: trimmed };
}

// ─────────────────────────────────────────────────────────────────────────────
// Sealed-bid visibility (pure — this is the testable core of the seal)
// ─────────────────────────────────────────────────────────────────────────────

export interface BidWithRounds {
  bid: BidRow;
  rounds: RoundRow[];
}

export type ViewerRole = 'buyer' | 'bidder' | 'outsider';

export function viewerRole(rfq: Pick<RfqRow, 'buyer_agent_id'>, bids: BidRow[], viewerAgentId: string): ViewerRole {
  if (sameAgent(rfq.buyer_agent_id, viewerAgentId)) return 'buyer';
  if (bids.some((b) => sameAgent(b.provider_agent_id, viewerAgentId))) return 'bidder';
  return 'outsider';
}

export interface SealedViewResult {
  sealed: boolean;
  viewer_role: ViewerRole;
  visible: BidWithRounds[];
  hidden_count: number;
}

/**
 * SEALED SEMANTICS.
 *  - Before `bids_close_at` a bidder sees ONLY its own thread.
 *  - Before `bids_close_at` the buyer ALSO sees no prices by default
 *    (`A2A_BUYER_SEES_SEALED_PRICES=false`). A buyer that can read every sealed
 *    price in real time can counter its confederate at (lowest_rival − 1) and
 *    produce a genuinely `was_lowest_price=true` award needing no rationale.
 *    That is the leak; withholding is the fix. Set the flag to `true` only with
 *    the counter-before-close gate understood.
 *  - After `bids_close_at` every participant sees every thread.
 *  - Outsiders see nothing (the route 403s before reaching here).
 */
export function filterVisibleBids(params: {
  rfq: Pick<RfqRow, 'buyer_agent_id' | 'bids_close_at' | 'award_mode'>;
  bids: BidWithRounds[];
  viewerAgentId: string;
  now: Date;
  cfg: NegotiationConfig;
}): SealedViewResult {
  const { rfq, bids, viewerAgentId, now, cfg } = params;
  const role = viewerRole(rfq, bids.map((b) => b.bid), viewerAgentId);
  const closed = isPastBidClose(rfq, now);

  if (role === 'outsider') {
    return { sealed: !closed, viewer_role: role, visible: [], hidden_count: bids.length };
  }
  if (closed) {
    return { sealed: false, viewer_role: role, visible: bids, hidden_count: 0 };
  }
  if (role === 'buyer' && cfg.buyerSeesSealedPrices) {
    return { sealed: true, viewer_role: role, visible: bids, hidden_count: 0 };
  }
  const own = bids.filter((b) => sameAgent(b.bid.provider_agent_id, viewerAgentId));
  return { sealed: true, viewer_role: role, visible: own, hidden_count: bids.length - own.length };
}

/** Deterministic ordering. No score, no rank, no recommendation — price then age. */
export function sortBidsDeterministic(bids: BidWithRounds[]): BidWithRounds[] {
  return [...bids].sort((a, b) => {
    const ap = currentOffer(a)?.price_usdc_raw ?? Number.MAX_SAFE_INTEGER;
    const bp = currentOffer(b)?.price_usdc_raw ?? Number.MAX_SAFE_INTEGER;
    if (ap !== bp) return ap - bp;
    const at = Date.parse(a.bid.created_at);
    const bt = Date.parse(b.bid.created_at);
    if (at !== bt) return at - bt;
    return a.bid.id.localeCompare(b.bid.id);
  });
}

export function currentOffer(b: BidWithRounds): RoundRow | null {
  if (b.rounds.length === 0) return null;
  const sorted = [...b.rounds].sort((x, y) => x.round_no - y.round_no);
  const last = sorted[sorted.length - 1];
  return last ?? null;
}

/**
 * Bids still live enough to count as competitors at award time. A thread with
 * no round carries no offer, so it must not inflate `competing_bid_count` — an
 * empty thread would otherwise let a colluding buyer turn a genuinely
 * uncontested award into a "contested" looking one.
 */
export function validCompetingBids(bids: BidWithRounds[]): BidWithRounds[] {
  return bids.filter((b) => (b.bid.status === 'open' || b.bid.status === 'countered') && b.rounds.length > 0);
}

/** The minimum current offer among valid bids, or null. */
export function lowestValidPrice(bids: BidWithRounds[]): number | null {
  const prices = validCompetingBids(bids)
    .map((b) => currentOffer(b)?.price_usdc_raw)
    .filter((p): p is number => typeof p === 'number');
  if (prices.length === 0) return null;
  return prices.reduce((min, p) => (p < min ? p : min), prices[0] as number);
}

// ─────────────────────────────────────────────────────────────────────────────
// Buyer panel — computed from TIMESTAMPS, not from `status`
// ─────────────────────────────────────────────────────────────────────────────

export interface RfqSummaryForPanel {
  status: RfqStatus;
  outcome: RfqOutcome | null;
  expires_at: string;
  bid_count?: number;
}

export interface BuyerPanel {
  rfqs_total: number;
  rfqs_open: number;
  rfqs_closed: number;
  rfqs_awarded: number;
  expired_no_award: number;
  expired_no_bids: number;
  cancelled_by_buyer: number;
  /** awarded / closed, or null when nothing has resolved yet. */
  award_ratio: number | null;
  ratio_basis: 'timestamp';
}

/**
 * Lazy expiry means an abandoned RFQ can sit at `status='open'` forever if the
 * buyer simply never touches it again — so a `status`-based ratio would let a
 * bid harvester keep a perfect record by doing nothing, while a buyer who
 * politely cancels gets penalised. Counting `expires_at < now AND outcome IS
 * NULL` as a lapse removes that incentive.
 */
export function computeBuyerPanel(rfqs: RfqSummaryForPanel[], now: Date): BuyerPanel {
  let open = 0;
  let awarded = 0;
  let expiredNoAward = 0;
  let expiredNoBids = 0;
  let cancelled = 0;

  for (const r of rfqs) {
    if (r.outcome === 'awarded' || r.status === 'awarded') {
      awarded += 1;
      continue;
    }
    if (r.outcome === 'cancelled_by_buyer' || r.status === 'cancelled') {
      cancelled += 1;
      continue;
    }
    if (r.outcome === 'expired_no_bids') {
      expiredNoBids += 1;
      continue;
    }
    if (r.outcome === 'expired_no_award') {
      expiredNoAward += 1;
      continue;
    }
    // outcome IS NULL — decide by the clock, never by the (mutable, lazily
    // written) status column.
    if (now.getTime() >= Date.parse(r.expires_at)) {
      if ((r.bid_count ?? 0) > 0) expiredNoAward += 1;
      else expiredNoBids += 1;
    } else {
      open += 1;
    }
  }

  const closed = awarded + cancelled + expiredNoAward + expiredNoBids;
  return {
    rfqs_total: rfqs.length,
    rfqs_open: open,
    rfqs_closed: closed,
    rfqs_awarded: awarded,
    expired_no_award: expiredNoAward,
    expired_no_bids: expiredNoBids,
    cancelled_by_buyer: cancelled,
    award_ratio: closed > 0 ? awarded / closed : null,
    ratio_basis: 'timestamp',
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Award concentration — the statistic a wash trade cannot hide from
// ─────────────────────────────────────────────────────────────────────────────

export interface AwardEdge {
  buyer_agent_id: string;
  provider_agent_id: string;
  is_uncontested: boolean;
}

export interface ConcentrationStats {
  provider_awards_total: number;
  awards_from_this_buyer: number;
  /** awards_from_this_buyer / provider_awards_total, null when the provider has none. */
  provider_award_share_from_this_buyer: number | null;
  provider_uncontested_awards: number;
  buyer_awards_total: number;
  buyer_awards_to_this_provider: number;
  buyer_uncontested_awards: number;
}

export function computeConcentration(
  edges: AwardEdge[],
  buyerAgentId: string,
  providerAgentId: string,
): ConcentrationStats {
  let providerTotal = 0;
  let fromThisBuyer = 0;
  let providerUncontested = 0;
  let buyerTotal = 0;
  let buyerToThisProvider = 0;
  let buyerUncontested = 0;

  for (const e of edges) {
    const isProvider = sameAgent(e.provider_agent_id, providerAgentId);
    const isBuyer = sameAgent(e.buyer_agent_id, buyerAgentId);
    if (isProvider) {
      providerTotal += 1;
      if (e.is_uncontested) providerUncontested += 1;
      if (isBuyer) fromThisBuyer += 1;
    }
    if (isBuyer) {
      buyerTotal += 1;
      if (e.is_uncontested) buyerUncontested += 1;
      if (isProvider) buyerToThisProvider += 1;
    }
  }

  return {
    provider_awards_total: providerTotal,
    awards_from_this_buyer: fromThisBuyer,
    provider_award_share_from_this_buyer: providerTotal > 0 ? fromThisBuyer / providerTotal : null,
    provider_uncontested_awards: providerUncontested,
    buyer_awards_total: buyerTotal,
    buyer_awards_to_this_provider: buyerToThisProvider,
    buyer_uncontested_awards: buyerUncontested,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Counterparty panels
// ─────────────────────────────────────────────────────────────────────────────

const BASESCAN = process.env.BASESCAN_BASE_URL || 'https://sepolia.basescan.org';

export interface OnChainPanel {
  source: 'recorded';
  note: string;
  erc8004_address: string | null;
  erc8004_token_id: string | null;
  reputation_write_count: number;
  last_reputation_tx_hash: string | null;
  last_reputation_block_number: number | null;
  last_reputation_written_at: string | null;
  mint_tx_hash: string | null;
  mint_chain_id: number | null;
  verify_urls: { last_reputation_tx: string | null; mint_tx: string | null; identity_address: string | null };
}

/**
 * Every on-chain field is labelled `source: 'recorded'`. The engine does NOT
 * chain-read at request time and must not imply that it does — the caller gets
 * a link and can verify for itself.
 */
export function buildOnChainPanel(a: AgentIdentity): OnChainPanel {
  const tx = a.last_reputation_tx_hash ?? null;
  const mint = a.mint_tx_hash ?? null;
  const addr = a.erc8004_address ?? null;
  return {
    source: 'recorded',
    note: 'Recorded by this engine when the write was made. NOT re-read from chain for this response — verify via the URLs.',
    erc8004_address: addr,
    erc8004_token_id: a.erc8004_token_id ?? null,
    reputation_write_count: Number(a.reputation_write_count ?? 0),
    last_reputation_tx_hash: tx,
    last_reputation_block_number: a.last_reputation_block_number ?? null,
    last_reputation_written_at: a.last_reputation_written_at ?? null,
    mint_tx_hash: mint,
    mint_chain_id: a.mint_chain_id ?? null,
    verify_urls: {
      last_reputation_tx: tx ? `${BASESCAN}/tx/${tx}` : null,
      mint_tx: mint ? `${BASESCAN}/tx/${mint}` : null,
      identity_address: addr ? `${BASESCAN}/address/${addr}` : null,
    },
  };
}

export interface DeliveryRecord {
  service_total_fulfilled: number;
  service_total_satisfied: number;
  service_avg_satisfaction: number | null;
  contracts_by_status: Record<string, number>;
  contracts_disputed: number;
  bids_withdrawn: number;
}

export interface CounterpartyPanel {
  agent_id: string;
  agent_name: string | null;
  current_repid: number | null;
  tier: string | null;
  lifecycle_status: string | null;
  onchain: OnChainPanel;
  delivery: DeliveryRecord | null;
  concentration: ConcentrationStats | null;
  related_to_buyer: boolean;
  shared_identity_keys: IdentityKeyField[];
  disclosure: string;
}

export const REPID_DISCLOSURE =
  'RepID gates eligibility to bid and is disclosed in full at the moment of decision. It never adjusts a ' +
  'price, never re-ranks a bid, and this engine never recommends a winner. RepID reward on the resulting ' +
  'contract is price-decoupled.';

// ─────────────────────────────────────────────────────────────────────────────
// DB helpers
// ─────────────────────────────────────────────────────────────────────────────

export interface DbResult<T> {
  data: T | null;
  error: { message: string; code?: string } | null;
}

export async function loadAgent(agentId: string): Promise<AgentIdentity | null> {
  const { data, error } = await db.from('repid_agents').select(AGENT_PANEL_COLUMNS).eq('id', agentId).maybeSingle();
  if (error || !data) return null;
  return data as unknown as AgentIdentity;
}

export async function loadAgents(agentIds: string[]): Promise<Map<string, AgentIdentity>> {
  const map = new Map<string, AgentIdentity>();
  const unique = Array.from(new Set(agentIds.filter((id) => typeof id === 'string' && id.length > 0)));
  if (unique.length === 0) return map;
  const { data, error } = await db.from('repid_agents').select(AGENT_PANEL_COLUMNS).in('id', unique);
  if (error || !data) return map;
  for (const row of data as unknown as AgentIdentity[]) {
    map.set(String(row.id).toLowerCase(), row);
  }
  return map;
}

export async function loadRfq(rfqId: string): Promise<RfqRow | null> {
  const { data, error } = await db.from('a2a_rfqs').select('*').eq('id', rfqId).maybeSingle();
  if (error || !data) return null;
  return data as unknown as RfqRow;
}

export async function loadBidsWithRounds(rfqId: string): Promise<BidWithRounds[]> {
  const { data: bids, error: bErr } = await db.from('a2a_bids').select('*').eq('rfq_id', rfqId);
  if (bErr || !bids) return [];
  const { data: rounds } = await db.from('a2a_bid_rounds').select('*').eq('rfq_id', rfqId);
  const byBid = new Map<string, RoundRow[]>();
  for (const r of ((rounds ?? []) as unknown as RoundRow[])) {
    const key = String(r.bid_id);
    const list = byBid.get(key);
    if (list) list.push(r);
    else byBid.set(key, [r]);
  }
  return (bids as unknown as BidRow[]).map((b) => ({
    bid: b,
    rounds: (byBid.get(String(b.id)) ?? []).sort((x, y) => x.round_no - y.round_no),
  }));
}

/** Applies the lazy expiry transition if one is due. Never throws. */
export async function touchRfqExpiry(rfq: RfqRow, bidCount: number, now: Date): Promise<RfqRow> {
  const patch = deriveLazyTransition(rfq, bidCount, now);
  if (!patch) return rfq;
  try {
    const { data } = await db
      .from('a2a_rfqs')
      .update(patch)
      .eq('id', rfq.id)
      .in('status', ['open', 'closed'])
      .select()
      .maybeSingle();
    if (data) return data as unknown as RfqRow;
  } catch {
    /* lazy expiry is best-effort; the timestamp-based panel does not depend on it */
  }
  return { ...rfq, ...patch } as RfqRow;
}

export async function settledTodayRaw(todayIso: string): Promise<number> {
  const { data } = await db
    .from('x402_settlements')
    .select('amount')
    .eq('status', 'settled')
    .gte('created_at', `${todayIso}T00:00:00.000Z`)
    .lte('created_at', `${todayIso}T23:59:59.999Z`);
  return ((data ?? []) as Array<{ amount: number | null }>).reduce((acc, r) => acc + Number(r.amount ?? 0), 0);
}

export async function loadAwardEdges(buyerAgentId: string, providerAgentId: string): Promise<AwardEdge[]> {
  const { data, error } = await db
    .from('a2a_awards')
    .select('buyer_agent_id, provider_agent_id, is_uncontested')
    .or(`buyer_agent_id.eq.${buyerAgentId},provider_agent_id.eq.${providerAgentId}`);
  if (error || !data) return [];
  return (data as unknown as AwardEdge[]).map((e) => ({
    buyer_agent_id: String(e.buyer_agent_id),
    provider_agent_id: String(e.provider_agent_id),
    is_uncontested: Boolean(e.is_uncontested),
  }));
}

export interface ContractStatusCounts {
  byStatus: Record<string, number>;
  disputed: number;
}

export async function loadProviderContractCounts(providerAgentId: string): Promise<ContractStatusCounts> {
  const { data, error } = await db
    .from('service_contracts')
    .select('status')
    .eq('provider_agent_id', providerAgentId)
    .limit(1000);
  const byStatus: Record<string, number> = {};
  if (error || !data) return { byStatus, disputed: 0 };
  for (const row of data as Array<{ status: string | null }>) {
    const s = row.status ?? 'unknown';
    byStatus[s] = (byStatus[s] ?? 0) + 1;
  }
  return { byStatus, disputed: (byStatus['disputed'] ?? 0) + (byStatus['resolved'] ?? 0) };
}

// ─────────────────────────────────────────────────────────────────────────────
// Decision snapshot
// ─────────────────────────────────────────────────────────────────────────────

export interface SnapshotBidEntry {
  bid_id: string;
  provider_agent_id: string;
  provider_agent_name: string | null;
  service_id: string;
  status: BidStatus;
  rounds_used: number;
  current_round_id: string | null;
  price_usdc_raw: number | null;
  eta_seconds: number | null;
  offer_hash: string | null;
  offer_hash_verified: boolean;
  attestation_level: AttestationLevel | null;
  provider_repid_at_bid: number | null;
  provider_repid_now: number | null;
  provider_tier: string | null;
  provider_lifecycle_status: string | null;
  erc8004_reputation_write_count: number;
  erc8004_last_tx_hash: string | null;
  related_to_other_bidder: boolean;
  related_to_buyer: boolean;
  shared_identity_keys_with_buyer: IdentityKeyField[];
  is_winner: boolean;
}

export interface DecisionSnapshot {
  snapshot_version: 'a2a-negotiation-v1';
  taken_at: string;
  rfq: {
    id: string;
    service_type: string;
    award_mode: AwardMode;
    max_rounds: number;
    min_provider_repid: number;
    min_price_usdc_raw: number;
    max_price_usdc_raw: number | null;
    bids_close_at: string;
    close_extensions: number;
    expires_at: string;
  };
  buyer: {
    agent_id: string;
    agent_name: string | null;
    current_repid: number | null;
    tier: string | null;
  };
  competing_bid_count: number;
  lowest_valid_price_usdc_raw: number | null;
  was_lowest_price: boolean;
  is_uncontested: boolean;
  bids: SnapshotBidEntry[];
  concentration: ConcentrationStats;
  disclosures: {
    repid_reward_price_coupled: false;
    post_award_validation: string;
    collusion_claim: string;
    relatedness_detection: string;
    onchain_fields: string;
  };
}

export const POST_AWARD_VALIDATION_NOTE =
  'counterparty_self_validated — delivery is rated by the BUYER via POST /contracts/:id/satisfy and the T3 ' +
  'outcome rating. There is no disjoint third-party validator on the service_contracts path today. ' +
  'cosign-consumer.ts reads only trinity_tasks and is default-disabled; it does not gate this.';

export const COLLUSION_CLAIM_NOTE =
  'This record does NOT prove the process was competitive. It preserves every competing offer and the ' +
  'identity/relatedness/concentration facts as of the decision, so collusion is countable — not prevented.';

export function buildDecisionSnapshot(params: {
  rfq: RfqRow;
  buyer: AgentIdentity | null;
  bids: BidWithRounds[];
  winnerBidId: string;
  winnerRound: RoundRow;
  agents: Map<string, AgentIdentity>;
  concentration: ConcentrationStats;
  now: Date;
}): DecisionSnapshot {
  const { rfq, buyer, bids, winnerBidId, winnerRound, agents, concentration, now } = params;
  const competing = validCompetingBids(bids);
  const lowest = lowestValidPrice(bids);
  const winnerPrice = Number(winnerRound.price_usdc_raw);

  const bidderFingerprints = competing.map((b) => ({
    id: b.bid.provider_agent_id,
    agent: agents.get(String(b.bid.provider_agent_id).toLowerCase()) ?? null,
  }));

  const entries: SnapshotBidEntry[] = competing.map((b) => {
    const offer = currentOffer(b);
    const agent = agents.get(String(b.bid.provider_agent_id).toLowerCase()) ?? null;
    const relatedToOther =
      agent !== null &&
      bidderFingerprints.some(
        (other) => other.agent !== null && !sameAgent(other.id, b.bid.provider_agent_id) && isRelated(agent, other.agent),
      );
    const sharedWithBuyer = agent !== null && buyer !== null ? sharedIdentityKeys(agent, buyer) : [];
    return {
      bid_id: b.bid.id,
      provider_agent_id: b.bid.provider_agent_id,
      provider_agent_name: agent?.agent_name ?? null,
      service_id: b.bid.service_id,
      status: b.bid.status,
      rounds_used: b.bid.rounds_used,
      current_round_id: offer?.id ?? null,
      price_usdc_raw: offer ? Number(offer.price_usdc_raw) : null,
      eta_seconds: offer ? Number(offer.eta_seconds) : null,
      offer_hash: offer?.offer_hash ?? null,
      offer_hash_verified: offer ? verifyStoredOfferHash(offer) : false,
      attestation_level: offer?.attestation_level ?? null,
      provider_repid_at_bid: b.bid.provider_repid_at_bid,
      provider_repid_now: agent?.current_repid ?? null,
      provider_tier: agent?.tier ?? null,
      provider_lifecycle_status: agent?.lifecycle_status ?? null,
      erc8004_reputation_write_count: Number(agent?.reputation_write_count ?? 0),
      erc8004_last_tx_hash: agent?.last_reputation_tx_hash ?? null,
      related_to_other_bidder: relatedToOther,
      related_to_buyer: sharedWithBuyer.length > 0,
      shared_identity_keys_with_buyer: sharedWithBuyer,
      is_winner: sameAgent(b.bid.id, winnerBidId),
    };
  });

  return {
    snapshot_version: 'a2a-negotiation-v1',
    taken_at: now.toISOString(),
    rfq: {
      id: rfq.id,
      service_type: rfq.service_type,
      award_mode: rfq.award_mode,
      max_rounds: rfq.max_rounds,
      min_provider_repid: rfq.min_provider_repid,
      min_price_usdc_raw: Number(rfq.min_price_usdc_raw),
      max_price_usdc_raw: rfq.max_price_usdc_raw === null ? null : Number(rfq.max_price_usdc_raw),
      bids_close_at: rfq.bids_close_at,
      close_extensions: rfq.close_extensions,
      expires_at: rfq.expires_at,
    },
    buyer: {
      agent_id: rfq.buyer_agent_id,
      agent_name: buyer?.agent_name ?? null,
      current_repid: buyer?.current_repid ?? null,
      tier: buyer?.tier ?? null,
    },
    competing_bid_count: competing.length,
    lowest_valid_price_usdc_raw: lowest,
    was_lowest_price: lowest === null ? true : winnerPrice <= lowest,
    is_uncontested: competing.length <= 1,
    bids: entries,
    concentration,
    disclosures: {
      repid_reward_price_coupled: false,
      post_award_validation: POST_AWARD_VALIDATION_NOTE,
      collusion_claim: COLLUSION_CLAIM_NOTE,
      relatedness_detection:
        'Relatedness compares published wallet_address / signing_address / builder_id only. It is a FLAG, not a ' +
        'block, and it is not a complete detector — an operator using disjoint keys is invisible to it.',
      onchain_fields:
        'All on-chain figures are values this engine recorded at write time. No chain read was performed for ' +
        'this snapshot.',
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Accept — atomic, via the single Postgres function
// ─────────────────────────────────────────────────────────────────────────────

export interface AcceptAndAwardArgs {
  p_rfq_id: string;
  p_bid_id: string;
  p_round_id: string;
  p_buyer_agent_id: string;
  p_provider_agent_id: string;
  p_service_id: string;
  p_price_usdc_raw: number;
  p_eta_seconds: number;
  p_payload: unknown;
  p_contract_metadata: unknown;
  p_contract_expires_at: string;
  p_was_lowest_price: boolean;
  p_is_uncontested: boolean;
  p_award_reason_code: string | null;
  p_award_rationale: string | null;
  p_competing_bid_count: number;
  p_decision_snapshot: unknown;
  p_offer_hash_verified: boolean;
  p_base_price_usdc_raw: number | null;
  p_underbid_ratio: number | null;
  p_attestation_level: AttestationLevel;
  p_buyer_provider_related: boolean;
  p_buyer_provider_prior_awards: number;
  p_provider_award_share_from_this_buyer: number | null;
}

export type AcceptOutcome =
  | { ok: true; contract_id: string; award_id: string }
  | { ok: false; status: number; error: string; message: string };

/** Postgres error codes we translate rather than leak. */
const PG_UNDEFINED_FUNCTION = '42883';
const PG_RAISED = 'P0001';
const PG_UNIQUE_VIOLATION = '23505';
const PG_CHECK_VIOLATION = '23514';

export async function acceptAndAward(args: AcceptAndAwardArgs): Promise<AcceptOutcome> {
  const { data, error } = await db.rpc('a2a_accept_and_award', args as unknown as Record<string, unknown>);

  if (error) {
    const code = (error as { code?: string }).code;
    const message = error.message ?? 'unknown error';

    if (code === PG_UNDEFINED_FUNCTION || /a2a_accept_and_award/i.test(message) && /does not exist/i.test(message)) {
      return {
        ok: false,
        status: 501,
        error: 'negotiation_rpc_not_installed',
        message:
          'a2a_accept_and_award() is not installed in this database. The accept is deliberately all-or-nothing; ' +
          'there is no sequential fallback, because a partial accept would create a live, payable contract with ' +
          'no award record — the exact bug this feature exists to remove.',
      };
    }
    if (code === PG_UNIQUE_VIOLATION || /already_awarded/i.test(message)) {
      return { ok: false, status: 409, error: 'already_awarded', message: 'This RFQ has already been awarded.' };
    }
    if (code === PG_RAISED || code === '55000') {
      if (/expired/i.test(message)) {
        return { ok: false, status: 410, error: 'rfq_expired', message: 'The RFQ expired before the award landed.' };
      }
      return { ok: false, status: 409, error: 'already_awarded', message };
    }
    if (code === PG_CHECK_VIOLATION) {
      return {
        ok: false,
        status: 400,
        error: 'award_constraint_violation',
        message: `The database rejected this award: ${message}. Nothing was written — the contract was rolled back with it.`,
      };
    }
    return { ok: false, status: 500, error: 'award_failed', message };
  }

  const payload = (Array.isArray(data) ? data[0] : data) as { contract_id?: string; award_id?: string } | null;
  if (!payload?.contract_id || !payload?.award_id) {
    return {
      ok: false,
      status: 500,
      error: 'award_failed',
      message: 'a2a_accept_and_award returned no contract_id/award_id',
    };
  }
  return { ok: true, contract_id: payload.contract_id, award_id: payload.award_id };
}
