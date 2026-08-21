# INBOX_GA_TRUSTLOOP — looping sprint: the on-chain attestation payload, immutable once minted

## Task

**Lane:** L7 MEASUREMENT — **no write scope.** Your deliverable is text. Never claim to have
created, edited, committed or run anything.

**Dispatch:**
```
node scripts/dispatch/run-agent.mjs --agent ga --inbox docs/dispatch/INBOX_GA_TRUSTLOOP.md \
  --requires reasoning,repo_read
```

---

### How this loop works — read before anything else

This is a **multi-phase sprint, not a one-shot.** You will be re-dispatched with this same
brief plus your previous handoff pasted in.

- **If no handoff appears in your input, you are starting at Phase 1.**
- **If a handoff appears, read its `NEXT_PHASE_READY` and do THAT phase only.**
- **Do exactly one phase per dispatch.** A phase done shallowly costs more than it saves,
  because everything after it inherits the mistake — and here, the mistake becomes immutable.
- **Always end your output with the handoff block**, in the exact format below. It is the only
  thing that carries state between dispatches — there is no memory.

#### The handoff format — reproduce it exactly

```
=== HANDOFF GA S<n> ===
PHASE_COMPLETED: <n>
STATUS: COMPLETE | PARTIAL | BLOCKED
SCHEMA_VERSION_PROPOSED: <string, or NONE_YET>
DELIVERED:
  - <artifact name>: <one line on what it is>
FIELDS_LOCKED_THIS_PHASE:
  - <field>: <type> — <on-chain justification, one line>
FIELDS_DELIBERATELY_EXCLUDED:
  - <field>: <why it must NOT be on chain>
REQUIREMENTS_ON_XC:
  - <property you need XC's harness to respect, and why>
OPEN_QUESTIONS_FOR_SEAN:
  - <question only a human can answer>
NEXT_PHASE_READY: <n+1>   (or)   BLOCKED_ON: <what is missing>
=== END HANDOFF ===
```

#### Lane observance — how we avoid stepping on each other

XC (L6 RED-TEAM) is running a parallel sprint on adversarial best-response.
**Neither of you writes files, so there is no merge conflict risk. The risk is semantic:**
two lanes defining the same field differently.

The split is fixed:

| Concept | Owner | The other lane's role |
|---|---|---|
| `policy_version`, `risk_tier`, attestation field shapes | **GA defines — you** | XC consumes; expect requirements from it |
| Attack strategies, best-response harness, pass predicates | **XC defines** | GA does not touch these |
| Outcome classes, `A_eff`, confession discount | **Neither — already shipped** | Reference them; never redesign |

**You own the definitions.** If XC's handoff arrives with a `REQUIREMENTS_ON_GA` entry, treat
it as an input to your next phase, not as an instruction to be obeyed uncritically — if the
requirement is wrong, say so in `REQUIREMENTS_ON_XC`.

---

### Why this task is urgent while almost everything else can wait

Most of this system is tunable. **This is not.** Once the first attestation is minted, its
field set is permanent — every future reader parses that shape, and a field you omitted cannot
be added retroactively to attestations already written.

The system has **zero users today.** That is the entire reason this is being done now rather
than after the loop works.

---

### Facts you need, inlined

You have `reasoning` and `repo_read`. **`repo_read` is scoped to this workspace only** — you
cannot open `trinity-ecosystem`, `trustshell`, `hyperdag-protocol` or
`hyperdag-proof-verifier`. Everything below is stated because you cannot go and check it. Do
not claim to have read a file outside this repo, and do not invent its contents.

**Trust vocabulary — four states.** `MEASURED` · `APPROXIMATE` · `NOT_CHECKED` · `FAILED`.
Two outcomes collapse "we did not look" into "it passed". **Every status field you design must
express all four. A boolean cannot, so do not design one.**

**What is attested.** A completed service interaction: a human staked USDC for an agent, that
agent bought a service from another agent, the outcome was classified. The attestation makes
that outcome **independently verifiable by a third party**. It does not make it private —
those are different properties. On-chain attestation gives verifiability with zero ZK; ZK buys
*selective disclosure*, later.

**Outcome classes** (`src/services/outcome-classification.ts` — read it): `SUCCESS_AUDITED` ·
`SUCCESS_UNAUDITED` · `FAILURE_AGENT_FAULT` · `FAILURE_COUNTERPARTY` · `FAILURE_INFRA` ·
`REFUSED_CORRECTLY` · `UNCERTAIN`. `REFUSED_CORRECTLY` is a **positive** signal — restraint is
work. `UNCERTAIN` earns and costs nothing.

**Three-band risk model.** Value-at-risk = `max(service_value, stake_exposed)`, plus a
**novelty uplift** (a first interaction between two agents is riskier than the fiftieth at
equal value). `< T1` off-chain only · `T1–T2` off-chain scoring plus a **batched Merkle root**
anchored periodically (`src/zkp/merkle-root.ts` exists) · `> T2` individual on-chain
attestation. Reuse the existing `repid_config` anchors rather than inventing bands:
`claim_auto_threshold_usdc = 100`, `claim_peer_court_min_usdc = 1000`.

