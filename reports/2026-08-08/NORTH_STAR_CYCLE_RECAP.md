# NORTH-STAR CYCLE RECAP — 2026-08-08

**The hard pivot: proofs that verify, memory that stays encrypted, a node the user runs, a reputation
rule where lying costs more than honesty.** All four pillars got a concrete, honest, branch-safe
increment tonight. Everything below is synthetic-fixture-only, branch-only, verified clean of prod data.

## The milestone
**"Data stays yours" went from FALSE (2 nights ago) → PROVEN for the core verify→score→gate loop.**
A node boots with no hosted DB, runs a real 2-family quorum against a *local* model, scores to *local*
SQLite, gates the decision — and **every content channel is sealed** (LLM prompt/embedding, Postgres
rows, Redis cached text). A fetch-tripwire + connection guards prove only attestations/chain commitments
leave. Not a claim — an E2E test.

## The four pillars, honest status
| Pillar | Status | Evidence |
|--------|--------|----------|
| **Data-local / portable** | **PROVEN (core loop)** | #382 full loop zero-egress; #384 closes direct-pg + Redis; #380 boots; #381 local SQLite store. Residual: workers (separate services, attestations only), rate-limit Redis (counters not content). |
| **Searchable encryption** | **REAL cell, ZK-retrieval stub** | #377 working SSE (AES-GCM + HMAC index, query without decrypting); #385 commitment now canon Poseidon2 (ZK-circuit-ready, Invariant-1). Stub: the ZK membership *proof circuit*. |
| **Plonky3** | **Leaf REAL + measured; recursion mapped + deferred** | #379 leaf prove 5.25ms/verify 0.98ms/19.7KB; recursion ABSENT, exact missing capability named (in-circuit STARK verifier), decision = stay native / deferred. #383 synthetic cross-crate verify (redo of #376). |
| **Ungameable reputation** | **Penalty now FIRES (shadow)** | #386 wires the zero-caller deception detectors onto the score path, SHADOW-only default-off; would-be −60 penalties measurable, provably inert when flag unset. |

## Merge queue (8 PRs — merge order matters for the stacks)
- **Self-host spine (merge in order):** `#380 → #382 → #384` → lands the data-local node on main.
- **SSE (in order):** `#377 → #385`.
- **Off main (any order):** `#383` (synthetic ZKP), `#386` (deception shadow), `#372` (starting-score).
- All flags default-OFF; hosted behavior byte-identical. Keep `BFT_DISJOINT_ENFORCE`, `REPID_RUN_EARN_GATE`, `TRUST_DECEPTION_MODE`, `LOCAL_MODE`, `ONLY_ATTESTATIONS_LEAVE` **off in prod** until each is reviewed/measured.

## BLOCKED_FOR_SEAN / decisions
1. **Merge the self-host stack** — the single highest-value action; unblocks the docker-E2E tier.
2. **Deception enforce flip** — stays OFF until you've seen shadow numbers (Rule 23).
3. **BFT_DISJOINT_ENFORCE** — off until a shadow quorum-width check is green.

## Exact next surfaces (why each waits)
1. **Docker E2E run** — a stranger `docker run`s the data-local node + completes verify→score→gate, zero egress. *Best built on merged main*, not the 4-deep stack → waits on the merge.
2. **SSE ZK membership circuit** (Plonky3 inclusion proof over the Poseidon2 tree) — recursion-adjacent; *deferred per the standing native/optional call*.
3. **Earn "ungameable":** a labeled deception corpus + measured detector precision/recall; a persisted receipt chain on the score path; anti-Sybil identity-cost design. *Needs data + design, not just code.*

## Claim gate (holds)
Nothing public as *portable / data-stays-yours (blanket) / MoE-live / ungameable* until the clause is REAL
and hardened. `CONTENT_SAFE_FACTS.md` (living-docs/content) holds the verified-only bullets for Sean to publish.

*Truth over reach. The load-bearing clause is proven; the rest is named, not faked.*
