/**
 * stall-signals.ts — turn "the loop stopped" into a STATE WITH A REASON, before
 * somebody has to think to go query for it.
 *
 * ════════════════════════════════════════════════════════════════════════════════
 * WHY THIS EXISTS
 * ════════════════════════════════════════════════════════════════════════════════
 * Every stall this system has had was found by a human deciding to run a query.
 * None of them announced themselves. Exchanges sat delivered-and-unpaid for 77
 * days; a routing layer logged nothing for a day and a half; a task queue went
 * quiet. Each was visible in a `count(*)` the whole time — and a `count(*)` is
 * exactly what nobody reads.
 *
 * A number is not an alert. `0` is the same character whether a worker is broken
 * or whether it correctly had nothing to do, and `148` is the same number whether
 * it is a backlog to drain or a queue waiting on someone who is never coming. The
 * interpretation is the product here; the count is just an input.
 *
 * So every function below returns a `Determination` plus `what` / `why` /
 * `actionableBy`. If the reason is not determinable from the available evidence,
 * the determination is `INDETERMINATE` and says so — it never guesses.
 *
 * ════════════════════════════════════════════════════════════════════════════════
 * THREE RULES THIS MODULE IS BUILT AROUND
 * ════════════════════════════════════════════════════════════════════════════════
 *
 * 1. **Zero output is not a diagnosis. Zero output *with a backlog* is.**
 *    Idle and broken produce byte-identical counters. The discriminator is
 *    unserved demand: nothing produced AND nothing waiting is a system correctly
 *    at rest; nothing produced WHILE work waits is a system that stopped. With no
 *    demand signal at all, the honest answer is `INDETERMINATE` — see
 *    `classifyThroughput`.
 *
 * 2. **A silent source is evidence about the source, not about the system.**
 *    The obvious liveness input for "is the fleet alive" had not been written in
 *    over 400 hours when this was built [V 2026-08-04]. A health surface that
 *    trusted it would have reported a dead fleet with total confidence. Any input
 *    older than its own expected cadence is `STALE_UNUSABLE` and disqualifies
 *    conclusions drawn from it — see `assessSourceFreshness`.
 *
 * 3. **Never repeat the measurement bug you are reporting.**
 *    A set of `fulfilled` rows carry a non-null `settled_at` from a legacy
 *    pay-at-escrow era, so the natural query — `settled_at IS NOT NULL` — counts
 *    several times more settlements than exist. `assessSettlementCounting` exists
 *    to surface that inflation as a first-class defect rather than silently
 *    inheriting it.
 *
 * ════════════════════════════════════════════════════════════════════════════════
 * WHAT THIS DELIBERATELY DOES NOT DO
 * ════════════════════════════════════════════════════════════════════════════════
 * - **It does not act.** No write path exists here — no insert, update, upsert,
 *   delete or rpc, not behind a flag, not in shadow. Reporting that 124 exchanges
 *   await a buyer must never become settling them: that would pay providers for
 *   work nobody verified, which is the single thing the receipt promises never
 *   happens. A test asserts the absence of every write verb.
 * - **It does not mount.** Nothing here is a route and nothing imports it into the
 *   app. Exposing an operational surface publicly is a separate, reviewed
 *   decision; these are exported functions waiting for that decision.
 * - **It does not emit identifiers.** Every output is an aggregate. No contract
 *   id, agent id, address, tx hash or free-text row content crosses this boundary,
 *   because an observability surface that leaks per-row identity is a disclosure
 *   channel wearing a dashboard's clothes. A test asserts the shape.
 */

/* ────────────────────────────────────────────────────────────────────────────
 * Vocabulary
 * ──────────────────────────────────────────────────────────────────────────── */

export type Determination =
  /** Work is flowing. Nothing to do. */
  | 'HEALTHY'
  /** Correctly at rest: nothing was produced because nothing was waiting. */
  | 'IDLE'
  /** Work was waiting and none was taken. Something is not running. */
  | 'STALLED'
  /** Running, but producing a result that is wrong or misleading. */
  | 'DEGRADED'
  /** The evidence cannot separate the benign case from the broken one. */
  | 'INDETERMINATE';

/**
 * Who — and only who — can move this forward. `unknown` is a legitimate answer
 * and is preferable to naming the wrong party, which sends someone to look in a
 * place where the problem is not.
 */
export type Actionable = 'buyer' | 'operator' | 'engineering' | 'nobody' | 'unknown';

