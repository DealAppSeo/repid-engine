/**
 * stranded-exchange-report.ts — classify why an exchange stopped, and settle NOTHING.
 *
 * ════════════════════════════════════════════════════════════════════════════════
 * THE WORKER I WAS ABOUT TO BUILD, AND WHY IT WOULD HAVE BEEN WRONG
 * ════════════════════════════════════════════════════════════════════════════════
 * 148 of 184 `service_contracts` sit at `fulfilled` — delivered, unpaid, oldest 77
 * days. `escrowed → fulfilled` has a drain worker; `fulfilled → settled` has none, so
 * the obvious fix is "write the missing drain".
 *
 * That fix is wrong, and one query says why:
 *
 *     buyer_responded = 0        of 148
 *     buyer_satisfied = 0
 *     buyer_verdict_but_unsettled = 0
 *
 * **Not one contract has a buyer verdict that failed to settle.** There is no stranded
 * retry case. Every one of the 148 is waiting for a buyer who has never come — so a
 * drain worker would not be recovering stuck payments, it would be **paying providers
 * without the buyer ever verifying delivery**.
 *
 * That is the exact opposite of the product. The whole claim is *pay on verified
 * delivery*: escrow authorizes without transferring, and a rejected deliverable costs
 * nothing on-chain. An auto-settler would convert that into pay-on-delivery-anyway and
 * quietly falsify the one thing the receipt asserts.
 *
 * So this module classifies and reports. **It has no write path at all** — not behind a
 * flag, not in shadow mode. There is no `update`, no `insert`, no settle import. A
 * later reader who wants a drain has to add one deliberately, and should read this
 * header first.
 *
 * ════════════════════════════════════════════════════════════════════════════════
 * WHAT THE AGE PROFILE SAYS [V 2026-08-04]
 * ════════════════════════════════════════════════════════════════════════════════
 *     1–12 days:  12   (1 back-dated)
 *     26 days:    23   (23 back-dated — one legacy batch, all pay-at-escrow)
 *     32–43 days: 26
 *     46 days:     2
 *     68–73 days: 68   ← the bulk
 *     77 days:    17
 *
 * The mass is 68–77 days old and none of it is back-dated. These are not a backlog that
 * a worker drains; they are exchanges whose buyer half never ran. Only 7 contracts in
 * the entire history have ever carried a satisfaction score — and exactly 7 are
 * `settled`. The buyer leg has worked precisely as often as it has been driven by hand.
 *
 * ════════════════════════════════════════════════════════════════════════════════
 * THE 24 BACK-DATED ROWS ARE A REPORTING TRAP
 * ════════════════════════════════════════════════════════════════════════════════
 * 24 `fulfilled` rows carry a non-null `settled_at` from the legacy pay-at-escrow era.
 * Any query written as `settled_at IS NOT NULL` therefore counts 31 settlements where
 * 7 exist. This classifier separates them explicitly so the mistake is not repeatable.
 */

/** The minimal row shape. Kept narrow so the classifier needs no DB types. */
export interface ExchangeRow {
  id: string;
  status: string;
  fulfilled_at: string | null;
  settled_at: string | null;
  buyer_satisfaction_score: number | null;
  buyer_agent_id: string | null;
  provider_agent_id: string | null;
}

export type ExchangeState =
  /** Delivered; the buyer has never responded. The buyer must act — nobody else may. */
  | 'AWAITING_BUYER'
  /** Buyer approved and settlement did not complete. THE ONLY case a drain may touch. */
  | 'STRANDED_UNSETTLED'
  /** `fulfilled` with a legacy pay-at-escrow `settled_at`. Counts as settled nowhere. */
  | 'LEGACY_BACKDATED'
  /** Reached a terminal state normally. */
  | 'TERMINAL'
  /** Still moving. */
  | 'IN_FLIGHT';

export interface ExchangeAssessment {
  id: string;
  state: ExchangeState;
  ageDays: number | null;
  /** Who is the ONLY party that can move this forward. */
  actionableBy: 'buyer' | 'operator' | 'nobody';
  reason: string;
  /**
   * True only for `STRANDED_UNSETTLED`. Any future drain must gate on THIS and nothing
   * else — `status === 'fulfilled'` is not a sufficient condition and never was.
   */
  safeToAutoSettle: boolean;
}

const dayjsAgo = (iso: string | null, now: number): number | null => {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return null;
  return Math.floor((now - t) / 86_400_000);
};

/**
 * Classify one exchange.
 *
 * Order matters. `LEGACY_BACKDATED` is checked before `AWAITING_BUYER` because those 24
 * rows are ALSO awaiting a buyer, and folding them together is what makes the
 * `settled_at IS NOT NULL` overcount invisible.
 */
