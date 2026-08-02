/**
 * x402-deferred-settlement.ts — pay AFTER verified delivery, not before.
 *
 * THE PROBLEM THIS FIXES
 * ----------------------
 * Today `POST /api/v1/contracts/:id/escrow` verifies the buyer's payment AND
 * settles it in the same request (`contracts.ts` — verifyPayment then
 * settlePayment), before the provider has done any work at all. It even
 * back-dates `settled_at`. So "escrow" is a misnomer: the money is gone the
 * moment the contract is escrowed, and a buyer who receives a worthless
 * deliverable has already paid for it. The HAL veto, the peer verification and
 * the dispute path all run *after* the funds moved, which makes them advisory
 * rather than protective.
 *
 * THE MECHANISM
 * -------------
 * x402 `exact` on Base uses EIP-3009 `transferWithAuthorization`. That is a
 * SIGNED AUTHORIZATION, not a transfer: the buyer signs an off-chain message
 * and anyone holding it can broadcast it once, at any time, until
 * `validBefore`. Crucially the facilitator exposes /verify and /settle as two
 * separate calls — so the authorization can be checked for validity and
 * funding WITHOUT being broadcast.
 *
 * That means real escrow needs NO escrow contract, NO extra deployment and NO
 * extra gas:
 *
 *   escrow   → /verify only. Hold the signed authorization. Nothing on-chain.
 *   deliver  → provider works; HAL grades; an independent peer verifies.
 *   release  → /settle the held authorization. ONE on-chain transfer, buyer → provider.
 *   reject   → never settle. The authorization simply expires at validBefore.
 *              The money never left the buyer's wallet.
 *
 * The buyer's funds are protected by the fact that a signature is not a
 * payment. Nothing is locked, so nothing can be stuck.
 *
 * WHAT THIS COSTS
 * ---------------
 * Strictly less than the current path: one broadcast instead of one, and zero
 * broadcasts on a rejected deliverable (today a rejected deliverable has
 * already cost a settlement tx). No escrow contract to deploy or audit.
 *
 * THE HONEST LIMITATIONS — read before trusting this
 * --------------------------------------------------
 * 1. An authorization is only as good as its `validBefore` window. The buyer's
 *    signature currently carries a 1-hour window. Work that outruns the window
 *    leaves an unsettleable authorization: the provider did the work and
 *    CANNOT be paid from it. `assessAuthorization` reports EXPIRED rather than
 *    letting a caller discover this by a failed broadcast.
 * 2. Verification is not a lock. Between verify and settle the buyer can spend
 *    the same USDC elsewhere, and the settle will then fail for insufficient
 *    funds. This is a real risk that a true on-chain escrow would not have; it
 *    is the price of not deploying one. It is detectable (settle fails, nobody
 *    is paid) rather than silent, and the provider's remedy is the dispute
 *    path plus the buyer's RepID penalty. Do not describe this as "funds held".
 * 3. Nothing here decides whether a deliverable is good. This module refuses to
 *    settle without an explicit verification decision from the caller, and
 *    records what that decision was — but it does not make it.
 *
 * REVERSIBILITY
 * -------------
 * Entirely gated behind X402_SETTLE_ON_DELIVERY. Unset (the default) and the
 * escrow path behaves exactly as it does today. One env change reverts it.
 */
import { db } from '../db';
import { x402Facilitator, type PaymentRequirements } from './x402-facilitator';

/** Settlement lifecycle values written to `x402_settlements.status`. */
export const SETTLEMENT_STATUS = {
  /** Verified and held. Nothing on-chain. Money is still the buyer's. */
  AUTHORIZED: 'authorized',
  /** A broadcast is in flight. Guards against a double-spend on concurrent release. */
  SETTLING: 'settling',
  /** Broadcast confirmed. `tx_hash` is real. */
  SETTLED: 'settled',
  /** Deliberately never settled — rejected deliverable, dispute, or expiry. */
  VOIDED: 'voided',
} as const;

export type ReleaseOutcome =
  | { status: 'SETTLED'; txHash: string; settlementId: string }
  /**
   * MONEY MOVED BUT WE FAILED TO RECORD IT. The rarest and worst state: the
   * transfer is on-chain and irreversible, yet our row does not say so. A human
   * must reconcile. Never collapse this into SETTLED — the ledger is wrong, and
   * pretending otherwise is how a double-spend gets authorised later.
   */
  | { status: 'SETTLED_UNRECORDED'; txHash: string; settlementId: string; reason: string }
  | { status: 'ALREADY_SETTLED'; txHash: string; settlementId: string }
  | { status: 'REFUSED'; reason: string }
  | { status: 'EXPIRED'; reason: string }
  | { status: 'FAILED'; reason: string };