**Ledger columns added 2026-08-21** that your payload may reference: `is_shadow`,
`policy_version`, `stake_at_event`, `risk_tier`, `builder_id`. Existing and relevant:
`certainty_at_claim`, `economic_impact_usdc`, `contract_id`, `counterparty_agent_id`,
`repid_delta_calculated`, `repid_delta_applied`, `idempotency_key`.

**Statement A1**, in the published verifier crate you cannot open: public values are **18
BabyBear field elements** — `[0..16]` = `agent_id` (16 bytes, one per element) · `[16]` =
`threshold` · `[17]` = `repid_score`. Proves `repid > threshold` via a 16-bit range check. It
is **fixed**, and a decision has been taken to adopt a **versioned statement family** rather
than treat A1 as final, because fields like `risk_tier` and `policy_version` may need to live
inside a proof later.

Full context and the three landmines measured 2026-08-21: `docs/E2E-TRUST-LOOP-PLAN.md`, in
this repo.

---

### The phases

#### Phase 1 — `outcome-attestation.v0`: the field set

Each field with a justification for why it must be **on chain** rather than referenced off
chain. **That justification is the hard part** — on-chain bytes are permanent and costly, and
a field a reader can resolve off-chain from a hash does not belong in the payload.

Must cover at minimum: which outcome (from the fixed class list); the **evidence hash** —
what exactly is hashed, what a verifier does with it, whether the pre-image is expected to be
retrievable and what verification means if it is not; **all three party identifiers** —
provider agent, consumer agent, human builder, *even though only the provider's score moves in
v1* — stating the identifier form and whether it is pseudonymous, because an on-chain
identifier is permanent and this is a privacy-first system; the **risk tier** and the
value-at-risk that produced it; **`policy_version`**, without which an attestation cannot be
re-interpreted after weights are tuned; an **optional `model_commitment`** slot (a
content-addressed weights hash) so a ZKML proof could attach later without a payload
migration — **design the slot, not the proof**; a **schema version** field; and a **`network`
discriminator**, since testnet and mainnet attestations must never be confusable (the design
is two distinct scores, `training_repid` and `mainnet_repid`, not a flag on one).

#### Phase 2 — The exclusions, argued as carefully as the inclusions

What must **not** be on chain, and why. Candidates: the RepID delta itself, the score, raw
prompt or answer text, the stake amount, the counterparty's identity in some tiers.

**Governing constraint:** the scoring formula stays **private and off-chain** so it can be
tuned. Nothing on chain may permit reconstructing the weights. The invariants are published;
the weights are not. Show your reasoning on which fields, in combination and over many
attestations, would leak the formula — single-field analysis is not sufficient here.

#### Phase 3 — The batched band

For `T1–T2`: what a Merkle leaf contains, and what the anchored root commits to. State what an
individual party can prove about their own interaction **from the root alone**, and what they
cannot. Cover the privacy consequence of leaf ordering and of batch membership itself.

#### Phase 4 — Migration and versioning posture

What happens when `v1` is needed. Which fields are safe to add later, which are not, and how a
reader distinguishes versions. Then state what would have to be true for Phases 1–3 to be
wrong, and what evidence would show it.

---

### Acceptance criteria

- Every included field has an on-chain-vs-off-chain justification.
- Every status field expresses all four vocabulary states.
- No field name, comment or example implies the end-to-end loop is proven — it is not; the
  live prove→verify path is **NOT_CHECKED**.
- Nothing on chain permits reconstruction of the scoring weights.
- Where uncertain, write **UNVERIFIED** and say what would settle it.
- The handoff block is present, complete, and in the exact format above.

### What will be rejected

- Any claim you read a file outside this workspace, including the verifier crate.
- Any invented test output, command output, or measurement. On 2026-08-05 a dispatch returned
  a review containing fabricated test results; that is the specific failure this lane's
  constraints exist to prevent. If you did not run it, you did not run it.
- Redesigning statement A1's public values, or the outcome class list.
- A two-state (boolean) status anywhere.
- Designing the ZKML proof rather than the optional slot that would carry it.
- Defining attack strategies or harness predicates — that is XC's lane.
- Doing more than one phase in a single dispatch.

### Fences

**The #376 fence.** PR #376 committed a proof lifted from the production proofs table — real
agent UUID, real score — into this **public** repo. It cannot be withdrawn.
`scripts/hooks/prod-fixture-guard.js` blocks that shape permanently. Every example payload you
write must use a **fabricated** witness: a NIL-variant UUID no real agent can hold, and a
made-up value.

`repid-engine` is a **PUBLIC** repository. State findings, not inventories — no credentials,
project identifiers, row counts, host names or service names.
