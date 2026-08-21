# Evergreen ZKP loop — real Plonky3 prove → verify → MEASURED

**Standing priority (Sean, 2026-08-21).** When free XC/GA/T12 capacity exists, or after
any MVP / TrustMarket / E2E slice completes, the next dispatch is the next ZKP vertical
slice. Do not idle. **Zero overclaim until MEASURED.**

This file exists so that priority does not get spent re-deriving things that already
exist. Read the ledger before dispatching anything.

---

## READ THIS FIRST — the estate is far more built than "the prover is a stub" suggests

A first pass at this order was about to dispatch XC to *"define the statement"* and GA to
*"design proof schemas"*. **Both already exist, in shipped code.** Doing that work again
would have been the exact waste `docs/PRIOR-WORK-INDEX.md` was created to prevent — two
sprints once went into optimising a component already at 97.9% of its bound.

What actually exists today:

| Piece | State | Where |
|---|---|---|
| **Statement A1** | **Specified in Rust.** Public values `[0..16] agent_id \| [16] threshold \| [17] repid_score` (18 BabyBear elems). Proves `repid > threshold` via a 16-bit range check, value-bound by `reconstructed == repid_score - threshold - 1`. Documented assumption: `repid - threshold < 65536`, true since RepID ≤ 10000. | `@hyperdag/proof-verifier` `src/lib.rs`, `RepIdRangeCheckAir` |
| **Verifier** | **Published.** npm `@hyperdag/proof-verifier` 0.1.0 / 0.2.0, Apache-2.0, Rust → WASM, `pkg` / `pkg-node` / `pkg-web`. | `DealAppSeo/hyperdag-proof-verifier` |
| **Prover** | **Deployed** as `zkp-postcard`, endpoint `POST /zkp/repid-proof` taking `{agent_id, score, metadata}`. | `scripts/drain-proof-queue.ts` |
| **Prover bridge** | **Real, and degrades loudly.** Calls `$PLONKY3_PROVER_URL` / `$ZKP_SERVICE_URL`, 5s timeout, HMAC fallback stamped `proof_source`, `degraded_mode`, `is_real: false`. Not a placeholder. | `src/zkp/plonky3-real.ts` |
| **ZKP layer** | 18 modules, ~200KB — `repid-delta-statement`, `holder-identity-binding`, `nullifier-identity`, `poseidon2-babybear`, `merkle-root`, `proof-statement-guard`, `erc8004-linkage`. | `src/zkp/` |

---

## Definition of done — with the honest state of each item

Do not mark any of these MEASURED without a GateRun that produces it.

| # | DoD item | State | Evidence / what is missing |
|---|---|---|---|
| 1 | Real prover produces proofs for a documented statement | **PARTIAL** | Statement documented; prover deployed. Never confirmed that the *deployed* prover's output verifies. |
| 2 | Verifier accepts valid / rejects invalid | **MEASURED (crate-internal)** | `tests/zkp-proof-verifier-crosscheck.test.ts` runs a genuine Plonky3 proof through the real WASM and asserts the matrix: accepts honest; rejects inflated score, substituted `agent_id`, lowered threshold, score-at-or-below-threshold. **Caveat: the proof is from the crate's own prover, not the service.** |
| 3 | Product path fail-closed without a proof | **MEASURED** | `tests/verify-proof-fail-closed.test.ts`. It pins a *real fail-open that shipped*: `!!someObject` is always true, so every stored proof returned `cryptographically_verified: true` — including ones the verifier had just rejected. |
| 4 | GateRun MEASURED; mutants/invalid FAIL | **NOT_CHECKED** | Mutants already fail in CI (item 2). No GateRun wrapper emits the verdict yet. |
| 5 | KNOWN-LIMITS updated; UI "Not live" removed | **CORRECT AS-IS** | Both say the prover is a stub. That stays true until item 1 closes. |
| 6 | Peer-review notes | **NOT STARTED** | Pen-test is a later human phase. |

### The single blocking measurement

**Does the deployed `zkp-postcard` prover's output verify under the published verifier?**

Both are aggregation-tier and both are supposed to sit at Plonky3 git rev `27d59f7350`
(CANON P-026 lockstep) — but `PLONKY3_PIN_RECONCILIATION.md` documents a live Invariant-5
divergence, and *supposed to* is not a measurement. A pin drift on either side surfaces
here and nowhere else.

Run: **`scripts/zkp/live-prover-crosscheck.ts`** (written for exactly this). Exit `0`
VERIFIED / `2` NOT_CHECKED / `1` FAILED.