export interface SignalReport {
  /** Stable machine key. Safe to alert on; never contains data. */
  signal: string;
  determination: Determination;
  /** What is true, in one sentence. */
  what: string;
  /** Why it is true — or an explicit statement that the reason is not determinable. */
  why: string;
  actionableBy: Actionable;
  /**
   * The aggregate numbers the determination rests on. Numbers, booleans and
   * fixed vocabulary only — never a row identifier, never free text from a row.
   */
  evidence: Readonly<Record<string, number | boolean | null>>;
}

/* ────────────────────────────────────────────────────────────────────────────
 * Rule 1 — the idle/broken discriminator
 * ──────────────────────────────────────────────────────────────────────────── */

export interface ThroughputInput {
  /** Units of work observed completing inside the window. */
  observedInWindow: number;
  /**
   * Units of work that were WAITING to be served. This is the whole discriminator.
   * `null` means no demand signal is available — which yields `INDETERMINATE`,
   * never a guess.
   */
  backlog: number | null;
  /** Hours since the most recent observation ever, or `null` if there has never been one. */
  hoursSinceLast: number | null;
  windowHours: number;
}

export interface ThroughputVerdict {
  determination: Determination;
  why: string;
}

/**
 * The core judgement, isolated so it can be tested without a database and reused
 * by every signal that reduces to "should something have happened here?".
 *
 * `hoursSinceLast` deliberately only colours the narrative. It must never flip
 * idle into broken: a queue that has been empty for a month is still just empty,
 * and "it has been a long time" is the reasoning that produces false alarms on
 * healthy low-traffic systems.
 */
export function classifyThroughput(input: ThroughputInput): ThroughputVerdict {
  const { observedInWindow, backlog, hoursSinceLast, windowHours } = input;

  if (observedInWindow > 0) {
    return {
      determination: 'HEALTHY',
      why: `${observedInWindow} unit(s) of work completed in the last ${windowHours}h`,
    };
  }

  const lastSeen =
    hoursSinceLast === null
      ? 'there has never been a recorded observation'
      : `the most recent observation was ${round1(hoursSinceLast)}h ago`;

  if (backlog === null) {
    return {
      determination: 'INDETERMINATE',
      why:
        `nothing completed in ${windowHours}h and no demand signal is available, so ` +
        `"idle because there was nothing to do" and "broken and dropping work" are ` +
        `indistinguishable from here — they produce the identical counter. ` +
        `${capitalise(lastSeen)}. Resolving this needs a measure of unserved demand, ` +
        `not a longer window`,
    };
  }

  if (backlog === 0) {
    return {
      determination: 'IDLE',
      why:
        `nothing completed in ${windowHours}h and nothing was waiting — zero output is ` +
        `fully explained by zero demand, which is a system at rest, not a failure. ` +
        `${capitalise(lastSeen)}`,
    };
  }

  return {
    determination: 'STALLED',
    why:
      `${backlog} unit(s) of work were waiting and none completed in ${windowHours}h. ` +
      `Demand exists and is not being served, so this is not idleness. ${capitalise(lastSeen)}`,
  };
}

/* ────────────────────────────────────────────────────────────────────────────
 * Rule 2 — a silent source proves nothing about the system
 * ──────────────────────────────────────────────────────────────────────────── */

export type SourceFreshness = 'FRESH' | 'STALE_UNUSABLE';

export interface FreshnessVerdict {
  freshness: SourceFreshness;
  why: string;
}

/**
 * Decide whether an input may be reasoned from at all.
 *
 * A table that is written every minute and has not been written in 400 hours is
 * not reporting silence — it has stopped reporting. Reading its emptiness as
 * "the fleet is dead" is the confident-and-wrong failure mode this whole module
 * exists to avoid, and it is exactly what the obvious liveness table would have
 * caused here [V 2026-08-04].
 *
 * @param hoursSinceLastWrite  null = never written at all.
 * @param expectedCadenceHours how often this source is supposed to be written.
 */