export function isSettleOnDeliveryEnabled(): boolean {
  return process.env['X402_SETTLE_ON_DELIVERY'] === 'true';
}

/**
 * Decode the EIP-3009 authorization window out of an X-PAYMENT header without
 * trusting it. Returns null when the header is not a shape we understand —
 * an unreadable window is reported as unknown, never as valid.
 */
export function readAuthorizationWindow(xPaymentHeader: string): { validAfter: number; validBefore: number } | null {
  try {
    const decoded = JSON.parse(Buffer.from(xPaymentHeader, 'base64').toString('utf8')) as Record<string, unknown>;
    const payload = (decoded['payload'] ?? decoded) as Record<string, unknown>;
    const auth = (payload['authorization'] ?? payload) as Record<string, unknown>;
    const before = Number(auth['validBefore']);
    const after = Number(auth['validAfter'] ?? 0);
    if (!Number.isFinite(before) || before <= 0) return null;
    return { validAfter: Number.isFinite(after) ? after : 0, validBefore: before };
  } catch {
    return null;
  }
}

/**
 * Is this authorization still broadcastable? Called BEFORE attempting a settle
 * so an expired window is reported as such instead of surfacing as an opaque
 * facilitator error after the provider has already done the work.
 */
export function assessAuthorization(
  xPaymentHeader: string,
  nowSeconds = Math.floor(Date.now() / 1000)
): { ok: true; secondsRemaining: number } | { ok: false; reason: string } {
  const win = readAuthorizationWindow(xPaymentHeader);
  if (!win) return { ok: false, reason: 'authorization window could not be read from the payment header' };
  if (win.validAfter > nowSeconds) {
    return { ok: false, reason: `authorization is not yet valid (validAfter ${win.validAfter} > now ${nowSeconds})` };
  }
  if (win.validBefore <= nowSeconds) {
    return {
      ok: false,
      reason:
        `authorization EXPIRED at ${win.validBefore} (now ${nowSeconds}). The work outran the buyer's ` +
        `signature window, so this deliverable cannot be paid from it. The provider is owed and unpaid — ` +
        `this is a dispute, not a silent loss.`,
    };
  }
  return { ok: true, secondsRemaining: win.validBefore - nowSeconds };
}

/**
 * Record a VERIFIED-BUT-UNSETTLED authorization at escrow time.
 * Nothing is broadcast. `tx_hash` stays null precisely so that a row with a
 * tx_hash always means money actually moved.
 */
export async function recordAuthorization(args: {
  contractId: string;
  buyerAgentId: string;
  providerAgentId: string;
  amountRaw: number;
  topic: string;
  xPaymentHeader: string;
  payerAddress: string | null;
  isSimulated: boolean;
}): Promise<{ settlementId: string } | { error: string }> {
  const { data, error } = await db
    .from('x402_settlements')
    .insert({
      tip_id: `contract_${args.contractId}`,
      prediction_topic: args.topic,
      amount: args.amountRaw,
      asset: 'USDC',
      status: SETTLEMENT_STATUS.AUTHORIZED,
      payer_address: args.payerAddress,
      provider_agent_id: args.providerAgentId,
      requestor_agent_id: args.buyerAgentId,
      x_payment_header: args.xPaymentHeader,
      is_simulated: args.isSimulated,
      idempotency_key: args.contractId,
      settlement_attempt_count: 0,
      tx_hash: null,
    })
    .select('id')
    .single();

  if (error) return { error: error.message };
  return { settlementId: String(data.id) };
}

/**
 * Broadcast a held authorization — the actual moment money moves.
 *
 * REFUSES unless the caller passes an explicit verification decision. A
 * settlement that happens because nobody checked is the failure this whole
 * module exists to prevent, so "no decision" is treated as "no".
 */
