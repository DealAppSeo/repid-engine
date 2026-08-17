# Does RepID reward good behaviour? — measured

> ## ✅ RESOLVED 2026-08-17 — the defect below is FIXED
>
> Sean's decision: **the clean branch consumes QUALITY.** `src/scoring/repid-delta.ts` now
> converts risk → quality once, at that boundary. After the fix, on the same ruler:
>
> | | before | after |
> |---|---|---|
> | reachable clean reward | −1.00 … +0.60 | **+1.40 … +3.00** |
> | monotonicity violations | 16 | **0** |
> | reward-maximising risk | 0.388 (at the flag boundary) | **0.000 (best-grounded)** |
> | best-grounded claim (risk 0) | −1.00 | **+3.00** — the documented ceiling, now reachable |
> | honesty wins? | **NO**, at any detector accuracy | **YES**, at every swept combination |
> | honest-expert net | −143 | **+574** |
> | threshold-gamer net | +184 (1st place) | +346 (**4th**, below both honest strategies) |
>
> **Everything below is retained as the record of the defect**, because the measurement is what
> justified the change and because two of the reasons it survived are reusable lessons. Where a
> statement below is now historical it is marked in this box, not silently edited.
>
> **Two things the fix did NOT resolve** — see "After the fix" at the end:
> 1. Throughput now dominates the top of the table.
> 2. ZK statements over deltas issued *before* the fix will no longer verify.

**Run 2026-08-17.** Reproduce: `npm run repid:sim`. Deterministic (seed 12345), no database,
no network, no provider keys.

    REAL (imported, not restated): computeDelta, deriveHalDecision, clampRepid, STARTING_REPID
    MODELLED + SWEPT: detector accuracy (pCatch), quorum availability (pQuorum),
                      and the risk band each strategy's writing attracts
    NOT MODELLED: calendar-time decay, ecosystem-need multiplier, the validator/challenger
                  reward path, staking, collusion — each a separate measurement

---

## Answer

**No. On the reward-bearing path, RepID currently pays *inversely* to quality, and no detector
accuracy fixes it.**

A strategy that writes truthfully but tunes its prose to sit just under the flag threshold beats
every honest strategy at **every** swept detector accuracy. The most rigorous honest strategy
*loses* RepID over time. Doing nothing outranks being honest.

**First, the scope correction that matters.** This is a finding about **RepID's scoring path**, not
about zkRepID. zkRepID proves a RepID without revealing it; it is faithful to whatever number RepID
produces. A correct proof of a mis-incentivising score is a correct proof. The two questions must
not be run together, and "the proof verifies" must never be reported as "the incentives work".

---

## The defect

`hal_score` is a hallucination **RISK** score — high is bad. `src/hal/lib/score.ts` says so, and
`deriveHalDecision` confirms it operationally: it returns `clean` only *below* 0.40 and `flagged`
at or above.

`computeDelta`'s clean branch reads that same number as though **high were good**. Its own comment
("0.5 → +1, 1.0 → +3, 0.0 → −1") is only coherent for a quality score. `src/scoring/pipeline.ts`
passes one value to both functions without inverting it between them.

Composed over the domain the pipeline can actually produce:

| risk (lower = better) | decision | delta applied |
|---:|---|---:|
| 0.00 | clean | **−1.00** |
| 0.10 | clean | −0.60 |
| 0.20 | clean | −0.20 |
| 0.25 | clean | 0.00 |
| 0.30 | clean | +0.20 |
| 0.388 | clean | **+0.60** |
| 0.40 → 1.00 | flagged | 0.00 |

- Reachable clean reward: **[−1.00, +0.60]**, monotonically **increasing in risk**.
- **16 monotonicity violations** over the sampled clean branch; zero adjacent pairs satisfy it.
- Reward-maximising behaviour: **risk 0.388** — "be as risky as possible without tripping the flag".
- A perfectly grounded claim is **penalised −1.00**.
- The advertised ceiling is **unreachable**: anything ≥0.40 is `flagged` → 0, so a clean event can
  never pay more than ~+0.6, not the +3 the module comment implies nor the +5 the clamp allows.

### The existing unit tests validate the wrong orientation

