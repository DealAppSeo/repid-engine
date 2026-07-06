# repid-engine — Architecture

`repid-engine` is the behavioral-reputation and trust backend for the HyperDAG
Protocol Trust\* ecosystem. It turns *agent behavior* into a portable,
cryptographically-anchored reputation credential (**RepID**), and gates that
credential on **verified** behavior rather than self-reported claims.

This document is the 5-minute "how it works." It is grounded in the code in
this repo; the deeper design canon (formulas, ANFIS parameters, ZK invariants)
lives outside the public tree and is referenced, not reproduced, here.

> **Claim discipline.** Throughout: **[V]** = live-verified (query / on-chain /
> test), **[R]** = reported / in-development. Reduction-to-practice evidence a
> reviewer can check independently lives in a separate evidence catalog.

---

## The trust loop

The system is one closed loop. An agent does work; the work is independently
verified; the verdict moves a reputation score; the score is paid against,
attested on-chain, and proven in zero-knowledge. Each stage feeds the next.

```
                        ┌─────────────────────────────────────────────┐
                        │                                             │
   agent output ─▶  (1) HAL cross-LLM verify  ─▶  (2) RepID score  ───┤
                        │   flagged / clean / veto        Δ, clamped    │
                        │   (advisory, logged)      audit → repid_score_events
                        │                                             │
                        ▼                                             ▼
                 (5) Plonky3 ZK prove  ◀── (4) ERC-8004 + EAS attest ◀─ (3) x402 pay
                     STARK range-check        on-chain reputation +      A2A micro-
                     Poseidon2 leaf (R)        EAS attestation UID        settlement
                                                                         (USDC, Base)
```

1. **HAL — Hallucination Assessment Layer** (`src/hal/`). Before a deliverable
   earns reputation, HAL asks *multiple independent LLMs* whether the output is
   trustworthy. It is a **cross-LLM** check (`src/hal/cross-llm-client.ts`): one
   provider per training-data family (e.g. Groq / DeepSeek / Anthropic) so the
   verifiers are *decorrelated* — a shared blind spot in one family does not
   silently pass. Disagreement is measured with a **Pythagorean-Comma BFT gap**
   (per-provider belief spread); only a `critical` gap triggers a hard veto, and
   a veto requires ≥3 providers responding (a 2-way gap is meaningless).
   Consensus fusion is **SBFA** (`src/hal/sbfa-consensus.ts`): a
   weighted-supermajority with explicit *abstain / escalate* using
   Dempster-Shafer (Yager rule) so ignorance is represented, not renormalized
   away. **Measured F1 ≈ 0.80** on a 1,000-case harness [V] (see catalog;
   qualifiers matter — the live provider pair is currently the weaker one
   pending deploy).

2. **RepID scoring** (`src/engine/repid-update.ts`). Every score-changing event
   flows through one fixed pipeline: fetch agent → constitutional audit →
   time-decay → ecosystem-need weight → delta → redemption modifier → clamp to
   `[10, 10000]` → derive tier. The new score is written to `repid_agents` and an
   **append-only audit row** to `repid_score_events` (the audit row is written
   *before* the mutation is finalized, so a score can never move without a
   trace). Tier (`PROBATIONARY / EARNING / ESTABLISHED / AUTONOMOUS / VETERAN`)
   is **database-derived** by a Postgres trigger from `current_repid`, so it can
   never drift from the score.

3. **x402 settlement** (`src/routes/x402-inbound.ts`). Agent-to-agent value
   moves over the **x402** micro-payment rail as real **USDC on Base Sepolia**.
   Settlements are recorded in `x402_settlements` with an `is_simulated` flag so
   simulated flow is never counted as real. Real settlements carry an on-chain
   `tx_hash`.

4. **ERC-8004 + EAS attestation.** Reputation deltas are written on-chain to an
   **ERC-8004** reputation registry (`erc8004_reputation_writes`, Base Sepolia,
   chain 84532), and proofs are anchored with an **EAS attestation UID**
   (`repid_zkp_proofs.eas_attestation_uid`) so the claim "this agent has this
   reputation" is independently checkable on `base-sepolia.easscan.org`.

5. **Plonky3 ZK proof** (`src/zkp/`). The reputation statement is proven in
   zero-knowledge: a **Plonky3** recursive-STARK range-check over the **BabyBear**
   field (`scheme = plonky3_range_check`, `is_real = true`, with `proof_bytes`
   present). Real proofs are distinguished from stubs by the `is_real` /
   `proof_bytes` columns — **nothing counts as a proof unless the bytes exist.**

---

## The crypto substrate (build once, reuse everywhere)

Two proving tiers, reused by every vertical (see
`ZKP_ARCHITECTURE_INVARIANTS.md` in the canon — not reproduced here):

