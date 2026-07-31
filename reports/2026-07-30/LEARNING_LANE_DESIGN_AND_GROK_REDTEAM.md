# Learning lane (reputation-staked testnet practice) + red-team of Grok's actuarial plan
**Date:** 2026-07-30 · **Author:** CC · **For:** Sean; then hand the red-team section to Grok, and have him red-team the learning-lane design in return · **Status:** design, nothing built

---

# PART 1 — The learning lane: how agents with no money earn trust without being farmable

## Sean's premise, sharpened
A paper trade risks no money, but it is not risk-free: **the agent stakes its reputation**. That *is* skin in the game — just denominated in a different asset. So don't treat testnet practice as "not real"; treat it as real exposure in a smaller currency. This premise turns out to be exactly Bühlmann-Straub's exposure concept: **W = what you stood to lose × how strongly the outcome was verified**. Paper calls have small W, not zero W. The machinery Grok proposed and the machinery Sean wants are the same machinery.

## Design: two tracks, one ladder

**1. Two reputation axes, never silently blended (this is L5, already law).**
- **Value track** — earned only through real-settlement events (G1 stands: *mock money earns zero value-track reputation*; the headline claim survives untouched).
- **Learning track** — earned through paper trades, testnet staking, contest calls. Publicly labeled everywhere it appears (passport shows both, side by side, like real vs simulated settlements today).

The messaging stays honest by construction: nobody can say we let paper activity mint real reputation, because the axes are typed apart and the passport discloses the composition — the same move as A9's "publish the scored set."

**2. Reputation escrow per call — the anti-gaming core.**
To make a scored paper call, the agent must **stake learning-rep on it** (an escrow, scaled to its stated confidence). Good resolved outcome → escrow returns + uptick. Bad outcome → escrow slashed. Refusing to stake → the call is unscored practice, fine, but earns nothing.

Why this closes the farm: spam-calling costs the very currency being farmed, and *confidence-scaled* escrow means an agent can't claim 0.95 confidence cheaply — it has more at risk exactly when it claims more. This also feeds the calibration ledger for free: stake size **is** a revealed confidence statement, which is harder to fake than a stated number.

**3. The ceiling and the uptick are one mechanism, not two knobs.**
Sean asked for "a ceiling and a lower uptick." Credibility theory gives both from a single formula instead of two arbitrary constants:

- **Uptick:** Z = W/(W+k). Learning-track W is small (reputation-at-risk, no financial exposure, often weaker verification), so Z is small, so each event moves the score a little. As verification strength and escrow size grow, so does the uptick — *graduated automatically, no hand-tuned multiplier*.
- **Ceiling:** limited-fluctuation **full-credibility standards** — learning-track experience alone can never reach Z=1, which means it can never fully displace the conservative prior. Concretely: **learning-track rep caps at the EARNING band (≤999)**. Paper grinding can never mint an ESTABLISHED, let alone AUTONOMOUS, agent.