export function assessSourceFreshness(
  hoursSinceLastWrite: number | null,
  expectedCadenceHours: number,
): FreshnessVerdict {
  // A tolerance rather than an exact cadence: one missed beat is jitter, a
  // sustained multiple of the cadence is a stopped writer.
  const toleranceHours = expectedCadenceHours * 3;

  if (hoursSinceLastWrite === null) {
    return {
      freshness: 'STALE_UNUSABLE',
      why:
        'this source has never been written, so its emptiness says nothing about the ' +
        'system it is supposed to describe',
    };
  }

  if (hoursSinceLastWrite <= toleranceHours) {
    return {
      freshness: 'FRESH',
      why: `last written ${round1(hoursSinceLastWrite)}h ago, within the ${round1(toleranceHours)}h tolerance`,
    };
  }

  return {
    freshness: 'STALE_UNUSABLE',
    why:
      `last written ${round1(hoursSinceLastWrite)}h ago against an expected cadence of ` +
      `${round1(expectedCadenceHours)}h. The writer has stopped, so this source's silence is ` +
      `evidence about the source and NOT about what it measures — no conclusion may be drawn ` +
      `from it until it is writing again`,
  };
}

/* ────────────────────────────────────────────────────────────────────────────
 * Signal: exchanges that stopped
 * ──────────────────────────────────────────────────────────────────────────── */

export interface ExchangeFacts {
  /** Delivered and not in a terminal state. */
  fulfilledTotal: number;
  /** `fulfilled` rows carrying a legacy `settled_at`. NOT settled. See rule 3. */
  fulfilledBackdated: number;
  /** Delivered, no buyer verdict of any kind recorded. */
  awaitingBuyer: number;
  /** Buyer approved and settlement did not complete. The ONLY legitimate retry class. */
  strandedUnsettled: number;
  /** Age of the oldest exchange still waiting on a buyer. */
  oldestAwaitingDays: number | null;
}

/**
 * Classify the exchange pipeline.
 *
 * The determination that matters is the one that separates *a backlog a worker
 * should drain* from *a queue waiting on a party who never arrives*. They look
 * identical in a count and have opposite remedies: the first wants an operator,
 * the second cannot be fixed by any amount of backend work, and building the
 * obvious drain for it would pay providers for unverified work.
 *
 * `actionableBy: 'buyer'` is therefore load-bearing, not decorative — it is how
 * this surface refuses to route a product gap to an engineer.
 */
export function assessExchanges(f: ExchangeFacts): SignalReport {
  const evidence = {
    fulfilled_total: f.fulfilledTotal,
    awaiting_buyer: f.awaitingBuyer,
    stranded_unsettled: f.strandedUnsettled,
    legacy_backdated: f.fulfilledBackdated,
    oldest_awaiting_days: f.oldestAwaitingDays,
  } as const;

  if (f.strandedUnsettled > 0) {
    return {
      signal: 'exchange.stalled',
      determination: 'STALLED',
      what: `${f.strandedUnsettled} exchange(s) have a buyer verdict that did not settle`,
      why:
        'the buyer approved and settlement did not complete — this is a genuine retry ' +
        'case, and the only class where acting on the exchange is legitimate',
      actionableBy: 'operator',
      evidence,
    };
  }

  if (f.awaitingBuyer > 0) {
    const age =
      f.oldestAwaitingDays !== null ? `, the oldest ${f.oldestAwaitingDays} day(s) old` : '';
    return {
      signal: 'exchange.stalled',
      determination: 'STALLED',
      what: `${f.awaitingBuyer} exchange(s) are delivered and unpaid${age}`,
      why:
        'not one of them has a buyer verdict, so none is a stuck payment — every one is ' +
        'waiting on a buyer who has not come. No worker is failing here and no worker can ' +
        'fix it: settling them would pay providers for work nobody verified, which inverts ' +
        'the only promise the receipt makes. The gap is that the buyer half of the ' +
        'marketplace is not being exercised, which is a product problem, not a backend one',
      actionableBy: 'buyer',
      evidence,
    };
  }

  return {
    signal: 'exchange.stalled',
    determination: 'HEALTHY',
    what: 'no exchange is delivered-and-unpaid',
    why: 'every delivered exchange has reached a terminal state',
    actionableBy: 'nobody',
    evidence,
  };
}

/* ────────────────────────────────────────────────────────────────────────────
 * Rule 3 — the settlement-counting trap, surfaced rather than inherited
 * ──────────────────────────────────────────────────────────────────────────── */

export interface SettlementCountingFacts {
  /** What a naive `settled_at IS NOT NULL` returns. */
  naiveSettledAtCount: number;
  /** What is actually settled: a terminal settled status. */
  trulySettled: number;
}

/**
 * Report the inflation factor of the tempting-but-wrong settlement query.
 *
 * This is not a nicety. "How many settlements are there" is the number most
 * likely to end up on a public surface, and the natural way to ask it is off by
 * a multiple. Surfacing the multiple is the difference between an observability
 * layer and a laundering step for a known-bad metric.
 */
