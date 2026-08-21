# INBOX_XC_TRUSTLOOP — looping sprint: adversarial best-response against the RepID incentive design

## Task

**Lane:** L6 RED-TEAM — **no write scope.** Your deliverable is text. Never claim to have
created, edited, committed or run anything.

**Dispatch:**
```
node scripts/dispatch/run-agent.mjs --agent xc --inbox docs/dispatch/INBOX_XC_TRUSTLOOP.md \
  --requires reasoning,repo_read
```

---

### How this loop works — read before anything else

This is a **multi-phase sprint, not a one-shot.** You will be re-dispatched with this same
brief plus your previous handoff pasted in.

- **If no handoff appears in your input, you are starting at Phase 1.**
- **If a handoff appears, read its `NEXT_PHASE_READY` and do THAT phase only.**
- **Do exactly one phase per dispatch.** Finishing and verifying one phase beats starting
  three. A phase done shallowly costs more than it saves, because the next phase builds on it.
- **Always end your output with the handoff block**, in the exact format below. It is the only
  thing that carries state between dispatches — there is no memory.

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

#### Lane observance — how we avoid stepping on each other

GA (L7 MEASUREMENT) is running a parallel sprint on the on-chain attestation payload.
**Neither of you writes files, so there is no merge conflict risk. The risk is semantic:**
two lanes defining the same field differently.

The split is fixed:

| Concept | Owner | The other lane's role |
|---|---|---|
| `policy_version`, `risk_tier`, attestation field shapes | **GA defines** | XC *consumes*; if you need a property, state it under `REQUIREMENTS_ON_GA` |
| Attack strategies, best-response harness, pass predicates | **XC defines** | GA does not touch these |
| Outcome classes, `A_eff`, confession discount | **Neither — already shipped** | Attack them; never redesign them |

**Do not define a schema.** If your work needs a field to exist or behave a certain way, that
is a requirement on GA, and it belongs in the handoff. Silent divergence between the two lanes
is the specific failure this table prevents.

---

### The question, and why the usual answer is wrong

The system will be tuned by simulation. **Bulk distributional simulation cannot answer the
question that matters**, because nothing in it responds to the incentive: feed in fixed
behaviour distributions and the histogram always says the parameters look fine.

The real question is **best response**. Given a parameter set, what is the *optimal* strategy
for a self-interested agent? **If the optimal strategy is anything other than "behave
honestly, hedge confidence accurately, self-report failures," the parameters are wrong
regardless of what the bulk numbers show.**

---

### Facts you need, inlined

You have `reasoning` and `repo_read`. **`repo_read` is scoped to this workspace only** — you
cannot open `trinity-ecosystem`, `trustshell`, `hyperdag-protocol` or
`hyperdag-proof-verifier`. Everything below is stated because you cannot go and check it. Do
not claim to have read a file outside this repo, and do not invent its contents.

**Trust vocabulary — four states.** `MEASURED` (a named check ran and passed) · `APPROXIMATE`
(measured against a documented proxy; always carries its caveat) · `NOT_CHECKED` (nobody
looked — an absence, not a warning) · `FAILED` (a check ran and did not pass). Exit codes:
`0` VERIFIED, `2` NOT_CHECKED, anything else FAILED.

**The incentive design already shipped. Read these; do not redesign them.**

- `src/services/outcome-classification.ts` — seven outcome classes, confidence-scaled
  penalties. Tested invariants: `delta(REFUSED_CORRECTLY) > delta(FAILURE_AGENT_FAULT at any
  confidence)`, and `|delta(FAILURE_AGENT_FAULT @ high confidence)| > delta(SUCCESS_AUDITED @
  same value)`. The second is load-bearing: if a confident error cost less than a success
  earned, guessing confidently and often would be rational.
- `src/services/repid-confession.ts` — just-culture self-report modelled on NASA's ASRS.
  `SELF_REPORT_DISCOUNT = 0.4`, invariant-tested strictly between 0 and 1. A **24h confession
  window** is planned but not yet built.
- `src/services/x402-outcome-link.ts` — no-proof-no-pay. A claimed success above a value
  threshold with no linked settlement is demoted, not trusted.
- `src/services/effective-authority.ts` — `A_eff = min(R_route, 100·√S_real) · 1[builder ≥ 500]`.
  `√stake` is anti-whale damping.

