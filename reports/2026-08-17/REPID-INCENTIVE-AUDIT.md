# Does RepID reward good behaviour? — measured

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