export function assessSettlementCounting(f: SettlementCountingFacts): SignalReport {
  const inflated = f.naiveSettledAtCount - f.trulySettled;
  const factor = f.trulySettled > 0 ? round1(f.naiveSettledAtCount / f.trulySettled) : null;

  const evidence = {
    naive_settled_at_count: f.naiveSettledAtCount,
    truly_settled: f.trulySettled,
    overcounted_by: inflated,
    inflation_factor: factor,
  } as const;

  if (inflated <= 0) {
    return {
      signal: 'reporting.settlement_overcount',
      determination: 'HEALTHY',
      what: 'the naive settlement query and the true settled count agree',
      why: 'no legacy rows carry a settlement timestamp without a settled status',
      actionableBy: 'nobody',
      evidence,
    };
  }

  return {
    signal: 'reporting.settlement_overcount',
    determination: 'DEGRADED',
    what:
      `counting settlements with \`settled_at IS NOT NULL\` returns ${f.naiveSettledAtCount} ` +
      `where ${f.trulySettled} exist` +
      (factor !== null ? ` — an overstatement of ${factor}x` : ''),
    why:
      `${inflated} row(s) carry a settlement timestamp from a legacy pay-at-escrow era ` +
      `while never having settled. The system is running; it is the measurement that is ` +
      `wrong, which is more dangerous than an outage because it reports as success. Any ` +
      `query, report or public surface using that predicate is overstating revenue activity`,
    actionableBy: 'engineering',
    evidence,
  };
}

/* ────────────────────────────────────────────────────────────────────────────
 * Signal: a routing layer that logs nothing
 * ──────────────────────────────────────────────────────────────────────────── */

export interface RoutingFacts {
  decisionsInWindow: number;
  windowHours: number;
  hoursSinceLastDecision: number | null;
  /** Lifetime decisions. Distinguishes "never wired" from "wired and quiet". */
  decisionsLifetime: number;
  /**
   * Requests that SHOULD have produced a routing decision in the window, if such a
   * measure exists. Almost always `null` today, because callers that bypass the
   * broker are by definition not counted by the broker — which is precisely why
   * this signal resolves to INDETERMINATE rather than to an alert.
   */
  routableDemandInWindow: number | null;
}

/**
 * Classify a routing layer that is producing no decisions.
 *
 * The trap: zero routing decisions is consistent with a broken broker AND with a
 * broker nobody is calling, and those have completely different owners. A layer
 * that has decided things before and has simply gone quiet is far more likely to
 * be out of the caller's path than to be crashing — but "far more likely" is not
 * a determination, so this returns INDETERMINATE and names the measurement that
 * would settle it.
 */
export function assessRouting(f: RoutingFacts): SignalReport {
  const evidence = {
    decisions_in_window: f.decisionsInWindow,
    window_hours: f.windowHours,
    hours_since_last_decision: f.hoursSinceLastDecision === null ? null : round1(f.hoursSinceLastDecision),
    decisions_lifetime: f.decisionsLifetime,
    routable_demand_in_window: f.routableDemandInWindow,
  } as const;

  const t = classifyThroughput({
    observedInWindow: f.decisionsInWindow,
    backlog: f.routableDemandInWindow,
    hoursSinceLast: f.hoursSinceLastDecision,
    windowHours: f.windowHours,
  });

  if (t.determination === 'HEALTHY') {
    return {
      signal: 'routing.decisions',
      determination: 'HEALTHY',
      what: `${f.decisionsInWindow} routing decision(s) in the last ${f.windowHours}h`,
      why: t.why,
      actionableBy: 'nobody',
      evidence,
    };
  }

  if (f.decisionsLifetime === 0) {
    return {
      signal: 'routing.decisions',
      determination: 'INDETERMINATE',
      what: 'the routing layer has never recorded a decision',
      why:
        'no decision has ever been logged, so this cannot be a regression — it is either ' +
        'not wired into any caller path or not logging at all. Those have different owners ' +
        'and the counter cannot tell them apart',
      actionableBy: 'engineering',
      evidence,
    };
  }

  return {
    signal: 'routing.decisions',
    determination: 'INDETERMINATE',
    what:
      `no routing decision in the last ${f.windowHours}h, though ${f.decisionsLifetime} ` +
      `have been recorded historically`,
    why:
      `${t.why}. The layer has worked before, so it is not unbuilt; the two live ` +
      `explanations are that callers are bypassing it, or that it is failing silently. ` +
      `A decision counter cannot separate them — the measurement that would is the count ` +
      `of requests that took a routing-eligible path, counted at the CALLER rather than ` +
      `at the broker. Until that exists this stays INDETERMINATE rather than becoming ` +
      `an alert nobody can act on`,
    actionableBy: 'engineering',
    evidence,
  };
}

