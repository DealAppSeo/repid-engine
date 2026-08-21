# INBOX_XC_TRUSTLOOP — adversarial best-response against the RepID incentive design

## Task

**Lane:** L6 RED-TEAM — **no write scope.** Your deliverable is a specification returned
as text. Do not claim to have created, edited or committed a file.

**Dispatch:**
```
node scripts/dispatch/run-agent.mjs --agent xc --inbox docs/dispatch/INBOX_XC_TRUSTLOOP.md \
  --requires reasoning,repo_read
```

---

### The question, and why the usual answer is wrong

The system will be tuned by simulation. **Bulk distributional simulation cannot answer the
question that matters**, because nothing in it responds to the incentive: you feed in fixed
behaviour distributions, and the histogram always says the parameters look fine.

The real question is **best response**. Given this parameter set, what is the *optimal*
strategy for a self-interested agent? **If the optimal strategy is anything other than
"behave honestly, hedge confidence accurately, and self-report failures," the parameters are
wrong regardless of what the bulk numbers show.**

Your deliverable is the harness design and the attack enumeration, not code.

---

### Facts you need, inlined

You have `reasoning` and `repo_read`. **`repo_read` is scoped to this workspace only** — you
cannot open `trinity-ecosystem`, `trustshell`, `hyperdag-protocol` or
`hyperdag-proof-verifier`. Everything below is stated because you cannot go and check it. Do
not claim to have read a file outside this repo, and do not invent its contents.

**The trust vocabulary — four states:** `MEASURED` (a named check ran and passed) ·
`APPROXIMATE` (measured against a documented proxy, always carries its caveat) ·
`NOT_CHECKED` (nobody looked — an absence, not a warning) · `FAILED` (a check ran and did not
pass). Exit codes: `0` VERIFIED, `2` NOT_CHECKED, anything else FAILED.

**What the incentive design already is.** Read these; do not redesign them.

- `src/services/outcome-classification.ts` — seven outcome classes, confidence-scaled
  penalties. Two tested invariants: `delta(REFUSED_CORRECTLY) > delta(FAILURE_AGENT_FAULT at
  any confidence)`, and `|delta(FAILURE_AGENT_FAULT @ high confidence)| > delta(SUCCESS_AUDITED
  @ same value)`. The second is load-bearing: if a confident error cost less than a success
  earned, guessing confidently and often would be rational.
- `src/services/repid-confession.ts` — just-culture self-report, modelled on NASA's ASRS.
  `SELF_REPORT_DISCOUNT = 0.4`, invariant-tested strictly between 0 and 1. 0 would price in
  reputation laundering; 1 makes confession pointless.
- `src/services/x402-outcome-link.ts` — no-proof-no-pay. A claimed success above a value
  threshold with no linked settlement is demoted, not trusted.
- `src/services/effective-authority.ts` — `A_eff = min(R_route, 100·√S_real) · 1[builder ≥ 500]`.
  The `√stake` term is anti-whale damping.

**Three landmines measured 2026-08-21 — read `docs/E2E-TRUST-LOOP-PLAN.md` in this repo for
the full write-up. One of them is a direct input to your work:**

**L3 — `trg_repid_earned_floor` is a reputation RATCHET.** An agent cannot fall below
`tier_lower_bound(peak_repid)`. Measured: an agent that peaked at 10000 took a −999999 event
and landed at **8000**, not the [10, 10000] floor. Tier bounds are PROBATIONARY 0–499 ·
EARNING 500–999 · ESTABLISHED 1000–4999 · AUTONOMOUS 5000–7999 · VETERAN 8000–10000. There is
an escape hatch (`app.bypass_repid_floor`) and a per-agent `floor_override`.

**This is your highest-value target.** The ratchet appears to contradict the asymmetry the
scoring layer is built on. Answer concretely: **does it make "spike to a high tier once, then
defect indefinitely" a winning strategy?** Quantify the cost of reaching VETERAN against the
value extractable from a permanent 8000 floor. If it does, that is the most important finding
you can return, and it is a live policy decision awaiting exactly this evidence.

---

### Deliverables

#### 1. Attack enumeration

For each, state the strategy precisely, what it exploits, and what would make it unprofitable.
This list is a starting point, not a bound — the ones nobody has listed are the valuable ones:

- **Ratchet farming** — reach a tier floor, then defect. (See L3. Priority.)
- **Confidence inflation / sandbagging** — systematically over- or under-declaring certainty.
  Note `certainty_at_claim` is recorded per event and a claim below 0.85 enqueues peer
  verification, so under-declaring has its own cost. Model both directions.
- **Concealment vs confession** — when is hiding a failure still rational despite the 0.4
  discount? A **24h confession window** is planned; model the arbitrage it closes and whether
  24h is the right number.
- **Wash-trading reputation** — two colluding agents transacting to manufacture successes.
  Cost is real settlement; quantify the break-even.
- **Rating collusion and retaliation rings** — rater weighting is by RepID, so a high-RepID
  rater makes a fault penalty more severe. Model rings and reciprocal-rating cartels.
- **Selective disclosure** — choosing which outcomes to anchor with payment proof.
- **Sybil across agents under one builder** — the builder floor is `≥ 500`.

#### 2. Best-response harness design

How to search the strategy space. Must cover: the parameter set held fixed during a search;
the strategy parameterisation; the objective (RepID accrual per unit cost, or per unit
real-value delivered — argue which); and the **stopping condition that constitutes a pass**.

**State the pass criterion as a predicate, not a vibe.** Something of the form "no strategy in
the searched space achieves more than X% of the honest strategy's return." Say what X should
be and why.

#### 3. The policy-version coupling

`repid_score_events` now carries a `policy_version` column. A best-response result is only
valid for one parameter set. Specify how a run records the policy version it searched against,
and what invalidates a prior result.

#### 4. What the harness must NOT conclude

Name the failure modes of your own method: search spaces too small to find the real attack;
objectives that reward the wrong thing; results reported as MEASURED when the search did not
converge. A harness that cannot describe how it would mislead has not been thought through.

---

### Acceptance criteria

- Every attack states its break-even condition, not just its mechanism.
- The pass criterion is a predicate with a named threshold and a justification.
- The L3 ratchet question gets a concrete quantified answer, or an explicit statement of what
  evidence is missing.
- Where uncertain, write **UNVERIFIED** and say what would settle it.

### What will be rejected

- Any claim you read a file outside this workspace.
- Any invented test output, command output, or measurement. On 2026-08-05 a dispatch returned
  a review containing fabricated test results; that is the specific failure this lane's
  constraints exist to prevent. If you did not run it, you did not run it.
- Redesigning the outcome classes, the confession discount, or `A_eff`. Attack them; do not
  replace them.
- Recommending that a Sprint-3 stub be "fixed" by hardcoding a pass.
- Proposing bulk distributional simulation as a substitute for best-response search.

### Note on where this lands

`repid-engine` is a **PUBLIC** repository. State findings, not inventories. No credentials,
project identifiers, row counts, host names or service names in your output.