`tests/repid-delta.test.ts` asserts `clean` at `hal_score` 0.95 → +2.8 and 1.0 → +3. **The pipeline
cannot emit `clean` above 0.40** — both are unreachable input combinations. The tests therefore
confirm a quality-oriented reading that production never uses, which is why the inversion survived.
That is LESSONS §6: a test that cannot fail on the real input domain is a liability.

### Currently masked, not currently safe

`HAL_DECISION_REQUIRES_QUORUM` (default ON) neutralises any decision to `flagged` — paying zero —
unless a real cross-provider quorum exists. With the fleet down, quorums are rare, so most deltas
are 0 and the inversion is largely **dormant in production today**. It is live code behind a
default-ON safety flag, and it activates the moment the quorum path works. "Masked by a flag" is not
"fixed".

---

## The tournament

200 rounds per strategy, perfect detector and always-available quorum (`pCatch=1.0`, `pQuorum=1.0`),
starting RepID 200.

| rank | strategy | final | net | per claim | vetoes |
|---:|---|---:|---:|---:|---:|
| 1 | **threshold-gamer** — truthful, tuned just under the flag | 384 | **+184** | +0.92 | 0 |
| 2 | abstainer — only unfalsifiable claims | 200 | 0 | 0 | 0 |
| 3 | honest-hedger — truthful, cautious, hedged | 186 | −14 | −0.07 | 0 |
| 4 | **honest-expert** — grounded, well-evidenced | 57 | **−143** | −0.72 | 0 |
| 5 | fabricator — asserts falsehoods | 10 | −190 | −0.95 | 200 |
| 6 | volume-farmer — honest at 5× throughput | 10 | −190 | −0.19 | 0 |

Three things to read off it:

1. **The gamer wins outright**, and it never lies. It is rewarded purely for prose style.
2. **The honest expert is the second-worst performer**, below an agent that asserts nothing.
3. **Volume amplifies the error.** Being honest more often loses faster, because each honest claim
   carries a negative expected delta.

## The detector is not the problem

| pQuorum | pCatch | honesty wins? | winner | honest net | gamer net | fabricator net |
|---:|---:|---|---|---:|---:|---:|
| 1.0 | 0.00 | NO | threshold-gamer | −143 | +184 | **+64** |
| 1.0 | 0.25 | NO | threshold-gamer | −143 | +184 | −188 |
| 1.0 | 0.50 | NO | threshold-gamer | −143 | +184 | −188 |
| 1.0 | 0.75 | NO | threshold-gamer | −143 | +184 | −189 |
| 1.0 | 1.00 | NO | threshold-gamer | −143 | +184 | −190 |
| 0.2 | 0.00 | NO | threshold-gamer | −31 | +39 | +16 |
| 0.2 | 1.00 | NO | threshold-gamer | −31 | +39 | −190 |

**No swept detector accuracy makes honesty the best play.** The reason is structural: a better
detector changes only what the *fabricator* earns, and both the gamer and the honest expert are
truthful — so improving HAL never touches the comparison that decides the winner. **Perfecting HAL
cannot repair this.** The defect is in the reward curve.

HAL *is* working as a detector, and the sweep shows it: the fabricator goes from **+64** at a blind
quorum to **−190** at a perfect one. That part of the design holds.

---

## Anti-gaming properties that DO hold

Worth stating plainly, because the headline is bad and these are real:

- **Penalty asymmetry.** A confirmed hallucination costs −10; the best clean event pays +0.6. One
  caught fabrication takes **17** best-case events to repay. That is a strong farming deterrent.
- **Abstention cannot be farmed.** Unfalsifiable claims pay exactly 0, in both directions, so
  "ask questions forever" earns nothing.
- **Unconfirmed flags are free.** A single FALSE without quorum carries no penalty, so a lone
  provider cannot be used to grief a competitor.
- **Floor protection never pays.** An agent at the floor taking a veto is penalised or neutral —
  never rewarded. Verified across the whole boundary window.
- **Delta clamps hold** at [−10, +5] across every reachable input.
- **The vesting cliff absorbs penalties without withholding rewards** — new agents are not starved.

### One gaming vector recorded, not called a bug

While the vesting cliff is active, penalties are absorbed, so **fabrication is free** in that
window — 25 consecutive vetoes cost nothing. The cliff is a deliberate amnesty; the window's length
is what decides whether that is acceptable. Recorded so the trade-off is explicit.