/* ────────────────────────────────────────────────────────────────────────────
 * Signal: a work queue that went quiet
 * ──────────────────────────────────────────────────────────────────────────── */

export interface WorkQueueFacts {
  pending: number;
  /**
   * Tasks COMPLETED in the window — not claimed.
   *
   * Two reasons, and the second is the load-bearing one. First, a claim that
   * never finishes is not throughput, so completions are the truer measure.
   * Second, `claimed_at` is unindexed on a table of several hundred thousand
   * rows: every count or ordering on it is a parallel sequential scan of the
   * whole table [V measured 2026-08-04], while `completed_at` is indexed and the
   * same questions answer in under a millisecond. A health check that reads an
   * entire table to report that nothing is happening is itself a load event.
   */
  completedInWindow: number;
  windowHours: number;
  /** Hours since the most recent completion, or null if there has never been one. */
  hoursSinceLastCompletion: number | null;
}

/**
 * Classify a task queue.
 *
 * This is the one signal here where idle and broken CAN be separated, and it is
 * worth being explicit about why: the queue publishes its own backlog. `pending`
 * is a direct measure of unserved demand, so zero completions against zero
 * pending is a provably-at-rest system, while zero completions against a
 * non-empty queue is provably a stopped one. Contrast `assessRouting`, where no
 * such number exists and the honest output is therefore INDETERMINATE.
 */
export function assessWorkQueue(f: WorkQueueFacts): SignalReport {
  const evidence = {
    pending: f.pending,
    completed_in_window: f.completedInWindow,
    window_hours: f.windowHours,
    hours_since_last_completion:
      f.hoursSinceLastCompletion === null ? null : round1(f.hoursSinceLastCompletion),
  } as const;

  const t = classifyThroughput({
    observedInWindow: f.completedInWindow,
    backlog: f.pending,
    hoursSinceLast: f.hoursSinceLastCompletion,
    windowHours: f.windowHours,
  });

  if (t.determination === 'STALLED') {
    return {
      signal: 'workqueue.throughput',
      determination: 'STALLED',
      what: `${f.pending} task(s) pending and ${f.completedInWindow} completed in ${f.windowHours}h`,
      why: `${t.why}. Work is queued and no worker is finishing it`,
      actionableBy: 'operator',
      evidence,
    };
  }

  if (t.determination === 'IDLE') {
    return {
      signal: 'workqueue.throughput',
      determination: 'IDLE',
      what: `the queue is empty and ${f.completedInWindow} task(s) completed in ${f.windowHours}h`,
      why:
        `${t.why}. Worker health is NOT established by this — an empty queue would look ` +
        `exactly like this whether the workers are running or stopped, so this says the ` +
        `system is not behind, and nothing more`,
      actionableBy: 'nobody',
      evidence,
    };
  }

  return {
    signal: 'workqueue.throughput',
    determination: t.determination,
    what: `${f.completedInWindow} task(s) completed in ${f.windowHours}h`,
    why: t.why,
    actionableBy: t.determination === 'HEALTHY' ? 'nobody' : 'operator',
    evidence,
  };
}

/* ────────────────────────────────────────────────────────────────────────────
 * Signal: is the liveness source itself alive?
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * Report on the heartbeat source before anything is concluded from it.
 *
 * This runs FIRST in the aggregate report on purpose. If the liveness input is
 * dead, every downstream "the fleet is quiet" reading is unsupported, and a
 * reader needs to know that before they read them — not in a footnote after.
 */
export function assessLivenessSource(
  hoursSinceLastHeartbeat: number | null,
  expectedCadenceHours: number,
  knownSources: number,
): SignalReport {
  const v = assessSourceFreshness(hoursSinceLastHeartbeat, expectedCadenceHours);
  const evidence = {
    hours_since_last_heartbeat:
      hoursSinceLastHeartbeat === null ? null : round1(hoursSinceLastHeartbeat),
    expected_cadence_hours: expectedCadenceHours,
    known_sources: knownSources,
    usable: v.freshness === 'FRESH',
  } as const;

  if (v.freshness === 'FRESH') {
    return {
      signal: 'liveness.source',
      determination: 'HEALTHY',
      what: 'the liveness source is being written and may be reasoned from',
      why: v.why,
      actionableBy: 'nobody',
      evidence,
    };
  }

  return {
    signal: 'liveness.source',
    determination: 'INDETERMINATE',
    what: 'the liveness source is not being written, so fleet liveness is UNKNOWN — not dead',
    why:
      `${v.why}. Every downstream reading that would otherwise be phrased as "the fleet is ` +
      `quiet" is unsupported while this holds: an absent writer and an absent fleet are the ` +
      `same empty table. Fleet health must be established from an independent probe, and any ` +
      `report claiming the fleet is alive or dead from this source alone should be disbelieved`,
    actionableBy: 'engineering',
    evidence,
  };
}

