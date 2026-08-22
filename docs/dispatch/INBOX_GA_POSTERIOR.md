# INBOX_GA_POSTERIOR — looping sprint: the sufficient-statistic contract, reconstructible from the ledger alone

## Task

**Lane:** L7 MEASUREMENT — **no write scope.** Your deliverable is text. Never claim to have
created, edited, committed or run anything.

**Dispatch:**
```
node scripts/dispatch/run-agent.mjs --agent ga --inbox docs/dispatch/INBOX_GA_POSTERIOR.md \
  --requires reasoning,repo_read
```

---

### How this loop works — read before anything else

This is a **multi-phase sprint, not a one-shot.** You will be re-dispatched with this same
brief plus your previous handoff pasted in.

- **If no handoff appears in your input, you are starting at Phase 1.**
- **If a handoff appears, read its `NEXT_PHASE_READY` and do THAT phase only.**
- **Do exactly one phase per dispatch.** A phase done shallowly costs more than it saves.
- **Always end your output with the handoff block**, exactly as below. It is the only thing
  that carries state between dispatches — there is no memory.

#### The handoff format — reproduce it exactly

```
=== HANDOFF GA S<n> ===
PHASE_COMPLETED: <n>
STATUS: COMPLETE | PARTIAL | BLOCKED
POLICY_VERSION_ASSUMED: <string, or UNKNOWN>
DELIVERED:
  - <artifact name>: <one line on what it is>
FINDINGS:
  - [MEASURED|UNVERIFIED] <finding, one line>
REQUIREMENTS_ON_XC:
  - <property you need XC to test or price, and why>
OPEN_QUESTIONS_FOR_SEAN:
  - <question only a human can answer>
NEXT_PHASE_READY: <n+1>   (or)   BLOCKED_ON: <what is missing>
=== END HANDOFF ===
```

#### Lane observance

XC (L6 RED-TEAM) is running a parallel sprint attacking the same proposal. **Neither of you
writes files, so there is no merge conflict risk. The risk is semantic:** two lanes defining
the same quantity differently.

| Concept | Owner | The other lane's role |
|---|---|---|
| Field shapes, sufficient statistics, `policy_version` scope, versioning posture | **You define** | XC *consumes* and states requirements. |
| Attack strategies, best-response search, profitability arithmetic | **XC defines** | You do not touch these. |
| Outcome classes, `A_eff`, the confession discount, risk bands | **Neither — already shipped** | Reference them; never redesign. |

A `REQUIREMENTS_ON_GA` entry arriving from XC is **an input to weigh, not an instruction to
obey uncritically.** If the requirement is wrong, say so in `REQUIREMENTS_ON_XC`.

---

### Why this task is urgent while almost everything else can wait

A proposal is on the table to replace the additive-delta RepID engine with a **posterior
formulation** — Beta-Binomial per domain, or Dirichlet-Multinomial over severity buckets.

**The single fact that makes this urgent:** a posterior **cannot be reconstructed from a
ledger of point estimates.** Every score event written between now and the day the columns
exist is an event whose posterior state is permanently unrecoverable. Today's ledger records
what the score *became*; it does not record what the policy *consumed*. Once the columns
exist, the shadow comparison that decides the whole question can begin — and it cannot begin
one day earlier.

This is the same class of permanence as an on-chain attestation, and it is being decided for
the same reason: it is cheap now and impossible later.

---

### Facts you need, inlined

You have `reasoning` and `repo_read`. **`repo_read` is scoped to this workspace only** — you
cannot open `trinity-ecosystem`, `trustshell`, `hyperdag-protocol` or the verifier crate. Do
not claim to have read a file outside this repo, and do not invent its contents.

**Trust vocabulary — four states.** `MEASURED` · `APPROXIMATE` · `NOT_CHECKED` · `FAILED`.
Two outcomes collapse "we did not look" into "it passed." **Every status field you design must
express all four. A boolean cannot, so do not design one.**

**The proposal, in the form you must serve:**

