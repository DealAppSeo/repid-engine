# NARRATIVE TRUTH AUDIT — "TrustShell: first portable MoE BFT Trust Harness"

**Date:** 2026-08-07
**Auditor:** Claude (Opus 4.8), synthesizing 8 independent component validators
**Method:** Each clause of the marketing narrative is graded against the strongest verified evidence from the component verdicts. Truth over optimism. `[unverified]` tags carried through verbatim.

**The narrative under audit:**
> "TrustShell — the first portable MoE BFT Trust Harness that works with ANY LLM, so you no longer need vendor lock-in, and all your information/training data stays YOURS. Runs on a cheap/free VPS; run multiple frontier models without buying a new computer."

---

## 1. VERDICT UP TOP — per clause

| Clause | Verdict | Single strongest evidence |
|---|---|---|
| **portable** | **PARTIAL** | Client-side WASM proof verification is genuinely portable: `@hyperdag/proof-verifier` runs `p3_uni_stark::verify` in-Node, HONEST proof → `verified:true`, inflated score 9999 → `false`, wrong agent_id → `false` [verified LIVE E2E]. BUT the *harness itself* is not portable — it cannot be self-hosted (see data-stays-yours); today "portable" means only "the proof you receive can be checked anywhere," not "run the node anywhere." |
| **MoE** | **NOT-YET** | The ANFIS/LASSO router uses **hand-tuned constant weights that were never fitted**, runs `mode=shadow` (recorded, not applied), `'live'` is intentionally unimplemented, and the policy "has NEVER BEEN FITTED" (`anfis-router.ts:72-88`, `anfis-escalation-gate.ts:1-58`). No 3+1 role-agent ensemble routes live. There is no live mixture-of-experts *decision* — only a shadow recommendation. |
| **BFT** | **PARTIAL** | REAL + live: a distinct-family quorum forms a veto (`fact-check.ts:673-773`, `model='fact-check-quorum:llama+glm+gemini+mistral+qwen'`, comma-BFT, plurality guard; 53 tests pass). BUT the anti-spoof **family-DISJOINT gate has ZERO live callers** (`src/decisioning/disjointness.ts`; header: "nothing routes live by itself"), and `familyOfResolved` falls back to a **spoofable regex** on unmapped models and never hard-fails. Quorum width observed degrading 5→3. So there is a real quorum veto, but not a *hardened* BFT guarantee. |
| **any-LLM** | **PARTIAL** | REAL: the DI layer is generic, not vendor-hardcoded — arbitrary endpoint/apiKey/model, `openai-compat|anthropic-native` (`cross-llm/providers.ts`, `types.ts:96-111`); published keyless CLI vetoes "Eiffel Tower in Berlin" 4/100 across llama/gemini/mistral/qwen [verified]. BUT the **caller's own key is inert**: `byok/providers` returns `enabled:false`, `/v1/chat/completions` → 503 "not enabled". Live quorum runs on the **operator's fleet keys**, not the user's key end-to-end. |
| **no-vendor-lock-in** | **PARTIAL** | REAL for LLM-vendor lock-in: the client verifies the server's RepID math locally via WASM ("trust math, not the server") and rejects tampering [verified]; the model layer is provider-generic. BUT you are **locked to the hosted repid-engine** — it cannot boot without external Supabase (`config.ts:46` throws), so you cannot escape TrustShell's own hosted service. You swapped LLM lock-in for platform lock-in. |
| **data / training-stays-yours** | **NOT-YET (this is the false one)** | **Data leaves the box, confirmed by file read.** `trustshell.ts:496-519` POSTs the **full text** to `/api/v1/hal/evaluate`; default baseUrl is the hosted `repid-engine-production.up.railway.app`; the engine then **fans that text to remote LLM APIs** (groq/cerebras/fireworks/deepseek/gemini/mistral/openrouter/qwen, all `https://api.*`). Only a sha256 hash is persisted, but the plaintext still egresses to third parties. There is **no "only attestations leave" mode** in either repo. |
| **runs-on-cheap-VPS / multiple frontier models without a new computer** | **PARTIAL (true but self-cancelling)** | TRUE that you need no GPU/new computer — the "multiple frontier models" are reached by **cloud API fan-out**, and `Dockerfile.fly` is host-agnostic (Railway/Fly/Coolify). BUT this is TRUE *only because* prompts egress to the hosted engine + cloud LLMs — i.e., the same fact that makes data-stays-yours FALSE. A self-contained cheap-VPS node that keeps data local does not exist. |