/* ────────────────────────────────────────────────────────────────────────────
 * Aggregate
 * ──────────────────────────────────────────────────────────────────────────── */

export interface StallSignalFacts {
  exchanges: ExchangeFacts;
  settlementCounting: SettlementCountingFacts;
  routing: RoutingFacts;
  workQueue: WorkQueueFacts;
  liveness: {
    hoursSinceLastHeartbeat: number | null;
    expectedCadenceHours: number;
    knownSources: number;
  };
}

export interface StallSignalReport {
  computedAt: string;
  /** Worst determination present, by the severity order below. */
  overall: Determination;
  /** One sentence naming what actually needs a human, and whose. */
  headline: string;
  signals: SignalReport[];
}

/**
 * Severity order. `INDETERMINATE` deliberately outranks `DEGRADED`: a thing we
 * cannot see is more dangerous than a thing we can see is wrong, because the
 * second is already on somebody's list.
 */
const SEVERITY: Record<Determination, number> = {
  HEALTHY: 0,
  IDLE: 1,
  DEGRADED: 2,
  INDETERMINATE: 3,
  STALLED: 4,
};

export function assembleReport(facts: StallSignalFacts, now: Date = new Date()): StallSignalReport {
  const signals: SignalReport[] = [
    // Freshness of the liveness input comes first: it governs how much weight a
    // reader may put on every "quiet" reading that follows.
    assessLivenessSource(
      facts.liveness.hoursSinceLastHeartbeat,
      facts.liveness.expectedCadenceHours,
      facts.liveness.knownSources,
    ),
    assessExchanges(facts.exchanges),
    assessSettlementCounting(facts.settlementCounting),
    assessRouting(facts.routing),
    assessWorkQueue(facts.workQueue),
  ];

  const overall = signals.reduce<Determination>(
    (worst, s) => (SEVERITY[s.determination] > SEVERITY[worst] ? s.determination : worst),
    'HEALTHY',
  );

  return {
    computedAt: now.toISOString(),
    overall,
    headline: buildHeadline(signals, overall),
    signals,
  };
}

/**
 * A headline is a routing decision, not a summary. It names the single signal a
 * reader should act on and who owns it, because "5 signals, 1 stalled, 2
 * indeterminate" is a count again — and counts are what nobody reads.
 */
function buildHeadline(signals: SignalReport[], overall: Determination): string {
  if (overall === 'HEALTHY') return 'All signals healthy.';

  const worst = signals
    .filter((s) => s.determination === overall)
    .sort((a, b) => a.signal.localeCompare(b.signal));

  const lead = worst[0];
  if (!lead) return 'All signals healthy.';

  const others = worst.length > 1 ? ` (+${worst.length - 1} more at this level)` : '';
  const owner =
    lead.actionableBy === 'nobody'
      ? 'nobody needs to act'
      : lead.actionableBy === 'unknown'
        ? 'the owner is not determinable'
        : `owner: ${lead.actionableBy}`;

  return `${overall}: ${lead.what} — ${owner}${others}.`;
}

/** Human-readable rendering for an operator log. Aggregates only. */
export function formatReport(r: StallSignalReport): string {
  const lines = [`[stall-signals] ${r.overall} — ${r.headline}`];
  for (const s of r.signals) {
    lines.push(`  ${s.determination.padEnd(13)} ${s.signal}`);
    lines.push(`      what : ${s.what}`);
    lines.push(`      why  : ${s.why}`);
    lines.push(`      who  : ${s.actionableBy}`);
  }
  return lines.join('\n');
}

/* ────────────────────────────────────────────────────────────────────────────
 * Collection — bounded reads only
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * The minimum surface this module needs from a Supabase client. Typed narrowly
 * and structurally rather than importing `SupabaseClient`, so that a test can
 * supply a fake without a database AND so that the type itself makes the
 * read-only intent legible: there is no `insert`, `update`, `upsert`, `delete`
 * or `rpc` in this interface to reach for.
 */
