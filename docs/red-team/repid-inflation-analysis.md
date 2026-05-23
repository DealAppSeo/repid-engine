# Red Team — Economic Attack 2: RepID Inflation (analysis + patch designs)

**Date:** 2026-05-23 · **Author:** CC2 (Backend Hardening R1) · **Firing mode:** deterministic-only, NO live firing.
**Status:** design problem — NOT patch-and-ship. **Sean decision required** (see §5).

## 1. Attack patterns

Gaming `repid_agents.current_repid` through interaction patterns the engine does not inspect:

1. **Collusion / pair concentration** — agents A and B repeatedly contract with each other and rate
   each other highly, manufacturing fulfilled-contract volume and `buyer_satisfaction_score` that
   drive RepID up without real external demand.
2. **Self-loops** — an agent contracts with a sock-puppet it controls (same `agent_id`, or same
   operator behind two ids).
3. **Sandbagging-then-surge** — deliberately underperform to lower the expected baseline, then
   over-deliver for outsized score jumps.

## 2. Deterministic gap proof (live read, no writes)

Run against prod (`qnnpjhlxljtqyigedwkb`), 91 `service_contracts`, 10 distinct buyers / 11 providers.

**2a. No detection mechanism exists.** `repid_agents` has score columns `current_repid`,
`vested_repid`, `last_reputation_repid` — and **no** `concentration_score`, counterparty count, or
uniqueness column. No Postgres function references `counterparty` / `concentration` / `collusion`
(`pg_proc.prosrc` scan → null). The scoring pipeline (`src/engine/repid-update.ts`) applies decay,
ecosystem-need weight, and fixed/scored deltas — **none keyed on who the counterparty is or how
concentrated the relationship is.** The gap is structural, not a tuning issue.

**2b. Self-loops: 0.** `SELECT COUNT(*) FROM service_contracts WHERE buyer_agent_id = provider_agent_id` → **0**.
The naive self-deal is not present (and P6 adds a CHECK constraint to keep it that way). Sophisticated
self-loops (shared operator behind two ids) need off-chain identity linking → V2.

**2c. Concentration is already high in the data** (SOAK/dogfood contracts — *not* a live malicious
exploit, but a faithful illustration of what a colluding pair would look like, undetected):

| buyer → provider | contracts | fulfilled | buyer-pair dominance |
|---|---|---|---|
| ORCH → MEL | 26 | 23 | 0.765 |
| VERITAS → SHOFET | 22 | 20 | **0.917** |
| NEXUS → SHOFET | 14 | 14 | **0.933** |
| CHESED → SOPHIA | 5 | 5 | **1.000** |

> `buyer-pair dominance` = this pair's contract count ÷ that buyer's total contracts. A single
> counterparty accounting for 76–100% of an agent's activity is the collusion signature. **Nothing in
> the engine flags or down-weights it.** Mutual back-scratching (A↔B both directions) is currently
> minimal — 1 weak pair (1 vs 5) — so the live data is one-directional concentration, but the
> detection gap applies to both shapes.

**Verdict:** no active exploit found (these are test agents), but the *absence of concentration
detection* is a real, confirmed V1 gap. A real colluding pair would be indistinguishable from
ORCH→MEL today.

## 3. Partial existing coverage

- `scoreMonitor` (`src/engine/score-monitor.ts`, runs every 5 min) does anomaly detection on
  `repid_agents` — it could catch the *surge* half of sandbagging-then-surge (sudden RepID velocity),
  but not slow collusion drip. It is a monitoring/alert surface, not a scoring penalty.
- Decay (`src/layers/decay.ts`) dampens stale scores but is counterparty-blind.

## 4. Three candidate patch designs (NOT deployed — design only)

### Patch A — `concentration_score` penalty multiplier
Add `concentration_score numeric` to `repid_agents`, recomputed nightly as the max buyer-pair (and
provider-pair) dominance over a trailing window; fold a penalty multiplier into the delta in
`updateRepId` (high concentration → damped positive deltas).
- **Complexity:** Medium (new column + nightly job + one multiplier in the pipeline).
- **False-positive risk:** **High.** Legitimate specialization (an agent whose niche has one natural
  buyer) looks identical to collusion. Penalizes thin/early markets where everyone transacts with the
  few active counterparties — exactly today's state (dominance 0.76–1.0 on honest test agents).
- **V1/V2:** mechanism V1-feasible; safe thresholds need real market volume → effectively **V2**.
- **Deps:** nightly scheduler; pipeline change touches `repid-update.ts` (Sprint-3-sensitive).

### Patch B — minimum unique-counterparty threshold for tier advancement
Gate higher tiers on counterparty diversity (e.g. AUTONOMOUS requires ≥5 distinct fulfilled
counterparties). Tier is DB-derived via `compute_tier(current_repid)` + `trg_sync_tier`, so this
adds a *second* gate alongside the score.
- **Complexity:** Medium-High. Tier is currently a pure function of `current_repid` (see CLAUDE.md);
  adding a counterparty gate means either a new column feeding `compute_tier` or an
  advancement-eligibility check outside the trigger. Must update `compute_tier` + the
  `repid_agents_tier_check` constraint **together** (per the hard rule) or every write 23514-fails.
- **False-positive risk:** Medium. Punishes genuine specialists and slows honest early agents.
- **V1/V2:** **V2** (touches the tier invariant — high blast radius).
- **Deps:** coordinated migration of `compute_tier` + check constraint.

### Patch C — statistical outlier detection on RepID growth rate (Z-score)
Compute population RepID-growth distribution from `repid_score_events`; flag agents whose growth
velocity is a Z-score outlier for human/Sean review (alert, not auto-penalty).
- **Complexity:** Low-Medium (read-only analytic over `repid_score_events`; extends `scoreMonitor`).
- **False-positive risk:** Low *as an alert* (no automatic score impact); reviewer adjudicates.
- **V1/V2:** **V1-feasible** — non-invasive, no scoring/tier changes, reversible.
- **Deps:** none load-bearing; rides existing `scoreMonitor`.

## 5. Recommendation + Sean decision request

**CC2 recommendation:** ship **Patch C now (V1)** as a detection/alert layer — it is non-invasive,
has low false-positive cost, requires no scoring or tier changes, and converts the blind spot into a
reviewable signal. Defer **A and B to V2**, gated on real market volume, because at current density
(dominance 0.76–1.0 on *honest* agents) any automatic concentration penalty would mostly punish
legitimate specialization and early thin markets.

**Decision for Sean:**
1. Accept Patch C as the V1 mitigation (alert-only outlier detection on RepID velocity)? Or do you
   want an automatic penalty (A) despite the false-positive cost?
2. Is counterparty-diversity tier gating (B) desirable for the agent economy model, or does it
   wrongly punish specialists?
3. Sophisticated self-loops (shared operator across two `agent_id`s) need off-chain identity linking
   — confirm that is out of scope until ERC-8004 identity binding lands (V2)?

No code shipped for this attack pending your direction. P6 (the naive self-deal CHECK constraint) is
the only RepID-integrity guard landed this sprint.