- Per `(agent, domain)`, keep Beta parameters `α` (favourable) and `β` (unfavourable), or
  Dirichlet counts over severity buckets.
- A settled interaction updates them; both decay with time.
- The score derives from the posterior mean. A **credible interval** gates high-stakes actions,
  falling back to a global posterior when a domain's interval is too wide.
- A brand-new `(agent, domain)` starts at a prior `α₀, β₀`.

**Two design constraints already settled — build to them, do not relitigate them:**

1. **Two statistics, not one.** The mean is driven by **value-weighted** `α/β`; the confidence
   interval is driven by **raw counts**. Collapsing them into one Beta produces a distribution
   that is either dilution-vulnerable or confidence-inflated.
2. **Bad evidence must decay more slowly than good evidence**, or dormancy becomes a
   reputation launder. The asymmetry is a policy parameter, never implicit in a half-life.

**MEASURED facts about the system as it stands today:**

- Domain scoping is **already live and ungoverned.** Essentially every score event carries a
  domain label. **42 domains, 16 carrying a single agent**, roughly **two thirds of events in
  one domain.**
- Existing ledger columns you may build on: `is_shadow`, `policy_version`, `stake_at_event`,
  `risk_tier`, `builder_id`, `certainty_at_claim`, `economic_impact_usdc`, `contract_id`,
  `counterparty_agent_id`, `repid_delta_calculated`, `repid_delta_applied`, `idempotency_key`,
  `task_domain`.
- A migration on 2026-08-21 made the ledger record **the delta that actually landed**, by
  reading back the stored score. Before that the ledger asserted penalties the agent never
  paid — a floor absorbed them.
- `src/services/policy-version.ts` derives `pol1-<digest>` by probing `deltaFor` and
  `assessRisk`. **Both are pure application code. It touches nothing in the database.**
- `scripts/trust-loop/policy-scope-check.ts` pins the digests of three database functions the
  pure digest cannot see, precisely because that gap was found once already.
- Statement A1's public values are **18 BabyBear field elements** — `[0..16]` agent id,
  `[16]` threshold, `[17]` score. **Arity 18 is permanently reserved.** The verifier
  **ignores unknown fields**, so a field added to A1 would appear in the proof, appear in the
  ledger, and bind nothing.
- Postgres rounds `numeric → integer` **half away from zero.**
- `src/services/shadow-scoring.ts` exists and keys shadow rows on
  `(mode, policy_version, digest(interaction))`.

---

### The phases

#### Phase 1 — `posterior-state.v0`: the sufficient-statistic field set

The exact fields a score event must carry so that a posterior is reconstructible **from the
ledger alone**, with no access to application state.

At minimum, decide and justify: the **pre-** and **post-** sufficient statistics; the
**evidence weight** `wᵢ` actually applied, held separately from severity; the **raw count**
alongside the weighted one; the **prior** in force for that `(agent, domain)`; and the
**severity inputs**, not only the severity output.

**The justification is the hard part.** For each field, state what question becomes
unanswerable if it is absent, and whether it can be resolved off-ledger from something already
stored. A field that can be recomputed from stored inputs does not belong in the row.

#### Phase 2 — The exclusions, argued as carefully as the inclusions

What you deliberately leave out, and why. Include at least: the posterior *mean* itself, the
credible interval bounds, and the tier — all derivable. State for each what breaks if a future
reader assumes it was stored, and what a reader must do instead.

A row that stores its own conclusions is a row that can disagree with itself. That failure has
already happened here once.

#### Phase 3 — `policy_version` must cover the half it currently cannot

A posterior engine's behaviour is set by the **prior, the decay rates, and the weighting
function.** None of those are `deltaFor` or `assessRisk`. Ship posterior scoring without
extending the transcript and the digest stays byte-identical across a total change of regime.

Define what the transcript must additionally probe, and how — remembering the digest is
**deliberately pure and synchronous**, so it cannot make a database round trip. State whether
each new input belongs in the pure transcript or in the pinned DB-side check, and give the
rule that decides.