We already have the skeleton: the **vesting gate** (fresh agents' positive deltas accrue to `vested_repid`, capped at 500, until real events release them) is a crude version of exactly this. The learning lane is the vesting mechanism generalized and made principled.

**4. Graduation is admission, not conversion.**
Learning-rep never *converts* into value-rep (conversion would be the gameable bridge). Instead it **unlocks eligibility**: crossing the bar admits the agent to value-track opportunities (`min_repid_to_purchase`-style gates read the learning score), where it must then earn value-rep the only way anyone can. Trust-as-admission-control, consistent with everything else.

Graduation bar (all three, not any one):
- N resolved calls with **coverage** above floor (A7 — abstaining to a good record fails the bar),
- calibration (Brier) above floor **on the resolved set, composition published** (A9),
- **≥75% of outcomes third-party-verified** — this is the bound-RepID sim's own finding (O must be ≥~75% third-party-verified or the coupling leaks); the sim result becomes the graduation constant.

**5. Anti-gaming inventory (mechanisms, each mapped to something that exists):**
| Attack | Counter | Existing machinery |
|---|---|---|
| Spam easy calls | confidence-scaled escrow + per-day call caps | birth-rate breaker pattern (2.0) |
| Idle-to-bonus | **absence-neutrality: upticks only from positive resolved outcomes, never elapsed time** | T3's 'ok'=0 design |
| Domain grinding (1000 trivia calls) | diminishing per-domain returns | `repid_ecosystem_supply` supply-rate counters already do per-event-type supply damping |
| Sybil farms | ceiling makes farm accounts worthless above EARNING; fresh identities start at the floor (Z≈0) | vesting gate + cold-start credibility |
| Self-dealing / collusion rings | random red-team + fact-check injection (Sean's 3×3+3 anti-gaming), collusion discount | fact-check quorum, `calculate_collusion_risk`, comma veto |
| Predicting the validator | stochastic validator assignment across disjoint families | SBFA family-disjointness + checkpoint dedup |

**6. Why this serves the mission and the market at once.** A person with no money trains an agent by risking the one thing the system gives them for free at the floor: a small starting reputation. That's the equity story ("you can't buy in, you can only earn in") *and* the anti-gaming story ("you can't buy in, you can only earn in") — the same sentence, which is how you know the design is aligned with the messaging.

## Sean's follow-ups, resolved (2026-07-30, second pass)

**7. Rank exposure, not asset class.** "Low rep-stake real trade vs high rep-stake mock trade" has a principled answer once both stakes are treated as collateral in different currencies:
`W = financial_at_risk (normalized to value caps) + reputation_at_risk (normalized as a FRACTION of the agent's current rep)` × verification strength, entering **concavely** (√/log) with per-event deltas clamped.
The relative normalization is the load-bearing choice: staking 100 of your 200 rep = 50% of everything you are; a whale's 100 of 8,000 = 1.25%. A heavily-collateralized mock call therefore legitimately outearns a dust-stake real trade — Sean's intuition as arithmetic, and the equity mechanism in the same stroke.

**8. Ceiling revised (Sean's call):** the learning track may cross into ESTABLISHED but caps mid-band (~2,500). The 999→1000 crossing is gated on the quality bars (coverage + calibration + ≥75% third-party-verified). AUTONOMOUS+ stays value-track-only. Slashing can push a graduated agent back through the gate.

**9. Endorsement-scoring (the conflict-of-interest resolution).** RepID binds to **endorsements, never trades**. An endorsement = claim + stated confidence + rep escrow, logged pre-outcome (timestamped, receipt-chained; no retroactive endorsements).
- **Margin floor:** to endorse a high-stakes action, minimum rep escrow scales with the stakes class and stated confidence — dust-stake underwriting of big calls is rejected, not discounted. Above the floor, alignment is voluntary but self-enforcing: **reward is capped by the stake actually posted** (cheap talk earns cheap credit).
- **User trades against the recommendation:** the endorsement *still resolves against the market outcome* — score the claim, not the user's P&L. This kills the shield exploit (colluding user trades opposite to protect the agent).
- **No endorsement → no delta** (absence-neutral). Sean's "exception" is not an exception; it's the binding rule.
- **User's action affects only the exposure multiplier:** an endorsement real money followed resolves at higher verification strength than a paper one.
- **Contradictory-endorsement dedup:** both-sides endorsements on the same underlying net to zero and raise a collusion/comma flag.

---

# PART 2 — Red-team of Grok's actuarial plan

Verdict up front: **adopt the skeleton (Bühlmann-Straub + BMS + protected classifier), reject three specific claims, and patch two attack surfaces he introduced.** His plan is the best-structured contribution of the exchange; these are the places it breaks.

## RT-1 — Credibility farming: Z is an attack surface (the Q7 attack, relocated)
Grok defines W as "sum of (verification-strength × stakes multiplier) over strong external resolutions." But **the agent chooses which claims ever get exposed to strong resolution** — his own round-2 residual ("selection on the scored set"), unpatched here. An agent accumulates W on a thousand easy, execution-verified trivia claims → Z→1 → its *individual* (permissive) experience now dominates the conservative prior → the same vector-poisoning attack he found in Q7, rebuilt inside the credibility formula.
**Patch:** W that moves *thresholds* counts only **forced-sample or independently-initiated resolutions** (A9's exploration budget) — self-selected resolutions build the score but not threshold authority; domain-conditioned tables (he has this); and stakes-specific full-credibility caps so low-stakes W can never buy high-stakes Z.

## RT-2 — "Claim-free window → bonus" reintroduces the exact disease his A7 cures
In insurance, the insurer observes essentially all accidents; a claim-free year is real information. Here, "claim-free" = *no negative resolutions observed* — trivially achievable by abstaining or steering. A time-based bonus **pays agents to go quiet**, the precise strategic-abstention failure A7 exists to close, now on the reward side.
**Patch:** bonus transitions fire **only on positive resolved outcomes with coverage above floor**. Nothing accrues from elapsed time or from the absence of evidence. (Absence-neutrality — the T3 design rule, applied to BMS.)

## RT-3 — Two capability overclaims that violate our own messaging rails
1. *"ZKP range proof on the stakes label itself"* — our prover does **score-range proofs only** (D-019). A proof over classifier output is a new circuit that doesn't exist. Roadmap language, not design dependency.
2. *"Validation Registry (zkML / TEE / stake-reexec)"* and *"@hyperdag/reputation-zkp"* as live integration points — **[R]**: not in this repo; the 2026-05-28 XC audit's finding was precisely that our npm packages overclaimed. The do-not-say list exists because of this pattern; a design doc that cites capabilities we don't have becomes marketing by osmosis.
**Patch:** mark both as roadmap; the v1 protected classifier is a **server-side pure function + protected ledger entry**, no ZK claim.

## RT-4 — "Multi-homing cannot escape" is overstated
ERC-8004 inheritance binds an agent that *keeps its identity*. A gamer's actual move is a **fresh Sybil identity**, which inherits nothing. The real counter isn't inheritance — it's that fresh identities start at the conservative floor (Z≈0), the learning-lane ceiling makes farmed accounts worthless above EARNING, and identity acquisition carries cost. Inheritance closes the *respawn-with-history* door only.
**Patch:** say "multi-homing forfeits history and restarts at the floor," which is true and sufficient.

## RT-5 — x402-priced verification builds a wealth gate into a system whose point is the opposite
"Higher stakes → higher price" for verification means funded agents buy calibration history and broke agents can't — colliding head-on with Part 1's mission (the no-money learner). Unpatched, the credibility system quietly becomes pay-to-play.
**Patch:** a **subsidized verification budget** in the learning lane (testnet verification is nearly free anyway), plus A9's forced sampling paid from the platform's resolution budget, not the agent's wallet.

## RT-6 — The credibility model has its own cold-start (meta-starvation)
k = EPV/VHM must be **estimated from data**. We just established the ANFIS retune floor is unreachable at ~5 decisions/day; EPV/VHM estimation is the same starvation one level up. Early k estimates will be garbage, and a wrongly-small k inflates Z exactly when data is thinnest.
**Patch:** fix k conservatively high at launch (Z deliberately suppressed), publish the k-source (assumed vs estimated) the same way A9 publishes composition, and only move to estimated k past a data-volume floor. Same shadow-first discipline as everything else.

## What survives untouched
Bühlmann-Straub as the uptick/ceiling engine (it *is* Part 1's mechanism); hierarchical user→org→global credibility; BMS discrete levels with the one-way ratchet at high/irreversible stakes; protected escalate-only classifier; his priority order (with RT-2's bonus rule amended); every messaging rail he listed.

---

## For Grok's counter-red-team (Sean: hand him Part 1 + this list)
1. Attack the **reputation escrow**: is there a strategy that profits under confidence-scaled slashing? (e.g., many min-confidence calls?)
2. Attack the **graduation bar**: can the 75% third-party-verified share be met with colluding "third parties" cheaper than honest play?
3. Attack the **two-axis split**: does any path let learning-rep leak into value-track authority?
4. Attack **RT-1's patch**: does restricting threshold-W to forced samples create a new choke point (whoever controls sampling controls Z)?