### Can we say "the first portable MoE BFT Trust Harness ... data stays YOURS" without lying?

**No.** The compound claim fails on at least three clauses:

1. **data-stays-yours is FALSE today** — every prompt is POSTed to a hosted engine and fanned to third-party LLM APIs. This is the load-bearing lie; it is not a nuance, it is the opposite of what the sentence says.
2. **MoE is NOT-YET** — the router is unfitted constant weights in shadow mode; nothing mixes experts as a live routing decision.
3. **"portable"** is only true of the *proof artifact*, not the *harness* — you can verify a proof anywhere, but you cannot run the node anywhere.

What **is** honestly sayable **today**:
> "A hosted BFT trust harness that runs a real cross-family LLM quorum veto and issues a RepID range-proof you can verify locally in WASM — no LLM-vendor lock-in, works across any provider, no GPU needed."

Every word of that is backed by a `[verified]` component. It drops "portable," "MoE," and "data stays yours," which are the three that are not true yet.

---

## 2. COMPONENT TABLE

| Component | Status | Evidence (strongest) | Gap | Effort | Tonight? |
|---|---|---|---|---|---|
| `trust-harness-e2e.mjs` 7-leg demo | **PARTIAL** | Build exit 0; repid/proof/nullifier/anchor/fold=REAL, but **HAL=UNKNOWN** (public HAL endpoint returns HTTP 429 daily-cap), gate correctly **REFUSE / exit 1** fail-closed | HAL never ran (rate-limit exhausted); step3 "VERIFY LOCALLY" does **no** local verification (byte-count only, `proofVerified:true` from `state==='REAL'`); fold committed a no-op (delta +0, `binding=false`) downstream of HAL UNKNOWN | L | No |
| HAL cross-provider veto + any-LLM/BYOK layer | **REAL** | Keyless CLI: false claim → VETO 4/100, 5 providers all FALSE across families; DI layer generic (arbitrary endpoint/model) | User-facing BYO-key surface **inert** behind default-OFF flags; live quorum uses operator fleet keys, not caller's key | M | Yes |
| RepID weights + asymmetric-deception formula | **PARTIAL** | Weights real+tested: deception −60/−40 vs honest-error −8 (5–7.5× spread), 83 tests pass; confident-wrong costs > right earns | Keystone **not live**: `deceptionMode()` defaults `shadow` (score never mutated); **zero callers** wire the behavioral-integrity detectors into `updateRepId`; live HAL negative path suppressed at `HAL_STRICTNESS=1` default | M | No |
| ZKP leaf: Poseidon2 hash + Plonky3 range proof + local WASM verify | **REAL** | Poseidon2 bit-exact vs p3's own published KAT (Rust 25 pass, TS 18 pass); range proof local verify LIVE E2E via WASM — HONEST→true, inflated/wrong→false | No Groth16 (all STARK/FRI — task misnomer); **Poseidon2 leaf is not the live-served proof** (live POSTCARD uses keccak range check); dual Plonky3 pins violate Invariant 5; test-mode fragility (no single `cargo test` mode all-green) | M | Yes |
| Plonky3 recursion / AGGREGATION tier | **ABSENT** | The only Plonky3 circuit is **one leaf uni-stark** (`zkp-vault`); p3 0.3.0 ships **no recursion crate**; "fold many leaves→root" is a **TypeScript Merkle accumulator** that proves inclusion/timestamp only, not verified computation; `delta-anchor.ts` has 0 callers, 0 rows | Need a recursion/aggregation AIR (frontier crypto) or stack switch (Plonky2/SP1/Risc0); production FRI params; Merkle-path membership; live prover (`PLONKY3_PROVER_URL` unset → 100% HMAC stub) | XL | No |
| MoE router (ANFIS/LASSO 3+1) + family-disjoint BFT | **PARTIAL** | BFT quorum REAL+live (53 tests); comma-BFT + plurality guard wired | MoE side STUB: unfitted constant weights, shadow-only, retune floor unreachable (~5 decisions/day vs 20 samples/provider needed); disjointness gate has 0 live callers; regex family fallback spoofable | L | No |
| Self-hostable local trust node ("data stays yours") | **STUB** | Data **leaves the box**: full text POSTed to hosted engine → fanned to cloud LLM APIs; engine can't boot without hosted Supabase (`config.ts:46` throws); no "only attestations leave" mode. Building blocks exist: `Dockerfile.fly` host-agnostic, `TRUSTSHELL_API_URL` overridable, proof verify already client-side | Need: (1) local-store boot without hosted Supabase; (2) `*_ENDPOINT` overrides so quorum points at local Ollama/vLLM; (3) documented `docker run` BYO-everything path; (4) define "only attestations leave" boundary | XL | No |