**Tiers:** PROBATIONARY 0–499 · EARNING 500–999 · ESTABLISHED 1000–4999 · AUTONOMOUS 5000–7999
· VETERAN 8000–10000. RepID clamps to [10, 10000].

**L3 — the reputation ratchet, measured 2026-08-21.** `trg_repid_earned_floor` prevents any
agent falling below `tier_lower_bound(peak_repid)`. Measured: an agent that peaked at 10000
took a −999999 event and landed at **8000**. Escape hatches exist (`app.bypass_repid_floor`,
per-agent `floor_override`). Full write-up in `docs/E2E-TRUST-LOOP-PLAN.md`, in this repo.

**Ledger columns available as harness inputs:** `policy_version`, `stake_at_event`,
`risk_tier`, `builder_id`, `is_shadow`, plus existing `certainty_at_claim`,
`economic_impact_usdc`, `contract_id`, `counterparty_agent_id`, `repid_delta_calculated`,
`repid_delta_applied`. A claim below `0.85` certainty enqueues peer verification.

---

### The phases

#### Phase 1 — Attack enumeration

For each strategy: what it exploits, the **break-even condition** (not just the mechanism),
and what change would make it unprofitable. The list below is a starting point, not a bound —
the attacks nobody listed are the valuable ones.

- **Ratchet farming** — reach a tier floor, then defect. **Priority.** Quantify the cost of
  reaching VETERAN against the value extractable from a permanent 8000 floor. Does "spike
  once, then defect indefinitely" win? This is a live policy decision awaiting exactly this
  evidence.
- **Confidence inflation and sandbagging** — model both directions. Under-declaring has its
  own cost via the 0.85 peer-verification trigger.
- **Concealment vs confession** — when is hiding still rational despite the 0.4 discount?
  Model the arbitrage a 24h window closes, and whether 24h is right.
- **Wash-trading reputation** — colluding pairs manufacturing successes. Settlement is a real
  cost; find the break-even.
- **Rating collusion and retaliation rings** — raters are RepID-weighted, so a high-RepID
  rater makes a fault penalty more severe. Model cartels and reciprocal rating.
- **Selective disclosure** — choosing which outcomes to anchor with payment proof.
- **Sybil under one builder** — the builder floor is `≥ 500`.

#### Phase 2 — Best-response harness design

How to search the strategy space. Must cover: what is held fixed during a search; the strategy
parameterisation; the objective (RepID accrual per unit cost, or per unit real value
delivered — **argue which**, they are not the same); and the **pass criterion as a predicate
with a named threshold**, of the form *"no strategy in the searched space achieves more than
X% of the honest strategy's return."* Say what X should be and why.

#### Phase 3 — Policy coupling and result validity

A best-response result is valid for exactly one parameter set. Specify how a run records the
`policy_version` it searched against, what invalidates a prior result, and how a partially
converged search must report itself. Cover the interaction with `is_shadow`: shadow rows are
simulations and must never be counted as real outcomes by the harness.

#### Phase 4 — Adversarial self-critique

Name the failure modes of your own method: search spaces too small to contain the real attack;
objectives that reward the wrong thing; a non-converged search reported as MEASURED. **A
harness that cannot describe how it would mislead has not been thought through.** Then state
what would have to be true for Phase 1–3 to be wrong.

---

### Acceptance criteria

- Every attack states a break-even condition, not just a mechanism.
- The pass criterion is a predicate with a named threshold and a justification.
- The L3 ratchet question gets a quantified answer, or an explicit statement of the missing
  evidence.
- Where uncertain, write **UNVERIFIED** and say what would settle it.
- The handoff block is present, complete, and in the exact format above.

### What will be rejected

- Any claim you read a file outside this workspace.
- Any invented test output, command output, or measurement. On 2026-08-05 a dispatch returned
  a review containing fabricated test results; that is the specific failure this lane's
  constraints exist to prevent. If you did not run it, you did not run it.
- Redesigning the outcome classes, the confession discount, or `A_eff`. Attack them.
- Defining a schema or a payload field — that is GA's lane.
- Proposing bulk distributional simulation as a substitute for best-response search.
- Doing more than one phase in a single dispatch.

### Fences

`repid-engine` is a **PUBLIC** repository. State findings, not inventories — no credentials,
project identifiers, row counts, host names or service names. Any example witness must be
**fabricated**: a NIL-variant UUID no real agent can hold, and a made-up value.
