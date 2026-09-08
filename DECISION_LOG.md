# DECISION_LOG

Numbered decisions that changed direction, and the reasoning that survives them.

**Why this file exists [CREATED 2026-09-08].** `D-019` and `D-020` were cited as settled
decisions in `zkp-vault/README.md` and in `CLAUDE.md` — and there was **no decision log
anywhere in this repository** to cite. A reader meeting "per DECISION_LOG D-019" had nothing to
open. That is the defect LESSONS rule 12 names: the thing was decided, and the artifact that
should describe it did not exist, so every later agent had to re-derive it or take it on faith.

**These two entries were RECONSTRUCTED from their citations, not from an original.** The
substance is quoted from `zkp-vault/README.md`, which is the closest thing to a primary source.
If an original record exists elsewhere, it supersedes this file — say so and replace these.

**How to add one.** A decision belongs here when it CHANGED DIRECTION and someone will later
ask "why is it like this?". Draft it wherever you think (a vault, a scratch file); the decision
is not made until it is committed here, because a decision nobody can grep is not a decision.
Give it the next `D-0NN`, state what was decided, what it replaced, and what would reverse it.

---

## D-019 — Prove control, not reputation

**Decided:** the ZK statement is **human-anonymous ownership**, not RepID.

**Why:** RepID reputation is already **public on-chain** (ERC-8004), so proving it in zero
knowledge is redundant. The real need is to prove a human **controls** an agent **without
revealing which human** — a Semaphore-style membership proof. No reputation value appears in
the circuit.

**Replaced:** the earlier RepID-range statement (PR #95).

**What would reverse it:** RepID ceasing to be public on-chain, or a requirement to prove a
score to a party that must not learn the agent's identity.

**Status:** the circuit exists in `zkp-vault/` (Rust, Plonky3, 7/7 tests including forgery and
tamper rejection). It is **NOT wired**: its own README says the `POST /prove/ownership` HTTP
wrapper is not done, so the TS bridge cannot reach it, and its FRI parameters are explicitly not
production soundness. What IS in production is the separate `plonky3_range_check` postcard
proof — see the `src/zkp/` section of CLAUDE.md.

## D-020 — Reveal is court-order only, and off-circuit

**Decided:** the link between a human and their commitment is sealed **outside** the circuit,
encrypted to a custodian/court key. The proof establishes control anonymously; any reveal is a
custodian decryption gated by court order.

**Why:** it keeps the circuit unchanged for the reveal path — a reveal is a key-custody
question, not a cryptographic one.

**What would reverse it:** a jurisdiction requiring in-protocol identity, or a custodian
arrangement judged untrustworthy.

**Status:** design only. No custodian key ceremony is recorded in this repository.