export interface BoundedReader {
  from(table: string): {
    select(
      columns: string,
      options?: { count?: 'exact' | 'planned' | 'estimated'; head?: boolean },
    ): any;
  };
}

const HOUR_MS = 3600_000;
const DAY_MS = 86_400_000;

/**
 * Every read below is `head: true` with an exact count, or a single-row
 * `limit(1)` for a max timestamp, and — separately — every predicate is chosen
 * to hit an index.
 *
 * Those are two different bounds and only the second one is hard. `LIMIT 1`
 * bounds what crosses the wire; it does not bound what the database reads. The
 * first draft of this file asked for the newest `claimed_at` on a table of
 * several hundred thousand rows, which returns one row and costs a parallel
 * sequential scan of the entire table [V measured 2026-08-04]. A health check
 * that reads a whole table to report that nothing is happening is itself a load
 * event, and this module is not entitled to a measurement bug of the kind it
 * exists to report. Predicates were moved onto indexed columns; the same
 * questions now answer in under a millisecond.
 *
 * Any failed read yields `null`, which the classifiers already treat as "cannot
 * determine" rather than as zero. That distinction is the entire point: a broken
 * query must never render as a healthy zero.
 */
async function boundedCount(
  db: BoundedReader,
  table: string,
  build: (q: any) => any,
): Promise<number | null> {
  try {
    const { count, error } = await build(db.from(table).select('*', { count: 'exact', head: true }));
    return error ? null : (count ?? 0);
  } catch {
    return null;
  }
}

async function latestTimestamp(
  db: BoundedReader,
  table: string,
  column: string,
): Promise<string | null> {
  try {
    const { data, error } = await db
      .from(table)
      .select(column)
      .not(column, 'is', null)
      .order(column, { ascending: false })
      .limit(1);
    if (error || !data || !data.length) return null;
    const v = data[0]?.[column];
    return typeof v === 'string' ? v : null;
  } catch {
    return null;
  }
}

/**
 * Hours between a timestamp and now.
 *
 * `assumeUtc` exists because one of the source columns is `timestamp WITHOUT
 * time zone` holding UTC instants. `Date.parse` reads a bare timestamp as LOCAL
 * time, which on a machine west of Greenwich makes a fresh row look hours old
 * and a stale one look fresher than it is — an age error large enough to flip a
 * freshness verdict. Callers must state which kind of column they read.
 */
export function hoursSince(iso: string | null, now: number, assumeUtc = false): number | null {
  if (!iso) return null;
  const normalised = assumeUtc && !/[zZ]|[+-]\d{2}:?\d{2}$/.test(iso) ? `${iso.replace(' ', 'T')}Z` : iso;
  const t = Date.parse(normalised);
  if (!Number.isFinite(t)) return null;
  return (now - t) / HOUR_MS;
}

export interface CollectOptions {
  windowHours?: number;
  /** How often the liveness source is expected to be written. */
  heartbeatCadenceHours?: number;
  now?: Date;
}

/**
 * Gather the aggregate facts with bounded reads. Read-only by construction:
 * `BoundedReader` exposes no write verb.
 *
 * A `null` anywhere in the result is meaningful and must be preserved, not
 * coalesced to `0` — see `boundedCount`.
 */