---

## 3. THE CRITICAL PATH — hard-parts-first, to make every clause TRUE

**#1 is load-bearing.** A thin client that ships prompts to our hosted HAL cannot honestly claim "data stays yours." Until #1 lands, the headline sentence is false no matter what else ships.

1. **[LOAD-BEARING · XL] Self-host / data-local mode.** (a) Make the engine boot without hosted Supabase — optional SQLite/Postgres/in-memory store, remove the hard `config.ts:46` throw for local mode. (b) Add OpenAI-compatible `*_ENDPOINT` overrides for the core HAL providers so the quorum can target a local Ollama/vLLM/llama.cpp instead of `https://api.*`. (c) Ship a documented `docker run` BYO-everything path (local models + local DB + local attestor key) with the wrapper defaulting `apiUrl` to `localhost`. (d) Define and enforce the "only attestations leave" boundary — proofs/EAS anchors may egress, prompt+response text never does. **Only this makes data-stays-yours, true "portable," and true "no-vendor-lock-in" simultaneously true.**

2. **[XL · frontier] Real Plonky3 aggregation** *or* **honest relabel.** Either build a recursion/aggregation AIR (or stack-switch to Plonky2/SP1/Risc0) with production FRI params and a live prover service — multi-session frontier crypto — **or** relabel "aggregation" as a Merkle accumulator + EAS anchor (what the TS already does) and stop implying a recursive *proof*. The honest relabel is free and removes an overclaim; the real build is XL.

3. **[M] Make asymmetric-deception + HAL-negative path actually bite.** Flip `TRUST_DECEPTION_MODE=enforce` (Sean-gated, shadow-first) AND wire an emitter that runs the behavioral-integrity detectors on real interactions into `updateRepId` (no such caller exists today). Separately set `HAL_STRICTNESS=2` with quorum providers enabled so the live negative path is not suppressed. This is what turns "BFT" from a passing test into a live consequence.

4. **[L] Harden BFT disjointness.** Wire `src/decisioning/disjointness.ts` (`assembleDisjointJudges`/`assertDisjoint`) into the live quorum so judges are registry-hard-fail disjoint from candidates, and kill the `fact-check.ts` regex family fallback that lets an unmapped model spoof its family. Turns PARTIAL-BFT into a real anti-spoof guarantee.