export async function releaseHeldPayment(args: {
  contractId: string;
  /** Accepts either shape — buildPaymentRequirements returns an array. */
  requirements: PaymentRequirements | PaymentRequirements[];
  /** The independent verification outcome. Only true releases funds. */
  deliverableVerified: boolean;
  /** How that was decided — recorded for audit. e.g. 'hal:PASS+peer:CONFIRMED'. */
  verificationEvidence: string;
}): Promise<ReleaseOutcome> {
  if (!args.deliverableVerified) {
    return {
      status: 'REFUSED',
      reason: `deliverable did not pass verification (${args.verificationEvidence}) — authorization left unsettled; the buyer keeps the funds`,
    };
  }

  const { data: held, error: findErr } = await db
    .from('x402_settlements')
    .select('id, status, tx_hash, x_payment_header, is_simulated')
    .eq('idempotency_key', args.contractId)
    .maybeSingle();

  if (findErr) return { status: 'FAILED', reason: `settlement lookup failed: ${findErr.message}` };
  if (!held) return { status: 'FAILED', reason: 'no authorization on record for this contract' };

  // Idempotency: a second release must never produce a second transfer.
  if (held.status === SETTLEMENT_STATUS.SETTLED) {
    return { status: 'ALREADY_SETTLED', txHash: String(held.tx_hash ?? ''), settlementId: String(held.id) };
  }
  if (held.status === SETTLEMENT_STATUS.VOIDED) {
    return { status: 'REFUSED', reason: 'this authorization was voided and must never be settled' };
  }
  if (held.status === SETTLEMENT_STATUS.SETTLING) {
    return { status: 'REFUSED', reason: 'a release is already in flight for this contract' };
  }
  if (held.status !== SETTLEMENT_STATUS.AUTHORIZED) {
    return { status: 'REFUSED', reason: `unexpected settlement status '${held.status}'` };
  }

  const header = String(held.x_payment_header ?? '');
  if (!header) return { status: 'FAILED', reason: 'authorization row carries no payment header' };

  const window = assessAuthorization(header);
  if (!window.ok) {
    await db
      .from('x402_settlements')
      .update({ status: SETTLEMENT_STATUS.VOIDED })
      .eq('id', held.id)
      .eq('status', SETTLEMENT_STATUS.AUTHORIZED);
    return { status: 'EXPIRED', reason: window.reason };
  }

  // Claim the row atomically. The .eq('status', AUTHORIZED) predicate is the
  // guard: two concurrent releases race here and exactly one wins, so the
  // authorization can only ever be broadcast once.
  const { data: claimed, error: claimErr } = await db
    .from('x402_settlements')
    .update({ status: SETTLEMENT_STATUS.SETTLING })
    .eq('id', held.id)
    .eq('status', SETTLEMENT_STATUS.AUTHORIZED)
    .select('id')
    .maybeSingle();

  if (claimErr) return { status: 'FAILED', reason: `could not claim authorization: ${claimErr.message}` };
  if (!claimed) return { status: 'REFUSED', reason: 'authorization was claimed by a concurrent release' };

  try {
    const result = await x402Facilitator.settlePayment(header, args.requirements);

    // THE WRITE THAT RECORDS AN IRREVERSIBLE FACT. Its error was previously
    // unchecked, and it silently failed on a column (`facilitator_response`)
    // that the GENERATED TYPES claim exists but the live table does not have.
    // Result, observed on a real Base Sepolia settlement: 0.10 USDC moved,
    // the caller was told SETTLED, and the row stayed 'settling' with a null
    // tx_hash. That is precisely the silent-success failure this module was
    // written to prevent, committed by the module itself.
    //
    // Columns here are now only those verified to exist on the live table.
    const { error: recordErr } = await db
      .from('x402_settlements')
      .update({
        status: SETTLEMENT_STATUS.SETTLED,
        tx_hash: result.txHash,
        delivered_at: new Date().toISOString(),
        settlement_attempt_count: 1,
      })
      .eq('id', held.id);

    if (recordErr) {
      // Do NOT claim SETTLED. The transfer is real and cannot be undone, but our
      // ledger disagrees with the chain and only a human can close that gap.
      console.error(
        `[x402-deferred] SETTLED_UNRECORDED contract=${args.contractId} tx=${result.txHash} — ` +
          `the transfer succeeded but the settlement row could NOT be updated: ${recordErr.message}`
      );
      return {
        status: 'SETTLED_UNRECORDED',
        txHash: result.txHash,
        settlementId: String(held.id),
        reason: `on-chain transfer ${result.txHash} SUCCEEDED but the settlement row could not be updated (${recordErr.message}). The ledger is behind the chain — reconcile manually.`,
      };
    }

    return { status: 'SETTLED', txHash: result.txHash, settlementId: String(held.id) };
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : String(e);
    // Hand the row back so a retry is possible. Leaving it SETTLING would
    // strand a provider who genuinely earned the money.
    await db
      .from('x402_settlements')
      .update({ status: SETTLEMENT_STATUS.AUTHORIZED })
      .eq('id', held.id)
      .eq('status', SETTLEMENT_STATUS.SETTLING);

    // A FAILED RELEASE MUST LEAVE A TRACE. Observed live 2026-08-02 on contract
    // 2e89cea0-c540-4a19-8adc-47df56cf5be1: the facilitator threw, this branch
    // handed the row back correctly, an immediate retry settled, and nothing
    // was double-spent — the state machine did its job. But the failure was
    // written NOWHERE. Not here, not to x402_settlement_failures (whose newest
    // row was from June), not to the audit chain. It existed only in the body
    // of the HTTP response that failed.
    //
    // Two consequences, both bad on a money path. You cannot ask "how often
    // does release fail?" after the fact. And the contract sits `fulfilled`
    // with the provider delivered-and-unpaid until somebody happens to call
    // satisfy again — on the UI path, a user who sees one error and walks away
    // leaves it stranded silently.
    //
    // The sibling SETTLED_UNRECORDED branch above already shouts via
    // console.error. This one said nothing at all, which is the exact
    // fail-silent behaviour this module's own header sets out to prevent.
    console.error(
      `[x402-deferred] RELEASE FAILED contract=${args.contractId} settlement=${held.id} — ` +
        `authorization handed back to '${SETTLEMENT_STATUS.AUTHORIZED}' and is retryable. Reason: ${message}`,
    );
    await recordReleaseFailure(args.contractId, held.id, header, args.requirements, message);

    return { status: 'FAILED', reason: `settlement broadcast failed: ${message}` };
  }
}

