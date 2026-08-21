# INBOX_GA_TRUSTLOOP — the on-chain attestation payload, which is immutable once minted

## Task

**Lane:** L7 MEASUREMENT — **no write scope.** Your deliverable is a specification returned as
text. Do not claim to have created, edited or committed a file.

**Dispatch:**
```
node scripts/dispatch/run-agent.mjs --agent ga --inbox docs/dispatch/INBOX_GA_TRUSTLOOP.md \
  --requires reasoning,repo_read
```

---

### Why this one is urgent while everything else can wait

Most of this system is tunable. **This is not.** Once the first attestation is minted on
chain, its field set is permanent — every future reader parses that shape, and a field you
omitted cannot be added retroactively to attestations already written.

The system has **zero users today**. That is the entire reason this task is being done now
rather than after the loop works.

Your deliverable is the payload schema and its justification. Not code, not a contract.

---

### Facts you need, inlined

You have `reasoning` and `repo_read`. **`repo_read` is scoped to this workspace only** — you
cannot open `trinity-ecosystem`, `trustshell`, `hyperdag-protocol` or
`hyperdag-proof-verifier`. Everything below is stated because you cannot go and check it. Do
not claim to have read a file outside this repo, and do not invent its contents.

**The trust vocabulary — four states.** `MEASURED` · `APPROXIMATE` · `NOT_CHECKED` · `FAILED`.
Two outcomes collapse "we did not look" into "it passed". **Every status field you design must
express all four. A boolean cannot, so do not design one.**

**What is being attested.** A completed service interaction: a human staked USDC for an agent,
that agent bought a service from another agent, and the outcome was classified. The
attestation makes that outcome **independently verifiable by a third party** — it does not
make it private. Those are different properties and the distinction matters: on-chain
attestation gives verifiability with zero ZK; ZK buys *selective disclosure* later.

**The outcome classes** (`src/services/outcome-classification.ts` — read it):
`SUCCESS_AUDITED` · `SUCCESS_UNAUDITED` · `FAILURE_AGENT_FAULT` · `FAILURE_COUNTERPARTY` ·
`FAILURE_INFRA` · `REFUSED_CORRECTLY` · `UNCERTAIN`. Note `REFUSED_CORRECTLY` is a **positive**
signal — restraint is work — and `UNCERTAIN` earns and costs nothing.

**The three-band risk model.** Value-at-risk = `max(service_value, stake_exposed)`, plus a
**novelty uplift** (a first interaction between two agents is riskier than the fiftieth at
equal value). Below T1: off-chain only. T1–T2: off-chain scoring plus a **batched Merkle root**
anchored periodically (`src/zkp/merkle-root.ts` exists). Above T2: individual on-chain
attestation. Existing `repid_config` anchors to reuse rather than inventing new bands:
`claim_auto_threshold_usdc = 100`, `claim_peer_court_min_usdc = 1000`.

**Ledger columns added 2026-08-21** to `repid_score_events`, which your payload must be able to
reference: `is_shadow`, `policy_version`, `stake_at_event`, `risk_tier`, `builder_id`. Existing
and relevant: `certainty_at_claim`, `economic_impact_usdc`, `contract_id`,
`counterparty_agent_id`, `repid_delta_calculated`, `repid_delta_applied`, `idempotency_key`.

**Statement A1** (in the published verifier crate, which you cannot open): public values are
**18 BabyBear field elements** — `[0..16]` = `agent_id` (16 bytes, one per element) · `[16]` =
`threshold` · `[17]` = `repid_score`. It proves `repid > threshold` via a 16-bit range check.
**It is fixed.** A decision has been taken to adopt a **versioned statement family** rather
than treat A1 as final, precisely because fields like `risk_tier` and `policy_version` may need
to live inside a proof later.

**Read `docs/E2E-TRUST-LOOP-PLAN.md` in this repo** for the full context and the three
landmines measured on 2026-08-21.

---

### Deliverables

#### 1. `outcome-attestation.v0` — the payload

The field set, each with a justification for why it must be **on chain** rather than referenced
off chain. That justification is the hard part: on-chain bytes are permanent and costly, and a
field that a reader can resolve off-chain from a hash does not belong in the payload.

Must cover, at minimum:

- **Which outcome**, from the fixed class list above.
- **Evidence hash** — what exactly is hashed, and what a verifier does with it. State whether
  the pre-image is expected to be retrievable, and what verification means if it is not.
- **Party identifiers** — provider agent, consumer agent, and the human builder. **All three,
  even though only the provider's score moves in v1.** Say what identifier form is used and
  whether it is pseudonymous; this is a privacy-first system and an on-chain identifier is
  permanent.
- **Risk tier** and the value-at-risk that produced it.
- **`policy_version`** — which scoring policy governed. Without it, an attestation cannot be
  re-interpreted after the weights are tuned.
- **`model_commitment`, OPTIONAL** — a content-addressed weights hash, so a ZKML proof *could*
  attach later without a payload migration. This is the single pre-user ZKML action; do not
  design the proof itself, only the slot.
- **A statement/schema version field.**
- **A `network` discriminator** — testnet and mainnet attestations must never be confusable.
  The design is two distinct scores (`training_repid`, `mainnet_repid`), not a flag on one.

#### 2. What must NOT be in the payload

Argue the exclusions as carefully as the inclusions. Candidates: the RepID delta itself, the
score, the raw prompt or answer, the stake amount, the counterparty's identity in some tiers.

**The governing constraint:** the scoring formula stays **private and off-chain** so it can be
tuned, and putting anything on chain from which the formula could be reconstructed defeats
that. The invariants are published; the weights are not.

#### 3. Batched-band shape

For the T1–T2 band, what a Merkle leaf contains and what the anchored root commits to. State
what an individual party can prove about their own interaction from the root alone, and what
they cannot.

#### 4. Open questions, stated not resolved

An unresolved question stated plainly is a better deliverable than a confident wrong answer.

---

### Acceptance criteria

- Every included field has an on-chain-vs-off-chain justification.
- Every status field expresses all four vocabulary states.
- No field name, comment or example implies the end-to-end loop is proven — it is not; the
  live prove→verify path is **NOT_CHECKED**.
- Nothing on chain permits reconstruction of the scoring weights.
- Where uncertain, write **UNVERIFIED** and say what would settle it.

### What will be rejected

- Any claim you read a file outside this workspace, including the verifier crate.
- Any invented test output, command output, or measurement. On 2026-08-05 a dispatch returned
  a review containing fabricated test results; that is the specific failure this lane's
  constraints exist to prevent. If you did not run it, you did not run it.
- Redesigning statement A1's public values, or the outcome class list.
- A two-state (boolean) status anywhere.
- Designing the ZKML proof rather than the optional field that would carry it.

### The #376 fence

PR #376 committed a proof lifted from the production proofs table — real agent UUID, real
score — into this **public** repo. It cannot be withdrawn.
`scripts/hooks/prod-fixture-guard.js` blocks that shape permanently. Every example payload you
write must use a **fabricated** witness: a NIL-variant UUID no real agent can hold, and a
made-up value.

### Note on where this lands

`repid-engine` is a **PUBLIC** repository. State findings, not inventories. No credentials,
project identifiers, row counts, host names or service names in your output.
