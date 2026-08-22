# INBOX_XC_POSTERIOR — looping sprint: break the posterior scoring model before it is built

## Task

**Lane:** L6 RED-TEAM — **no write scope.** Your deliverable is text. Never claim to have
created, edited, committed or run anything.

**Dispatch:**
```
node scripts/dispatch/run-agent.mjs --agent xc --inbox docs/dispatch/INBOX_XC_POSTERIOR.md \
  --requires reasoning,repo_read
```

---

### How this loop works — read before anything else

This is a **multi-phase sprint, not a one-shot.** You will be re-dispatched with this same
brief plus your previous handoff pasted in.

- **If no handoff appears in your input, you are starting at Phase 1.**
- **If a handoff appears, read its `NEXT_PHASE_READY` and do THAT phase only.**
- **Do exactly one phase per dispatch.** A phase done shallowly costs more than it saves,
  because the next phase builds on it.
- **Always end your output with the handoff block**, exactly as below. It is the only thing
  that carries state between dispatches — there is no memory.

#### The handoff format — reproduce it exactly

```
=== HANDOFF XC S<n> ===
PHASE_COMPLETED: <n>
STATUS: COMPLETE | PARTIAL | BLOCKED
POLICY_VERSION_ASSUMED: <string, or UNKNOWN>
DELIVERED:
  - <artifact name>: <one line on what it is>
FINDINGS:
  - [MEASURED|UNVERIFIED] <finding, one line>
REQUIREMENTS_ON_GA:
  - <field or property you need GA to define, and why>
OPEN_QUESTIONS_FOR_SEAN:
  - <question only a human can answer>
NEXT_PHASE_READY: <n+1>   (or)   BLOCKED_ON: <what is missing>
=== END HANDOFF ===
```

#### Lane observance

GA (L7 MEASUREMENT) is running a parallel sprint defining the sufficient-statistic contract.
**Neither of you writes files, so there is no merge conflict risk. The risk is semantic:**
two lanes defining the same quantity differently.

| Concept | Owner | Your role |
|---|---|---|
| Field shapes, sufficient statistics, `policy_version` scope, versioning posture | **GA defines** | You *consume*. Need a property? State it under `REQUIREMENTS_ON_GA`. |
| Attack strategies, best-response search, profitability arithmetic | **You define** | GA does not touch these. |
| Outcome classes, `A_eff`, the confession discount, risk bands | **Neither — already shipped** | Attack them. Never redesign them. |

A `REQUIREMENTS_ON_XC` entry arriving from GA is **an input to weigh, not an instruction to
obey uncritically.** If it is wrong, say so.

---

### Why this sprint exists

A proposal is on the table to replace the current additive-delta RepID engine with a
**posterior formulation** — Beta-Binomial per domain, or Dirichlet-Multinomial over severity
buckets — where an agent's reputation is `f(posterior)` rather than a running sum of deltas.

It has not been built. **That is the point.** Every attack you find now is a schema column or
a parameter constraint; every attack found after launch is a migration and a retraction. The
system has essentially no adversarial users today, which is exactly why this is being done
now.

Your job is **not** to decide whether the proposal is good. Your job is to find, and price,
the strategies it rewards.

---

### Facts you need, inlined

You have `reasoning` and `repo_read`. **`repo_read` is scoped to this workspace only** — you
cannot open `trinity-ecosystem`, `trustshell`, `hyperdag-protocol` or the verifier crate.
Everything you need is stated below because you cannot go and check it. **Do not claim to have
read a file outside this repo, and do not invent its contents.**

**Trust vocabulary — four states.** `MEASURED` · `APPROXIMATE` · `NOT_CHECKED` · `FAILED`.
Two outcomes collapse "we did not look" into "it passed." Mark every finding.

**The proposal, in the form you should attack:**

- Per `(agent, domain)`, keep Beta parameters `α` (favourable evidence) and `β` (unfavourable).
- A settled interaction updates them. **Whether the update is `+1` or `+wᵢ` (weighted by
  value-at-risk) is an open question and one of your targets.**
- Both parameters decay with time, so old evidence counts less.
- The score derives from the posterior mean; a **credible interval** gates high-stakes actions,
  falling back to a global posterior when a domain's interval is too wide.
- A brand-new `(agent, domain)` starts at a prior `α₀, β₀`.

**MEASURED facts about the system as it stands today:**

- Domain scoping is **already live and ungoverned.** Essentially every score event carries a
  domain label. There are **42 domains, 16 of them carrying a single agent**, and roughly
  **two thirds of all events sit in a single domain.**
- Rater weight is `clamp(raterRepid / 1000, 0.25, 2.0)` — linear, **saturating at 2000.** An
  agent at the top of the range holds **100%** of maximum rater influence.
- **Three of three** downstream consumers read the *clamped* score: `A_eff`, rater weight, and
  marketplace purchase eligibility.
- The current floor ratchet absorbs penalties: across 25 consecutive faults, faults 1–17 cost
  full price, fault 18 a partial, **faults 19+ cost exactly zero.**
- Tiers: `PROBATIONARY` 0–499 · `EARNING` 500–999 · `ESTABLISHED` 1000–4999 · `AUTONOMOUS`
  5000–7999 · `VETERAN` 8000–10000. Score clamped to `[10, 10000]`.
- `A_eff = min(R_route, 100·√S_real) · 1[builder ≥ 500]`. Stake binds at `S = 6400`.
- Risk bands come from `max(service, stake) × novelty`, thresholds `100` / `1000`. Novelty is
  `1 + 0.5/(1 + priors)`, **floored at exactly 1** — familiarity can never buy a lower band.