export async function collectFacts(
  db: BoundedReader,
  opts: CollectOptions = {},
): Promise<StallSignalFacts> {
  const windowHours = opts.windowHours ?? 24;
  const now = opts.now ?? new Date();
  const nowMs = now.getTime();
  const since = new Date(nowMs - windowHours * HOUR_MS).toISOString();

  const [
    fulfilledTotal,
    fulfilledBackdated,
    awaitingBuyer,
    strandedUnsettled,
    trulySettled,
    naiveSettledAtCount,
    oldestAwaitingIso,
    routingInWindow,
    routingLifetime,
    routingLatestIso,
    pending,
    completedInWindow,
    lastCompletionIso,
    heartbeatLatestIso,
    knownSources,
  ] = await Promise.all([
    boundedCount(db, 'service_contracts', (q) => q.eq('status', 'fulfilled')),
    boundedCount(db, 'service_contracts', (q) =>
      q.eq('status', 'fulfilled').not('settled_at', 'is', null),
    ),
    boundedCount(db, 'service_contracts', (q) =>
      q.eq('status', 'fulfilled').is('settled_at', null).is('buyer_satisfaction_score', null),
    ),
    boundedCount(db, 'service_contracts', (q) =>
      q.eq('status', 'fulfilled').is('settled_at', null).gt('buyer_satisfaction_score', 0),
    ),
    boundedCount(db, 'service_contracts', (q) => q.eq('status', 'settled')),
    // Deliberately reproduces the WRONG predicate — this module reports the
    // overcount, so it has to measure it.
    boundedCount(db, 'service_contracts', (q) => q.not('settled_at', 'is', null)),
    oldestAwaitingBuyer(db),
    boundedCount(db, 'anfis_routing_logs', (q) => q.gte('created_at', stripZone(since))),
    boundedCount(db, 'anfis_routing_logs', (q) => q),
    latestTimestamp(db, 'anfis_routing_logs', 'created_at'),
    // Both of these ride indexes. The obvious alternatives (`claimed_at`) do not.
    boundedCount(db, 'trinity_tasks', (q) => q.eq('status', 'pending')),
    boundedCount(db, 'trinity_tasks', (q) => q.gte('completed_at', since)),
    latestTimestamp(db, 'trinity_tasks', 'completed_at'),
    latestTimestamp(db, 'agent_heartbeat', 'last_ping'),
    boundedCount(db, 'agent_heartbeat', (q) => q),
  ]);

  const oldestAwaitingDays =
    oldestAwaitingIso === null ? null : Math.floor((nowMs - Date.parse(oldestAwaitingIso)) / DAY_MS);

  return {
    exchanges: {
      fulfilledTotal: fulfilledTotal ?? 0,
      fulfilledBackdated: fulfilledBackdated ?? 0,
      awaitingBuyer: awaitingBuyer ?? 0,
      strandedUnsettled: strandedUnsettled ?? 0,
      oldestAwaitingDays: Number.isFinite(oldestAwaitingDays as number) ? oldestAwaitingDays : null,
    },
    settlementCounting: {
      naiveSettledAtCount: naiveSettledAtCount ?? 0,
      trulySettled: trulySettled ?? 0,
    },
    routing: {
      decisionsInWindow: routingInWindow ?? 0,
      windowHours,
      // `created_at` on this table is timestamp WITHOUT time zone holding UTC.
      hoursSinceLastDecision: hoursSince(routingLatestIso, nowMs, true),
      decisionsLifetime: routingLifetime ?? 0,
      // No caller-side demand counter exists. Passing null is the honest input
      // and is what makes this signal resolve to INDETERMINATE rather than to a
      // confident and unactionable alert.
      routableDemandInWindow: null,
    },
    workQueue: {
      pending: pending ?? 0,
      completedInWindow: completedInWindow ?? 0,
      windowHours,
      hoursSinceLastCompletion: hoursSince(lastCompletionIso, nowMs),
    },
    liveness: {
      hoursSinceLastHeartbeat: hoursSince(heartbeatLatestIso, nowMs),
      expectedCadenceHours: opts.heartbeatCadenceHours ?? 1,
      knownSources: knownSources ?? 0,
    },
  };
}

/** Oldest `fulfilled_at` among exchanges still awaiting a buyer. One row, not a sweep. */
async function oldestAwaitingBuyer(db: BoundedReader): Promise<string | null> {
  try {
    const { data, error } = await db
      .from('service_contracts')
      .select('fulfilled_at')
      .eq('status', 'fulfilled')
      .is('settled_at', null)
      .is('buyer_satisfaction_score', null)
      .not('fulfilled_at', 'is', null)
      .order('fulfilled_at', { ascending: true })
      .limit(1);
    if (error || !data || !data.length) return null;
    const v = data[0]?.fulfilled_at;
    return typeof v === 'string' ? v : null;
  } catch {
    return null;
  }
}

/**
 * Compare against a zone-less column with a zone-less literal. Sending an
 * offset-bearing timestamp to a `timestamp WITHOUT time zone` comparison shifts
 * the window silently — the query succeeds and returns the wrong count, which is
 * the failure mode this module is supposed to catch rather than commit.
 */
function stripZone(iso: string): string {
  return iso.replace('T', ' ').replace(/(\.\d+)?Z$/, '');
}

/* ────────────────────────────────────────────────────────────────────────────
 * Helpers
 * ──────────────────────────────────────────────────────────────────────────── */

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

function capitalise(s: string): string {
  return s.length ? s[0]!.toUpperCase() + s.slice(1) : s;
}