**It cannot run from an agent sandbox.** The proxy answers
`403 Host not in allowlist: zkp-postcard-production.up.railway.app`. That is an *egress
allowlist setting*, not a hard wall — adding the host to the environment's network
settings would let an agent session run it. Until then it is a human-run script.

---

## The loop

```
WHILE free capacity AND prover_path != MEASURED:
  1. XC  — STARK/FRI parameter policy + GateRun predicates.
           NOT "define the statement" — A1 is already in Rust.
  2. GA  — GateRun event shape carrying prove→verify outcomes.
           NOT greenfield proof schemas — A1's public values are fixed.
  3. T12 — fixtures, build scripts, verifier harness. Free models first.
  4. CC  — wire prover → verifier → fail-closed product path. Short turns.
  5. Red-team — mutants/invalid MUST fail; the stub path must NOT claim MEASURED.
  6. Peer-review pack — KNOWN-LIMITS updated ONLY when a status actually changes.
```

**Priority rule.** When a short MVP / TrustMarket / E2E task finishes, the next dispatch
is the next ZKP slice, not sleep.

### The queue — what to dispatch, in order

Both briefs are written and ready. Neither agent has `cross_repo_read`, shell, or http, so
every cross-repo fact they need is **inlined in the brief** — that is why these are long.
Both are `--requires reasoning,repo_read`, both are no-write lanes returning text.

| # | Lane | Brief | Blocks on |
|---|---|---|---|
| S1 | XC (L6 RED-TEAM) | `docs/dispatch/INBOX_XC_ZKP.md` — STARK/FRI parameter policy · pin reconciliation policy · GateRun predicates · **extend the mutation matrix** | nothing — dispatch now |
| S1 | GA (L7 MEASUREMENT) | `docs/dispatch/INBOX_GA_ZKP.md` — `zkp-gaterun.v0` event shape · emission contract · retention posture | nothing — runs in parallel with XC |
| S2 | CC | wire the GateRun emitter to GA's shape, gated on XC's predicates | both S1 briefs returned |
| S2 | human | run `scripts/zkp/live-prover-crosscheck.ts` from a host with egress to the prover | egress allowlist |
| S3 | CC | fold XC's uncovered mutations into `tests/zkp-proof-verifier-crosscheck.test.ts` | XC's S1 matrix |

**S1 is parallel and unblocked.** XC writes predicates against the *properties* it needs
and names them as requirements on GA; GA designs the shape without assuming XC's policy.
Neither waits for the other. The one field they must agree on is **provenance** — XC needs
it as a predicate input, GA owns its shape — and both briefs say so.

**The two scope corrections that produced these briefs, so they are not undone:**

- **XC is not asked to "define the statement".** A1 is already in Rust and shipped. XC's
  real lane is the parameter policy, the pin decision, and the mutation matrix — none of
  which anyone has done.
- **GA is not asked for greenfield proof schemas.** A1's public values are fixed, and the
  verdict shape already exists as `AttestationPresenceVerdict` in trinity-ecosystem. GA's
  lane is the GateRun event that carries prove→verify outcomes, whose missing
  **provenance** field is precisely why DoD item 2 reads *MEASURED (crate-internal)*
  rather than MEASURED.

**Claim rule.** The UI stays *"Not live yet"* until a GateRun reports MEASURED **and**
invalid proofs are rejected on the live path. The glossary entry
(`trustshell lib/glossary.ts`, slug `zkp`) already splits proving from verifying and says
which half is real — keep that distinction; do not collapse it when item 1 closes, because
a working prover still does not make every downstream claim proven.

---

## Fences — non-negotiable on this track

- **The #376 fence.** PR #376 committed a proof lifted from the production
  `repid_zkp_proofs` table — real agent UUID, real score — into this **public** repo. It
  cannot be withdrawn. `scripts/hooks/prod-fixture-guard.js` blocks the shape permanently.
  Every fixture and every live-prover request on this track uses a **fabricated** witness:
  a NIL-variant UUID that no real agent can hold, and a made-up score.
- **Sprint-3 stubs stay stubs** until replaced by something real. Never "fix" a stub by
  hardcoding a pass — that converts an honest absence into a false measurement, which is
  worse than the gap.
- **A verifier that cannot run must never read as verified.** The dangerous default is the
  silent `true`, and this repo has already shipped that bug once.
- **Two pins, one invariant.** Leaf (`zkp-vault`, crates.io `0.3.0`) and aggregation
  (git rev `27d59f7350`) are genuinely separate proof systems today. Reconciliation belongs
  at leaf-wiring time with the KATs re-frozen deliberately — not as an incidental repin.