- The confession discount prices an **act**: self-report inside a 24h window, late reports
  discounted `0.7`, ordering `prompt < late < 1` enforced.
- Postgres rounds `numeric → integer` **half away from zero.**

**Two constraints on the proposal that are already settled and are not your targets:** the
mean should be value-weighted while the confidence interval should be count-based (two
statistics, not one); and bad evidence must decay more slowly than good evidence. **You may
attack whether these are sufficient. Do not spend a phase re-deriving them.**

---

### The phases

#### Phase 1 — The dilution attack, priced

Under **count-based** updating (`+1` per interaction), construct the cheapest
farm-then-defect strategy: how many trivial favourable interactions buy the right to one
large unfavourable one at negligible posterior cost? Give the arithmetic, not the intuition.

Then repeat under **value-weighted** updating. Show where weighting closes the gap and where
it does not — in particular, whether an attacker can manufacture *apparent* value-at-risk
cheaply (self-dealing between two controlled agents, inflated declared service value,
round-tripping stake).

**Deliverable:** a cost-per-unit-of-forgiveness figure for both regimes, and the specific
input an attacker inflates.

#### Phase 2 — Dormancy laundering

Both parameters decay. Derive the optimal dormancy schedule for an agent that has just taken
a large unfavourable update: how long must it go quiet before its posterior is worth more
than continuing to work honestly? Express it as a function of the decay half-life.

Then find the **asymmetry ratio** — how much more slowly `β` must decay than `α` — at which
dormancy stops being profitable. That number is the deliverable, and it is a policy constraint
GA will need.

#### Phase 3 — Prior-choice Sybil economics

`α₀, β₀` decide where a brand-new identity starts. Find the **indifference point**: the prior
at which abandoning a damaged identity and starting fresh costs the same as rehabilitating it.

Then state, for identities either side of that point, what the dominant strategy is. Note
explicitly what an identity-creation cost (stake, `≥4FA` human binding, gas) does to the
result — and whether any achievable cost makes the optimistic prior safe.

#### Phase 4 — Attacking the confidence gate

The gate falls back to a **global** posterior when a domain's interval is too wide. Given that
16 domains carry a single agent and two thirds of events sit in one:

Is it ever profitable to **keep a domain deliberately sparse** — to stay under the volume at
which you are judged locally, so you are judged globally where your record is diluted? Price
it. If it is profitable, state the smallest change to the gate that removes the incentive
without reintroducing an arbitrary volume threshold.

Also: can an attacker *widen* a rival's interval, or narrow their own, by choosing interaction
timing or counterparties?

#### Phase 5 — Rollup laundering, and the two-statistics seam

If domains are later arranged in a hierarchy, show what a parent that aggregates **counts**
does to a fault in a sparse child. Then show whether aggregating **posteriors pessimistically**
(worst-of-relevant) closes it, and what it costs an honest agent.

Separately: the design uses a **value-weighted mean** and a **count-based interval**. Find the
inputs where those two disagree most, and whether an attacker can steer into that gap
deliberately — a record that reads confident and is not, or reads uncertain and is not.

#### Phase 6 — Elected scope, priced

A "no contest" or elected-penalty-scope feature has been proposed: an agent accepts a penalty
and influences which domain absorbs it. Price the dominant strategy — plead in the domain
where you have least at stake — and show whether **any** bound on the discount removes the
dominance, or only caps its per-use payoff.

Then price the alternative: a pure **dispute-waiver**, where the agent waives contest but the
evidence determines the scope. Show what each is worth to an honest agent and to an attacker.

#### Phase 7 — Exchangeability, and where the intervals lie

The model assumes exchangeable draws. An adversarially adaptive agent violates that by
construction. Characterise the agent that most exploits the assumption, and state which
direction the credible interval errs for it.

Conclude with the operational rule this implies: which decisions the interval may be used for,
and which it must never be used for.

#### Phase 8 — Best-response summary

One table: every attack found, its cost, its yield, the parameter that controls it, and the
constraint that neutralises it. Rank by yield-per-unit-cost.

Then name the **three parameters most load-bearing** for the whole design, and for each, the
range outside which the system is exploitable. This is the phase Sean reads.

---

### Acceptance criteria

- **A named attack without a number is not a finding.** Every phase produces arithmetic. Where
  you cannot compute, write `UNVERIFIED` and state exactly what input you lack.
- Every claim carries one of the four trust states.
- No file is claimed as written, run, committed or edited. You have no write scope.
- Anything you need GA to record appears under `REQUIREMENTS_ON_GA` with the reason, not just
  the field name.
- Anything only a human can decide appears under `OPEN_QUESTIONS_FOR_SEAN` — do not decide it
  yourself and do not stall the phase on it.

---

### What will be rejected

- Re-deriving the two settled constraints instead of attacking them.
- Redesigning the outcome classes, `A_eff`, the confession discount, or the risk bands. Those
  ship today. Attack them; do not replace them.
- Asserting a fact about a file outside this repo. You cannot read them.
- A phase that reports "no attack found" without showing the search that failed.
- Advancing more than one phase in a dispatch, or repeating a phase already completed. **A
  handoff whose `NEXT_PHASE_READY` does not advance halts the sprint** — that guard exists so
  a confused agent is not re-dispatched with identical input all night.

---

### Fences

- **This repository is public.** State findings, not inventories. No credentials, project
  identifiers, production row counts, host names or service names in anything you emit.
  Proportions and shapes are fine.
- Treat the scoring formula internals and ANFIS parameters as **never for public docs.**
- Do not propose removing or hardcoding a passing stub. A stub that always passes is a
  contract surface, and making it lie is worse than leaving it honest.