State the release constraint that follows.

#### Phase 4 — Decay, recorded so it is reconstructible

Decay is continuous; events are discrete. Define how a decayed posterior is recorded so a
reader can reproduce the exact state the policy consumed at an arbitrary later timestamp —
without replaying every intervening event, and without storing a snapshot per tick.

Cover: what timestamp decay is measured from, what happens across a gap with no events, and
how the **asymmetry** between favourable and unfavourable decay is represented so it is
auditable rather than buried in a constant.

#### Phase 5 — Domain identity, hierarchy-ready without committing to hierarchy

`task_domain` is a human label on live rows. Define the identity model: a stable `domain_id`
distinct from the label, what happens when a label is renamed or two domains merge, and how a
row written today stays interpretable after either.

Then define what a hierarchy would need **later** — the minimum recorded now that keeps it
possible — while committing to none of it. Given 16 single-agent domains, say plainly what a
hierarchy would and would not fix.

#### Phase 6 — Statement A2: domain-scoped selective disclosure

A domain-scoped proof cannot extend A1: arity 18 is reserved and the verifier ignores unknown
fields, so an added field binds nothing.

Specify A2's public-value layout: what it proves, its arity, and the **domain-separation tag**
that makes an A2 proof unusable as an A1 proof and vice versa. State what is disclosed, what
is hidden, and what a verifier learns that it should not — selective disclosure that leaks the
domain identity in the clear may still be the right trade, but it must be stated, not
discovered.

#### Phase 7 — Migration and versioning posture

Existing events have no posterior state. Decide, with reasoning: backfill a synthetic
posterior, cold-start every `(agent, domain)` at the prior, or a hybrid — and what each does to
an agent's standing on day one.

Then define how a row written under the additive engine is distinguished from one written
under the posterior engine, so a future reader never mixes regimes silently. `is_shadow` and
`policy_version` already exist; say whether they suffice.

#### Phase 8 — Acceptance

The contract in one place: every field, its type, its nullability, whether it is written by
the application or derived by the database, and the one sentence that justifies it.

Then the **failure list**: for each field, the specific wrong conclusion a reader reaches if
it is missing or misread. That list is what a reviewer checks the migration against.

---

### Acceptance criteria

- Every field carries a justification naming what becomes unanswerable without it.
- Every status field expresses all four trust states. No booleans for status.
- Every claim carries one of the four trust states; where you cannot check, write
  `UNVERIFIED` and name the input you lack.
- No file is claimed as written, run, committed or edited. You have no write scope.
- Anything you need XC to price appears under `REQUIREMENTS_ON_XC` with the reason.
- Anything only a human can decide appears under `OPEN_QUESTIONS_FOR_SEAN` — do not decide it
  yourself and do not stall the phase on it.

---

### What will be rejected

- A field list without per-field justification. The list is the easy half.
- Relitigating the two settled constraints instead of building to them.
- Redesigning the outcome classes, `A_eff`, the confession discount, or the risk bands.
- Storing a derived quantity because it is convenient, without arguing why the derivation is
  not enough.
- Extending A1 rather than defining A2.
- Asserting a fact about a file outside this repo.
- Advancing more than one phase in a dispatch, or repeating a completed phase. **A handoff
  whose `NEXT_PHASE_READY` does not advance halts the sprint** — that guard exists so a
  confused agent is not re-dispatched with identical input all night.

---

### Fences

- **This repository is public.** State findings, not inventories. No credentials, project
  identifiers, production row counts, host names or service names in anything you emit.
  Proportions and shapes are fine.
- The scoring formula internals and ANFIS parameters are **never for public docs.**
- Do not propose removing or hardcoding a passing stub. A stub that always passes is a
  contract surface; making it lie is worse than leaving it honest.
- **Never assume a column name.** If a column you need may not exist, say so and mark it
  `UNVERIFIED` rather than designing against a guess.