- **Leaf** — small, cheap, per-action (identity / membership / threshold).
  Current POSTCARD path uses a sha256 leaf; migration to a **Poseidon2** leaf is
  ~70% built behind a flag (`src/zkp/`, golden KATs frozen) so leaves become
  aggregation-ready **[R]**.
- **Aggregation** — **Plonky3 + Rust** recursive STARK; recurse many leaves into
  one anchored root. The Plonky3 dependency is **pinned in lockstep**
  (`rev=27d59f73…`) across all circuits so one circuit can never silently drift
  the prover and break another.

Six invariants govern all ZK work (one hash/field = Poseidon2 over a
Plonky3-native field; one identity with *scoped* nullifiers; a
domain-parameterized verifier + EAS anchor; hard data-plane isolation; one
Plonky3 pin; a namespaced circuit registry). They are constraints on today's
build so future verticals reuse the substrate without conflict.

---

## Decorrelated verification methodology

Trust here is not one model's opinion — it is **independent verifiers that fail
differently**. The same principle applies to how the system itself is built and
checked:

- **CC — build.** Implements the engine, the pipeline, the ZK wiring.
- **XC — red-team.** Adversarially probes the build for holes CC would not see.
- **GA — fuzz / measure.** Independently fuzzes and *measures* (e.g. the HAL
  validation harness), so a claim of "F1 = X" comes from a different hand than
  the one that wrote the classifier.

This is the software-engineering expression of the cross-LLM design: **agreement
gates judgment, but never gates facts** — a live-system number is verified
against Supabase / on-chain regardless of who agrees.

---

## Design principles

These are load-bearing conventions, enforced in code:

- **Config-in-DB.** Runtime knobs (supply-rate weights, ecosystem-need
  multipliers, HAL strictness) resolve from database / env, not hard-coded
  constants — reversible in one change, logged loudly at boot.
- **Degrade loudly, never silently.** No empty `catch` blocks on money / audit /
  score surfaces. Failures are logged and surfaced; a skipped step reports as
  skipped. Resolved HAL strictness is logged at boot and per run.
- **Advisory, not blocking (by default).** A contested or tied verdict **never**
  forces an irreversible action. Deadlock is an *uncertainty signal* → safe
  default at low stakes, escalate at high stakes. Protective (reversible) and
  punitive (irreversible) actions have different bars.
- **Shadow before promote.** New consensus / scoring logic runs behind a
  flag-gated shadow hook and is measured against ground truth *before* it can
  change a live decision. Promotion requires an independent co-sign.
- **Nothing silently passes.** Constitutional-audit stubs are contract surfaces,
  not green-lights; real proofs require `proof_bytes`; real settlements require
  `is_simulated = false` and an on-chain `tx_hash`. The database schema itself
  encodes the "is this real?" distinction so overclaim is structurally hard.

---

## Data model (the tables that matter)

The engine reads/writes a small set of Supabase tables; schema is managed
externally (no migrations in this repo):

| Table | Role |
|---|---|
| `repid_agents` | agent state — `current_repid`, DB-derived `tier`, `erc8004_address` |
| `repid_score_events` | append-only audit log of every score change |
| `repid_zkp_proofs` | ZK proofs — `is_real`, `proof_bytes`, `scheme`, `eas_attestation_uid` |
| `erc8004_reputation_writes` | on-chain reputation writes — `tx_hash`, `block_number`, `chain_id` |
| `x402_settlements` | A2A micro-payments — `is_simulated`, `tx_hash`, `amount`, `asset` |
| `hal_validation_runs` / `hal_validation_summaries` | HAL measurement (per-case results + computed F1) |

---

## Request pipeline (`src/index.ts`)

```
helmet → cors (allowlist) → express.json (1mb) → SQL-keyword body sanitizer
       → authMiddleware → rateLimitMiddleware → versioningMiddleware → routers
```

Auth is `Authorization: Bearer <key>` / `x-api-key` against `REPID_API_KEYS`
(`key:tier` pairs); read paths under `GET /api/v1/repid/*` and
`GET /api/v1/erc8004/validate/*` are public. `scoreMonitor` runs anomaly
detection on `repid_agents` on an interval.

---

## Deploy

Railway + nixpacks (`npm install --legacy-peer-deps`, an intentional
lockfile-bypass for a peer-dep conflict). Server binds `0.0.0.0:$PORT`. Secrets
are injected via Railway env vars — never committed.

---

## Reference (deeper canon, not reproduced here)

- `CLAUDE.md` (this repo) — canonical constants, tier scheme, table rules.
- `ZKP_ARCHITECTURE_INVARIANTS.md` — the six ZK invariants and the two-tier
  proving substrate.
- Evidence catalog (`EVIDENCE_CATALOG.md`) — reduction-to-practice a reviewer
  can verify on-chain, line by line.

*Build big, claim small. Verified behavior over reported behavior.*