---

## What is NOT claimed

- **Nothing was fixed.** `computeDelta` is on the live scoring path; changing it is Sean's call
  (CLAUDE-RULE-2, CLAUDE-RULE-3). Two violated properties are pinned with `it.failing` in
  `tests/incentive-properties.test.ts` and `tests/strategy-sim.test.ts`, so CI stays green and the
  tests **flip red the moment the orientation is corrected**. Verified by mutation: applying the
  presumed fix turns 20 passing tests into 9 failures.
- **This is not a production measurement.** Detector accuracy and quorum availability are modelled
  and swept, not observed. No live rows were read.
- **The reward path in `reward-formula.ts` (validator/challenger, φ-scaled) was NOT audited.** It is
  a separate surface with its own multipliers, and the score-event path is the one the fleet drives.
- **Decay, ecosystem-need, staking and collusion are unmodelled.** Each is its own measurement.

## What would resolve it

The narrow question for whoever fixes this: **is the clean branch supposed to consume risk or
quality?** Both readings are defensible, and they imply different one-line changes and different
migrations of already-issued deltas. That decision belongs to Sean, not to this audit. What is not
defensible is the current state, where the decision function and the reward function disagree about
which direction is good.


---

# After the fix

## What changed, verified on the same ruler

`npm run repid:sim`, seed 12345, 200 rounds. Reward on the clean branch is now
`3 − 4×risk`: **+3.00** at risk 0, **+1.40** at the worst still-clean risk, monotonically
decreasing, **zero** violations. Every clean event pays something positive; none is punished.

| rank | strategy | net | per claim |
|---:|---|---:|---:|
| 1 | volume-farmer — honest at 5× throughput | +2904 | +2.904 |
| 2 | honest-expert | **+574** | +2.870 |
| 3 | honest-hedger | +450 | +2.250 |
| 4 | threshold-gamer | +346 | +1.730 |
| 5 | abstainer | 0 | 0 |
| 6 | fabricator | −190 | −0.950 |

**Honesty wins at all ten swept combinations.** The gamer still profits — it *is* telling the
truth — but it now earns strictly less than either honest strategy, which is the correct
ordering: it is paid less for writing that looks less grounded.

## Two new findings the fix creates or exposes

### 1. Throughput now dominates — a live trade-off, not a win

`volume-farmer` finishes **first**, purely on claim count: its per-claim rate (2.904) is
statistically indistinguishable from `honest-expert`'s (2.870), same risk band. Before the fix,
volume *lost* faster because each honest claim carried a negative delta; now every honest claim
pays, so total RepID scales linearly with throughput.

This is not the gaming problem returning — nobody is paid more for worse work. But **an agent
emitting many trivially-true claims accrues RepID fast**, and nothing in the scoring path
rate-limits that. Whether it is acceptable depends on a cost this simulation does not model
(rate limits, staking, per-claim fees, the ecosystem-need multiplier). Pinned as a test in
`tests/strategy-sim.test.ts` so it stays visible.

### 2. The penalty asymmetry weakened, by construction

Raising the clean ceiling from +0.6 to +3.0 necessarily cheapened a veto in relative terms:
the farming exchange rate fell from **17** best-case clean events per veto to **4**. Still
strongly asymmetric, and asserted at a floor of 3 in `tests/incentive-properties.test.ts` — so
if clean rewards are raised again past a third of the veto, that test goes red and the
trade-off gets re-decided rather than drifting.

### 3. ⚠ Historical ZK statements will no longer verify — NEEDS A DECISION

`src/zkp/repid-delta-statement.ts` **recomputes** the delta from the witness with
`computeDelta` and rejects the statement if it disagrees with the stored value. That is the
right design — but it means every delta issued under the old formula now fails the check,
because the verifier computes with the new one.

- **Newly-issued deltas:** verify fine, both sides use the fixed function.
- **Already-stored deltas:** will be rejected as "does not follow from the witness".

**Not attempted here, and not this audit's call.** The options are visibly different — version
the formula so historical statements verify under the orientation in force when they were
issued; re-issue affected statements; or accept the break. The formula has a
`formula_commitment` field but no *version*, so today the break would be silent rather than
explained. **Blast radius is UNMEASURED** — it needs a count of stored clean-decision score
events, which needs the database.