5. **[M] Turn on the caller's own key (any-LLM E2E).** Lift the default-OFF BYOK flags so a user's key drives the quorum end-to-end (`byok/providers enabled`, `OPENAI_COMPAT_ENABLED`, widen `router.ts:26` caller-key types). Makes "works with ANY LLM" true for the *user's* LLM, not just the operator's fleet.

6. **[L] Fix the E2E demo so it proves what it claims.** Give the demo a keyed HAL run (bypass the daily public cap) so quorum executes, implement genuine local STARK verification in step 3 (a callable verifier, not byte-count), and re-run so a real non-trivial delta folds with `binding=true`. Turns the 7-leg demo from `1 leg UNKNOWN / REFUSE` into a real green receipt.

7. **[M] ZKP hygiene.** Serve the Poseidon2 leaf live (not just the keccak range check), collapse the dual Plonky3 pins to one (Invariant 5), and add a committed cross-crate test taking a `zkp-postcard` proof through `@hyperdag/proof-verifier`.

---

## 4. BUILDABLE-TONIGHT vs FRONTIER-HARD

**A focused engineer can land tonight (inert/branch-safe):**
- Turn on caller BYO-key surface (any-LLM E2E) — component marked `buildable_tonight:true`, effort M.
- Serve the Poseidon2 leaf live + add the cross-crate proof→verifier test + collapse pins — ZKP component `buildable_tonight:true`, effort M.
- Wire the disjointness gate into the live quorum and kill the regex family fallback — the anti-spoof half of BFT (effort L, mechanical wiring; no new crypto).
- Keyed HAL run + genuine local-verify in the demo step 3 (the verifier already exists in WASM; the demo just doesn't call it) — makes the 7-leg receipt honest.

**Frontier-hard / multi-session (NOT tonight):**
- **Real Plonky3 recursion/aggregation** (component ABSENT, effort XL) — p3 0.3.0 has no turnkey recursion; this is a hand-built in-circuit STARK-verifier AIR or a stack switch. Multi-session.
- **Self-host / data-local mode** (component STUB, effort XL) — decoupling the engine from hosted Supabase + adding local-model endpoint overrides + the "only attestations leave" boundary. This is the load-bearing one and it is not a one-nighter.
- **MoE that actually decides** — blocked by throughput, not code: the ANFIS retune floor needs ~20 samples/provider/24h against ~5 total decisions/day. You cannot fit the policy until traffic exists; flipping it "live" on unfitted constant weights would be a fake, not a feature.
- **Asymmetric-deception emitter** — building it is M, but it changes live RepID state, so it is shadow-first and Sean-gated, not a merge-tonight.

---

## 5. HONEST RECOMMENDATION TO SEAN (for the morning)

The engineering under this narrative is real and unusually honest in the parts that count — a live cross-family LLM quorum that genuinely vetoes a false claim, a RepID range proof a stranger can verify locally in WASM and that rejects an inflated score, and a gate that fails closed when it can't run. That is a defensible "hosted BFT trust harness, no LLM-vendor lock-in, no GPU needed" story you can post today with every word backed by a `[verified]` component. What you **cannot** say yet is "portable" and "data stays yours": the thin client POSTs full prompt text to our hosted engine, which fans it to eight third-party LLM APIs, and the engine can't even boot without hosted Supabase — so the single sentence that most defines the pitch is currently its least true clause. Tonight, wire the caller's own key, serve the Poseidon2 leaf, harden the disjointness gate, and make the demo actually verify locally so its receipt is honest. But treat the **self-host / data-local mode as the one flagship build that unlocks three clauses at once** (portable + no-lock-in + data-stays-yours) — until it lands, either soften the headline to what the hosted system truly does, or hold the "data stays YOURS" claim entirely. Don't ship the sentence ahead of the boundary; a published overclaim on a public receipt is exactly the kind of thing this whole trust harness exists to catch.

---
*Truth over flattery. A measurement without its ruler is not a result. Numbers and endpoint contracts marked `[unverified]` where the validator did not probe live prod.*