export function classifyExchange(row: ExchangeRow, now: number = Date.now()): ExchangeAssessment {
  const ageDays = dayjsAgo(row.fulfilled_at, now);
  const base = { id: row.id, ageDays };

  if (row.status !== 'fulfilled') {
    const terminal = ['settled', 'resolved', 'cancelled'].includes(row.status);
    return {
      ...base,
      state: terminal ? 'TERMINAL' : 'IN_FLIGHT',
      actionableBy: terminal ? 'nobody' : 'operator',
      reason: `status is ${row.status}`,
      safeToAutoSettle: false,
    };
  }

  if (row.settled_at) {
    return {
      ...base,
      state: 'LEGACY_BACKDATED',
      actionableBy: 'operator',
      reason:
        'fulfilled but carries a settled_at from the legacy pay-at-escrow era — it is ' +
        'NOT settled, and any query using `settled_at IS NOT NULL` overcounts it',
      safeToAutoSettle: false,
    };
  }

  const responded = row.buyer_satisfaction_score !== null && row.buyer_satisfaction_score !== undefined;

  if (!responded) {
    return {
      ...base,
      state: 'AWAITING_BUYER',
      actionableBy: 'buyer',
      reason:
        'delivered, and the buyer has never recorded a verdict. Only the buyer may ' +
        'move this: settling it for them would pay a provider for work nobody verified, ' +
        'which is the one thing the receipt promises never happens',
      safeToAutoSettle: false,
    };
  }

  if ((row.buyer_satisfaction_score ?? 0) > 0) {
    return {
      ...base,
      state: 'STRANDED_UNSETTLED',
      actionableBy: 'operator',
      reason: 'buyer approved and settlement did not complete — a genuine retry case',
      safeToAutoSettle: true,
    };
  }

  return {
    ...base,
    state: 'TERMINAL',
    actionableBy: 'nobody',
    reason: 'buyer recorded a non-positive verdict; there is nothing to settle',
    safeToAutoSettle: false,
  };
}

export interface ExchangeSummary {
  total: number;
  byState: Record<ExchangeState, number>;
  /** How many a drain worker could legitimately act on. Expected: very few. */
  autoSettleable: number;
  oldestAwaitingBuyerDays: number | null;
  /** One sentence an operator can act on, or be reassured by. */
  headline: string;
}

export function summarise(rows: readonly ExchangeRow[], now: number = Date.now()): ExchangeSummary {
  const byState: Record<ExchangeState, number> = {
    AWAITING_BUYER: 0,
    STRANDED_UNSETTLED: 0,
    LEGACY_BACKDATED: 0,
    TERMINAL: 0,
    IN_FLIGHT: 0,
  };
  let autoSettleable = 0;
  let oldestAwaiting: number | null = null;

  for (const r of rows) {
    const a = classifyExchange(r, now);
    byState[a.state]++;
    if (a.safeToAutoSettle) autoSettleable++;
    if (a.state === 'AWAITING_BUYER' && a.ageDays !== null) {
      oldestAwaiting = oldestAwaiting === null ? a.ageDays : Math.max(oldestAwaiting, a.ageDays);
    }
  }

  const headline =
    byState.AWAITING_BUYER > 0 && autoSettleable === 0
      ? `${byState.AWAITING_BUYER} exchange(s) are waiting on a BUYER, not on a worker. ` +
        `Nothing here is safe to auto-settle. The gap is that buyers are not acting — ` +
        `building a drain would pay for unverified work.`
      : autoSettleable > 0
        ? `${autoSettleable} exchange(s) have a buyer verdict that did not settle — ` +
          `those, and only those, are a legitimate retry.`
        : 'No stalled exchanges.';

  return {
    total: rows.length,
    byState,
    autoSettleable,
    oldestAwaitingBuyerDays: oldestAwaiting,
    headline,
  };
}

/** Render for an operator log or the status digest. */
export function formatSummary(s: ExchangeSummary): string {
  const lines = [
    `[stranded-exchange] ${s.total} exchange(s) examined`,
    `  awaiting buyer     : ${s.byState.AWAITING_BUYER}` +
      (s.oldestAwaitingBuyerDays !== null ? ` (oldest ${s.oldestAwaitingBuyerDays}d)` : ''),
    `  stranded unsettled : ${s.byState.STRANDED_UNSETTLED}  <- the only auto-settleable class`,
    `  legacy back-dated  : ${s.byState.LEGACY_BACKDATED}  <- NOT settled; overcounted by settled_at IS NOT NULL`,
    `  terminal           : ${s.byState.TERMINAL}`,
    `  in flight          : ${s.byState.IN_FLIGHT}`,
    `  ${s.headline}`,
  ];
  return lines.join('\n');
}