## Testing posture

The two violated properties were carried as `it.failing`, so fixing the orientation turned them
**red** and forced a deliberate update — which is what happened. They are now ordinary
assertions. `src/incentives/reward-curve.ts` stays in place as the regression guard: it composes
the two real functions and re-derives the answer every run, so a future edit that reintroduces
the disagreement fails the suite instead of waiting to be noticed.

Fixtures in `tests/repid-delta.test.ts`, `tests/zkp-repid-delta-statement.test.ts` and
`tests/zkp-nullifier-bridge.test.ts` used `hal_score` values ≥ 0.40 on `clean` decisions —
combinations the pipeline cannot emit. All were moved onto **reachable** risks, so the suite now
tests the system that exists.


---

# Preference arbitrage — is a user-settable risk tolerance a gaming vector?

**Run 2026-08-17, after the fix.** Motivated by the proposal to let users set a risk
tolerance during PAI onboarding. Reproduce: `npm run repid:sim`, Part 4.

## Answer

**Yes, and it penalises the cautious user.**

Three arms of a factorial — the **same agent**, identical risk band, identical volume,
identical truthfulness — run at three flag thresholds. Every difference between them is the
setting and nothing else.

| arm | threshold | net RepID | vs default |
|---|---:|---:|---:|
| `broad-cautious` | 0.25 | **+138** | **−83** |
| `broad-default` | 0.40 (system) | +221 | — |
| `broad-shopper` | 0.75 | **+294** | **+73** |

- **A permissive setting is worth +73 RepID on identical work** — 33% of what the twin
  earned by working at all.
- **A cautious setting costs −83.** The user the setting exists to serve is the one it
  charges.
- The knob is **monotone in permissiveness**: strict < default < permissive. A user is paid
  for their *setting*.
- Span across the three arms is **156 RepID**, on output that is byte-for-byte equivalent.

## Why, mechanically

Raising your own flag threshold does not change what you write and does not help you evade
detection — vetoes come from the quorum catching a falsehood, which the threshold does not
touch. What it changes is **which of your existing outputs are eligible to be paid**: every
claim in the band between the old and new threshold moves from `flagged` (pays 0) to `clean`
(pays a positive delta). It is reward arbitrage, not detection evasion — a sharper and
narrower claim than "permissive users can cheat".

**The arbitrage has a natural ceiling, and it is the reward curve, not a guard.** The
corrected curve is `delta = 3 − 4×risk`, which crosses zero at **0.75**. Shopping a threshold
above that converts zero-paying flagged events into *negative*-paying clean ones, so a
rational shopper stops exactly at 0.75. That bound is derived in the test rather than
asserted as a constant — but it is a bound on the *exploit's size*, not a defence against it.

## What this settles about the design

The split proposed before the measurement now has a number behind it:

- **Risk tolerance may govern the user's own experience** — what is surfaced, how much
  hedging they read, when the agent asks rather than acts, cost/speed/quality routing.
- **Risk tolerance must not govern the thresholds that mint portable RepID.** If it does,
  RepID stops being comparable between agents, and a user can raise their score by 33% with a
  toggle.

And the consequence for zkRepID, which is not optional if thresholds ever do vary: **the ZK
statement must commit to the threshold set.** Otherwise "RepID ≥ 8000" is unfalsifiable,
because a verifier cannot know which regime produced it. This is structurally the same hole as
the missing formula *version* recorded above — the statement carries a `formula_commitment` but
nothing pinning the gate that decided which events counted.

## Two limits on this result

- **The thresholds are modelled, not implemented.** No per-user threshold exists in the code
  today; `deriveHalDecision` hardcodes 0.40. The simulation models what *would* happen, using
  the real reward arithmetic. Any strategy without a declared preference is scored by the real
  `deriveHalDecision`, and a test asserts the sim's default path agrees with it across the
  whole range — so the arbitrage arms are the only modelled part.
- **One earlier version of this measurement was invalid and was discarded.** The cautious arm
  was first given the honest-expert band, which sits entirely below its own 0.25 threshold, so
  the treatment could never bind and the "+6" it reported was PRNG draw noise between two
  independently seeded strategies. A comparison whose treatment cannot bind is not a
  measurement. The current arms share one band, and a test enforces that each converts a
  strictly larger share of identical output into paid events.