/**
 * Durable record of a failed release, so the gap is queryable later.
 *
 * Best-effort by construction: this runs on a path that has ALREADY failed, and
 * a bookkeeping error must never mask the real one or throw out of the catch
 * that is busy handing the authorization back. Columns are only those verified
 * present on the live table (the generated types are stale — see the standing
 * rule and the SETTLED_UNRECORDED comment above).
 */
async function recordReleaseFailure(
  contractId: string,
  settlementId: string | number,
  paymentHeader: string,
  requirements: unknown,
  message: string,
): Promise<void> {
  try {
    // VERIFIED AGAINST information_schema, not the generated types: direction,
    // payment_payload_b64, payment_requirements, attempt_count and
    // last_attempted_at are all NOT NULL. The first draft of this omitted
    // payment_payload_b64 and would have thrown a not-null violation inside the
    // very catch meant to make the failure visible — losing the record twice
    // over. Storing the header matches what every existing row holds, and the
    // authorization is nonce-bound and single-use.
    const { error } = await db.from('x402_settlement_failures').insert({
      direction: 'outbound',
      idempotency_key: contractId,
      payment_payload_b64: paymentHeader,
      payment_requirements: requirements ?? [],
      facilitator_response: { error: message, settlement_id: String(settlementId) },
      attempt_count: 1,
      last_attempted_at: new Date().toISOString(),
    });
    if (error) {
      console.error(
        `[x402-deferred] could not record the release failure for contract=${contractId}: ${error.message}`,
      );
    }
  } catch (err: unknown) {
    console.error(
      `[x402-deferred] could not record the release failure for contract=${contractId}: ` +
        `${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/**
 * Deliberately never settle — rejected deliverable, upheld dispute, expiry.
 * Refuses on an already-settled row: money that moved cannot be un-moved by
 * changing a status, and pretending otherwise would be the worst kind of lie
 * this system could tell.
 */
export async function voidAuthorization(
  contractId: string,
  reason: string
): Promise<{ voided: true } | { voided: false; reason: string }> {
  const { data: row, error } = await db
    .from('x402_settlements')
    .select('id, status, tx_hash')
    .eq('idempotency_key', contractId)
    .maybeSingle();

  if (error) return { voided: false, reason: error.message };
  if (!row) return { voided: false, reason: 'no authorization on record' };
  if (row.status === SETTLEMENT_STATUS.SETTLED) {
    return {
      voided: false,
      reason: `already settled on-chain (tx ${row.tx_hash}) — funds have moved and cannot be voided; use the dispute path`,
    };
  }

  const { data: updated } = await db
    .from('x402_settlements')
    .update({ status: SETTLEMENT_STATUS.VOIDED })
    .eq('id', row.id)
    .neq('status', SETTLEMENT_STATUS.SETTLED)
    .select('id')
    .maybeSingle();

  return updated ? { voided: true } : { voided: false, reason: 'row changed underneath the void' };
}
