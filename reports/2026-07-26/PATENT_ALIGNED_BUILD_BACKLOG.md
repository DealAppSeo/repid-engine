# Patent-Aligned Build Backlog — deep queue for the swarm
**Created:** 2026-07-26 · **Purpose:** the always-there queue so when tasks/phases/loops finish faster than expected, agents pull the *next* highest-value, dependency-ordered, patent-relevant work — much of the eventual feature is then already built + tested when we decide to complete it.
**Prioritization rule (Sean 2026-07-26):** favor what (a) unblocks downstream work, (b) is a **reduction-to-practice for a filed patent** (building + proving a claim materially helps grant), (c) is free/cheap. Frontier/exotic stays gated. Ties: [[project_proof_carrying_retrieval]], spec `03_specs/PROOF_CARRYING_RETRIEVAL_v0.md`, D-094.

## Three patents (Grok analysis; Sean filing) — build/file order
- **Patent #1 — Current-valid, revocable, proof-carrying agent memory.** Indexed Merkle (LeanIMT+) + reputation-weighted leaves + on-chain root + **binding the inclusion/current-validity proof into the agent's answer**. *File first.* Reduction-to-practice = P0–P3 + answer-binding.
- **Patent #2 — Policy-gated proof-tier selection via unified ANFIS/LASSO fabric.** One policy model decides the 5 axes AND the required cryptographic proof strength (inclusion → current-validity → authenticated walk → ranking integrity) from cost/stakes/privacy/latency/reliability. *File second.*
- **Patent #3 — Hybrid: verifiable GraphRAG over current-valid memory + knowledge-boundary abstention + hierarchical durable harness.** *File as continuation / continuation-in-part; builds on #1+#2.*

## Status snapshot
- ✅ **P0** proof-carrying leaf + fork-independent inclusion verify — PR #198 (verified vs real Poseidon2).
- ✅ **P1** LeanIMT+ accumulator: membership + non-membership + **provable retraction** — PR #203 (9/9 props under real Poseidon2). ← Patent #1 core, reduced to practice.
- ✅ **Item 13** hierarchical durable memory — all three acceptance-criteria primitives on main (PR #817 performHeatEviction, PR #821 evictAndUpdateRoot, PR #1012 reactivateLeaves, PR #1022 HTTP route), all gated `HEAT_EVICTION_ENABLED`. Prod enable is Sean GO. Verified by beat sixth run 2026-10-01.
- ✅ **Item 20** commitment well-formedness (option b) — PR #250 (merged 2026-07-28), wired into `memory-publication.ts`. Verified by beat 66, 2026-08-27 — this snapshot line had gone stale for ~10 beats before that. See item 20's row for file:line evidence.
- Poseidon2 BabyBear leaf merged (#195/#196/#197). Breakers 2.0/2.3 merged (#188/#191); #189/#192/#193/#194 in flight.
- ✅ **Item 2** P0.1 two-primitive refactor — landed in #197 (2026-07-26) and wired as the DEFAULT, not
  just available: `LeanIMTPlus` (`src/memory/leanimt-plus.ts:77-78`) and `ProofCarryingMemory`
  (`src/memory/proof-carrying-memory.ts:63-69`) both default `leafHash`/`pairHash` to
  `poseidon2LeafHash` (sponge) / `poseidon2PairHash` (compression). Gated bit-exact against an
  independent Rust oracle KAT (`zkp-vault/kat/poseidon2_babybear16_leaf_kat.json`) and exercised by
  8+ test files (`tests/leaf-dual-write.test.ts`, `tests/leanimt-plus-*.test.ts`,
  `tests/memory-publication.test.ts`, `tests/mesh-memory-sse.test.ts`, …). Verified by beat 73,
  2026-08-30, by reading the call sites, not the table.
- ✅ **Item 6** HAL abstain / knowledge-boundary — wired, not just name-grep hits. Verified by beat 71, 2026-08-29 by reading the call site: `computeGroundingSignal` (`src/hal/hal-grounding.ts:69`) is called from `src/scoring/pipeline.ts:450`, its `would_abstain`/`grounded` fields are written into the score event's `metadata.grounding` (`pipeline.ts:587-588`) on every scoring call — the "compute + log" half of the shadow contract is real, not aspirational. `HAL_GROUNDING_MODE` defaults to `shadow` (log-only); `enforce` (ungated, Sean GO before flipping in prod) zeroes a positive delta when an answer claims grounding it can't prove. 6 dedicated test files exercise it (`tests/hal-grounding.test.ts`, `tests/hal-grounding-root-currency.test.ts`, `tests/verifier-never-throws.test.ts`, `tests/answer-binding-pins.test.ts`, `tests/proof-carrying-e2e.test.ts`, `tests/proof-carrying-lifecycle-e2e.test.ts`). See item 6's row for what remains: the "measured hallucination drop" acceptance criterion needs live shadow-mode traffic carrying a proof-carrying answer, which does not exist yet (`applicable:false` for all current traffic per the file's own header) — the primitive is done, the measurement is not.
- ✅ **Item 5** `agent_memory_leaves`/`agent_memory_roots` DDL — landed in PR #490 (merged
  2026-08-28, all checks green), contradicting CLAUDE.md's "no migrations live in this repo": the
  additive migration is `supabase/migrations/20260828000000_agent_memory_leaves_and_roots.sql`, and
  `src/memory/memory-root-store.ts` is the pure DB-row↔`IndexedLeaf` boundary that satisfies the
  item's own acceptance test ("append→root deterministic; recompute matches") without a live
  database — 6/6 tests in `tests/memory-root-store.test.ts`. Scope note from the PR itself: schema +
  pure helper only, not yet wired into the scoring pipeline (`computeGroundingSignal`'s
  `current_memory_root` parameter still has zero callers) — the table exists for item 3/6 to
  eventually read from, it does not by itself close either. Verified by beat 74, 2026-08-30, by
  reading the migration + the merged PR, not the table.
- ⚠ Items 3-4, 7, 10 (retrieval API, answer-binding, ANFIS enablement, EAS anchoring) show partial
  name-grep hits in `src/` as of 2026-08-27 but have not been verified wired the way item 20 was —
  do not assume done or not-done from this line, check the item.
- 🔶 **Items 8/9** (ANFIS speculative cascade / SCHEDULE axis) — item 8 shadow + integration wired, Sean GO to enable `CASCADE_SPECULATION_ENABLED`. Item 9 decisions (b)/(c) and shadow wiring done (PR #768); off-peak-windows EAS caller is Sean-gated (gas spend). [MEASURED 2026-10-01, beat sixth run]

## Dependency-ordered queue
| # | Task | Patent | Phase | Tier | Acceptance test | When |
|---|---|---|---|---|---|---|
| 1 | Land #198 → rebase #203 to main | #1 | P0/P1 | Sean+CC | both green on main; #203 diff = P1 only | **DONE — #198 merged 2026-07-27 (`feat(memory): proof-carrying retrieval P0 — committed-memory leaf + inclusion verify`), #203 merged 2026-07-27 (`feat(memory): P1 LeanIMT+ — membership, non-membership, provable retraction`, stacked on #198). Verified by beat 75, 2026-08-30, via `gh api pulls/198` and `pulls/203`. Row was stale for over a month.** |
| 2 | **P0.1 two-primitive refactor** — inject `hashLeaf`(sponge)+`hashPair`(compress) instead of one Hash2 | #1 | P0.1 | CC | leaf commitment uses sponge; existing tests pass | **DONE — #197 (2026-07-26), wired as the default `leafHash`/`pairHash` in both `LeanIMTPlus` (`src/memory/leanimt-plus.ts:77-78`) and `ProofCarryingMemory` (`src/memory/proof-carrying-memory.ts:63-69`), KAT-gated against an independent Rust oracle. Verified by beat 73, 2026-08-30, by reading the call sites.** |
| 3 | **P2 retrieval API** — return `(content, inclusionProof, currentValidityProof, root)`; verifier endpoint | #1 | P2 | CC/GA | retrieved entry's proof verifies; revoked entry → non-membership | **PARTIAL — the *verifier* half shipped (PR #533, merged 2026-08-29): `POST /api/v1/proof-carrying/verify` (`src/routes/proof-carrying-verify.ts`) exposes the existing pure `verifyProofCarryingAnswer()` over HTTP, tested in `tests/proof-carrying-verify-route.test.ts` (grounded roundtrip, tampered-answer detection, malformed-citations adversarial input). **The retrieval half's blocker was mis-named "a persistence design" — beat 85, 2026-09-01, traced it to a narrower, now-closed gap.** Item 5's DDL (PR #490) and `memory-root-store.ts` already existed, but nothing turned a fetched row set back into a live tree able to produce a witness — `LeanIMTPlus`'s constructor only ever started from an empty sentinel. `LeanIMTPlus.fromLeaves()` + `memory-root-store.ts`'s `hydrateTree()` (beat 85, PR #575) close that: a row set in, a live prover out, root and witnesses verified identical to a freshly-built tree (6/6 new tests). Still explicitly NOT done: an authenticated per-agent endpoint that fetches this agent's rows and calls `hydrateTree` — `grep -rn "hydrateTree\|fromLeaves" src/` outside the two definitions is zero hits. Item 4 (answer-binding) stays blocked on that route, not on the data structure anymore.
**Sharper finding, beat 85, 2026-09-01: the endpoint isn't just unwritten, it has no `content` to
return yet.** The acceptance test wants `(content, inclusionProof, currentValidityProof, root)`
back, but `agent_memory_leaves` (migration `20260828000000_agent_memory_leaves_and_roots.sql`)
stores only `value`/`next`/`tombstoned`/`leaf_index` — the commitment, never the content it
commits to. `ProofCarryingMemory` (`src/memory/proof-carrying-memory.ts:62`) keeps content
off-index in its OWN in-process `Map`, which is exactly what makes it unusable across a real HTTP
request: that map doesn't survive past the request that built it. Grepped for any persisted
content store — `agent_memory_content`, `memory_entries`, `memory_content` — and for any migration
file whose contents mention `content` at all: zero hits tying content to a leaf. So the retrieval
endpoint is blocked on a second, still-open persistence design (where does content live, keyed by
what, self-service or write-once at insert time) — not the same gap PR #575 closed, and not
attempted this beat for the same reason beat 84 didn't build item 8's output-confidence scorer: it
is a real design decision with its own tradeoffs, not a route to wire.**

**Content-storage decision made and built, beat 86, 2026-09-01.** Additive migration
`supabase/migrations/20260901000000_agent_memory_leaf_content.sql` adds
`agent_memory_leaf_content`, content-addressed and write-once: `unique(agent_id, value)`, where
`value` is the entry's own leaf commitment (`poseidon2LeafHash(encodeEntry(entry))`) — the same
key `ProofCarryingMemory`'s in-process `Map` already used, so the same idempotency (re-adding
identical content is a no-op) carries over. Deliberately keyed by `value`, not by
`agent_memory_leaves.leaf_index`/`root_epoch`, because content-addressing means one entry can
recur at a different index in a later epoch without being re-hashed or re-stored. `encodeEntry`
(`src/memory/proof-carrying-memory.ts`) is now exported rather than re-derived, so the new
`src/memory/memory-content-store.ts` cannot drift from the format the tree was actually built
against. That module's `contentMatchesValue`/`verifiedEntry` recompute the commitment from a
row's own fields and refuse to hand back unchecked content — the same non-negotiable-check
pattern `memory-root-store.ts`'s `auditStoredCommitment` already established for roots, so a
corrupted or swapped row (wrong content, wrong source_repid, a value copied from a different
entry) is caught rather than trusted. 7/7 new tests (`tests/memory-content-store.test.ts`),
`npx tsc --noEmit` clean. Zero callers (`grep -rn "memory-content-store\|verifiedEntry" src/`
finds only its own definition/test) — schema + pure boundary only, same shape as item 5's own
migration before it had a reader. **Still not attempted: the authenticated per-agent HTTP
endpoint itself** (fetch this agent's `agent_memory_leaves` + `agent_memory_leaf_content` rows,
`hydrateTree()` them, produce a witness per entry, verify each via `verifiedEntry` before
returning it) — both blockers item 3's acceptance test named are now closed at the primitive
level, but nothing yet calls either one from a route. NEXT — this is the actual remaining scope,
not a further design question.

**DONE — PR #592, merged 2026-09-03T08:38:33Z, 9/9 checks green.** `GET /api/v1/memory/retrieve`
(`src/routes/memory-retrieve.ts`), mounted in `src/index.ts`, identity from `(req as any).agent_id`
only (never a client-supplied field — 403 for an unbound key). Fetches this agent's latest
`agent_memory_roots` row, the `agent_memory_leaves` at that epoch, and its
`agent_memory_leaf_content` rows, then hands all three to the pure `retrieveVerifiedMemory` bridge
(`src/memory/memory-retrieval.ts`, PR #589) — the acceptance test's full tuple
`(content, inclusionProof, currentValidityProof, root)` comes back per entry, wire-transformed
(bigint→string). 4/4 tests in `tests/memory-retrieve-route.test.ts`, reverified 2026-09-04
(Beat 98) with `npm install --legacy-peer-deps` + a live `npx jest` run, not just read.
**Beat 97 (2026-09-04) mis-diagnosed this row as still open**, grepping
`hydrateTree\|fromLeaves\|verifiedEntry` against `src/routes/` and finding zero hits — the route
calls the higher-level `retrieveVerifiedMemory` bridge, not those three names directly, so the
grep missed a route that already existed and had already shipped a day earlier. Lesson-5 shape
(match the real names the system emits, not the ones you expect) applied to a verification step,
not just a data value. Item 4 (answer-binding) is consequently NOT blocked on this — see item 4's
own row: it was independently confirmed closed by beat 93. |
| 4 | **Answer-binding** — gate answer emit on successful verify; answer carries commitment to its proof set | #1 | P2 | CC | answer w/o valid proof set is refused/flagged; binding is checkable | **DONE — PR #595, merged 2026-09-03T12:50:19Z, 9/9 checks green, verified independently by beat 93.** `bindAnswerFromRetrieval` (`src/memory/answer-binding-retrieval.ts`) draws citations only from a `retrieveVerifiedMemory` (item 3) output — already root- and content-checked — and throws `abstain: ...` on an empty cite list or a value that is not currently a verified member (covers the revoked-entry case). `POST /api/v1/proof-carrying/emit` (`src/routes/proof-carrying-emit.ts`) exposes it over HTTP, same `agent_id`-only identity contract as item 3's route. 10/10 tests (`answer-binding-retrieval.test.ts`, `proof-carrying-emit-route.test.ts`), reverified 2026-09-04 (Beat 98) with a live `npx jest` run. This row was stale for 2 beats (94-97) — this repo said "NOW" for work that had already shipped, the same class of staleness the item-3 row above had. |
| 5 | `agent_memory_leaves` + `agent_memory_roots` tables (additive DDL) | #1 | P1 | CC | append→root deterministic; recompute matches | **DONE — PR #490 (2026-08-28), migration `supabase/migrations/20260828000000_agent_memory_leaves_and_roots.sql` + `src/memory/memory-root-store.ts`, 6/6 tests. Verified by beat 74, 2026-08-30. NOT yet wired into scoring (item 3/6's currency read still has zero callers).** |
| 6 | **HAL abstain / knowledge-boundary** — refuse/flag when cited evidence lacks a valid inclusion+current-validity proof | #1/#3 | — | GA/CC | ungrounded answer → abstain in shadow; measured hallucination drop | **DONE (primitive + wiring + logging) — `computeGroundingSignal` (`src/hal/hal-grounding.ts:69`), called from `src/scoring/pipeline.ts:450`, logged into score-event `metadata.grounding`/`metadata.grounding_abstained` (`pipeline.ts:587-588`) on every scoring call. `HAL_GROUNDING_MODE` shadow-first, default `shadow`. Verified by beat 71, 2026-08-29, by reading the call site and the write, not the table. REMAINING: no current traffic carries a proof-carrying answer (`applicable:false` today), so the "measured hallucination drop" half of the acceptance test has nothing to measure yet — that needs P2 retrieval (item 3) producing real proof-carrying answers first.** |
| 7 | **ANFIS enablement** — mint 12 agent keys + `ENGINE_LLM_PROXY` + `ROUTER_STRICT_COST_ORDER` (staged; flips = Sean GO) + 5 acceptance tests | #2 | — | CC | no-leak/injection/ANFIS-decision/live-routing/job-token tests green | **STAGING DONE — 5 acceptance tests (a)–(e) built and passing in `tests/anfis-enablement.test.ts` (8/8 tests; 5 criteria, some with sub-cases). Verified by beat 2026-09-19 fourth run: `./node_modules/.bin/jest tests/anfis-enablement.test.ts --forceExit` → 8/8. Tests cover: (a) no-leak (provider keys never echoed in logs), (b) server-side injection (engine injects provider key — no caller key needed), (c) ANFIS decision present in response + logged to `anfis_routing_logs`, (d) `ROUTER_STRICT_COST_ORDER` gates ANFIS reorder (shadow invariant), (e) job-token-auth scope + agent binding enforced. The "Sean GO (flip)" half remains: minting 12 agent keys (prod DB write) + enabling `ENGINE_LLM_PROXY` + `ROUTER_STRICT_COST_ORDER` in Railway.** |
| 8 | **ANFIS speculative cascade** — cheap draft → escalate on low confidence/high stakes | #2 | — | GA | cost drop measured vs always-full; quality held | **PARTIAL — shadow + integration wired, Sean GO to enable [MEASURED 2026-10-01, beat sixth run].** Decision primitive (`runSpeculativeCascade`, PR #227) done since beat 80. Shadow observation wired into `routeRequest()` via `src/providers/speculative-cascade-shadow.ts` (PR #763, `shadowCascadeDecision` imported at `router.ts:22`, called fire-and-forget at `router.ts:474`, inert unless `CASCADE_SPECULATION_ENABLED=true`). Full integration layer built: `src/providers/cascade-integration.ts` (PR #776) wires `runSpeculativeCascade` with `scoreOutputConfidence` from `src/providers/output-confidence-scorer.ts` (the post-call scorer the earlier partial-row said was missing — it exists), all under `CASCADE_SPECULATION_ENABLED` gate. **Previous row text "zero callers / no output-confidence scorer / design decision open" was stale when it was last written** — PRs #763 and #776 had already merged. Enabling `CASCADE_SPECULATION_ENABLED=true` on Railway is Sean GO (same class as items 7/9 flags). Acceptance test ("cost drop measured vs always-full") needs a live enable to measure; the code path is done. |
| 9 | **ANFIS SCHEDULE axis** — free-tier quota tracking + off-peak windows for EAS anchoring + non-urgent work | #2 | — | GA | non-urgent work batched off-peak; $ drop measured | **PARTIAL — investigated by beat 75, 2026-08-30. The off-peak-windows half has a real, tested primitive: `isOffPeakHour`/`selectOffPeakBatch` (`src/memory/memory-root-anchor.ts:112-125`), whose own header names it "the ANFIS SCHEDULE axis", covered by `tests/memory-root-anchor.test.ts` — but it has ZERO callers anywhere in `src/routes`/`src/engine`/`src/observability` (grepped), so no cron or worker invokes it and no non-urgent work is actually batched off-peak today (same "wired one end only" shape as item 5's `current_memory_root` parameter). **Correction, beat 81, 2026-08-31: the free-tier-quota-tracking half is not "does not exist" — that
was imprecise.** A real, live, wired cap system already exists: `checkCap`/`incrementSpend`
(`src/billing/caps.ts`), backed by the `llm_provider_caps` table, called on every candidate
adapter in `src/providers/router.ts`'s hot path (lines 693, 743) and already producing a `cap_hit`
routing reason. But it is a **$-denominated** monthly cap, and every `FREE_PROVIDERS` provider
bills ~$0 per call by definition — so this cap structurally can never trip for them regardless of
call volume. The real gap is narrower: no CALL-COUNT ceiling exists for providers whose cost
signal is always ~zero. `evaluateFreeTierQuota` (`src/billing/free-tier-quota.ts`, beat 81) is a
pure decision primitive for that gap — caller supplies `{provider, callsToday, dailyCallCap}`,
returns `{allowed, remaining, reason}`; `dailyCallCap <= 0` is opt-in-uncapped, not a silent deny.
4/4 tests, `npx tsc --noEmit` clean. Zero callers (`grep -rn "evaluateFreeTierQuota" src/` finds
only its own definition) — same shadow-inert shape as items 8/10. Three follow-up decisions
remain open, not attempted this beat: where the per-provider daily count is actually tracked (new
column vs. counting `llm_call_log` rows live), whether it plugs into `router.ts`'s existing
`cap_hit` reason or reports a distinct one, and fail-open-vs-closed when the count is unavailable.
**Decision (a) closed, beat 83, 2026-09-01: counting `llm_call_log` rows live, not a new column.**
`getFreeProviderCallsToday(provider)` (`src/billing/free-provider-call-count.ts`) is a read-only
count query — `.eq('provider', ...).gte('created_at', now-24h)` with `{count: 'exact', head:
true}`, the same table and rolling-24h convention `./llm-calls-24h.ts` already uses for the
cost/efficiency dashboards, so this is not a second counting convention. 3/3 tests (exact count,
null-count-returns-0, propagates a query error rather than swallowing it), `npx tsc --noEmit -p .`
clean. Zero callers (`grep -rn "getFreeProviderCallsToday" src/` finds only its own definition) —
still shadow-inert, and deliberately so: decisions (b) and (c) — a configured `dailyCallCap` per
provider, and whether this plugs into `router.ts`'s `cap_hit` reason or a distinct one — are
product decisions, not plumbing, and stay open. NOW.**
**Decisions (b)/(c) CLOSED and shadow wiring COMPLETE — [MEASURED 2026-10-01, beat second run].** `src/providers/free-tier-quota-shadow.ts` exists, is imported in `router.ts:23`, and called fire-and-forget after routing at `router.ts:489`. Decision (b): signal `free_quota_hit` (distinct from `cap_hit` — different constraint class). Decision (c): fail-open on DB error (try/catch, warns only). Default cap: 500 calls/24h, overridable via `FREE_TIER_DAILY_CAP_DEFAULT`. 6/6 tests in `tests/providers/free-tier-quota-shadow.test.ts`. **Shadow is inert unless `FREE_TIER_QUOTA_SHADOW_ENABLED=true` on Railway** — the gate off by default, never blocks routing. NEXT: enable shadow in prod to measure how many calls WOULD have been capped; only then decide whether to promote to enforce. **Off-peak-windows gap CLOSED [MEASURED 2026-10-07, beat second run]: `src/memory/memory-root-anchor-sweep.ts:15,62-64` imports and calls `isOffPeakHour`/`selectOffPeakBatch`; `src/index.ts` (PR #1211, merged 2026-10-05) calls `runMemoryRootAnchorSweep`. Chain: `index.ts → runMemoryRootAnchorSweep → isOffPeakHour/selectOffPeakBatch`. Both halves of item 9 (free-tier quota shadow + off-peak windows) are now wired and shadow-inert. The row "still has zero callers" was stale.** |
| 10 | **P3 EAS anchoring** of `memory_root` per epoch, batched off-peak | #1 | P3 | CC | `agent_memory_roots.eas_uid` populated; on-chain matches local root | **PARTIAL — investigated by beat 76, 2026-08-31. The anchoring primitive is fully built and tested (`anchorMemoryRoot`/`buildMemoryRootAttest`/`decodeAnchorFields`/`verifyMemoryRootAnchor` in `src/memory/memory-root-anchor.ts`), reusing the existing EAS rail with no new schema — but `anchorMemoryRoot(` has exactly one hit in `src/` (its own definition); every other reference is a test or a doc comment. No cron/route/worker calls it. The item-5 migration says so itself: `supabase/migrations/20260828000000_agent_memory_leaves_and_roots.sql:23-24,70` leaves `eas_uid`/`anchored_at` null "until backlog item 10 (EAS anchoring) exists to populate them". Same "wired one end only" shape as item 9's off-peak batching — which needs THIS item's caller to have anywhere to plug into. **Update, beat 79, 2026-08-31: the orchestration layer joining items 9+10 now exists —
`runMemoryRootAnchorSweep` in `src/memory/memory-root-anchor-sweep.ts` (found already pushed to
`origin/feat/memory-root-anchor-sweep` by a prior session that built and tested it but never
opened a PR or logged it — adopted here rather than duplicated with an independent
implementation). It fetches pending rows (`fetchPending`, injected), applies
`isOffPeakHour`/`selectOffPeakBatch` (now generic over any row shape, not just `PendingRoot`),
anchors each chosen row via `anchorMemoryRoot`, and writes back only on success — one bad row's
throw is caught per-row so it can't sink the rest of the batch. 4/4 new tests pass, all I/O
injected (`fetchPending`/`attestFn`/`writeback`), no live DB or chain. Still ZERO callers:
nothing in `src/index.ts` supplies a real `fetchPending`/`writeback` or invokes this on a timer —
that step spends real gas from the funded attester wallet on an unattended trigger nobody has
approved, which stays a Sean-gated infra/spend decision per this loop's hard lines, not something
to land via `--auto --squash`. Item 10 moves from PARTIAL (primitive only) to PARTIAL (primitive +
tested orchestration, still uncalled) — closer, not done.** |
| 11 | **Proof-tier selection in ANFIS** — proof strength as a first-class policy output | #2 | — | CC | policy picks inclusion vs current-validity vs walk by stakes/cost | **PARTIAL — shadow wired into scoring pipeline, enforce is a deliberate wiring change [MEASURED 2026-10-01, beat sixth run].** Primitive `selectProofTier(axes)` (`src/services/proof-tier-policy.ts`, PR #225) done. **Shadow wired into `src/scoring/pipeline.ts`** via `src/scoring/proof-tier-shadow.ts` (PR #772): `shadowProofTier(eventType, agentTier)` called fire-and-forget at `pipeline.ts:770`, inert unless `PROOF_TIER_SHADOW_ENABLED=true`. Axes mapped from scoring-event context (stakes by event type + VETERAN/AUTONOMOUS tier bonus). The "zero callers / wired one end only" framing from beat 82 was stale when last read — PR #772 landed before this correction. Enforcement (switching from shadow-log to gate that fails a non-conforming score) requires a deliberate code change and is NOT an env flip; that decision stays open and is Sean-gated by design (the file header documents this explicitly). Acceptance test ("policy picks inclusion vs current-validity vs walk") partially met at the shadow-log level; the gate-that-enforces half requires the deliberate wiring change. |
| 12 | **GraphRAG-native leaves** — entity/relation/episode/skill schemas on leaves; authenticated subgraph walk (chain of inclusions + edge hashes) | #3 | P4 | CC | a multi-hop walk verifies hop-by-hop against the root | **DONE — leaf schemas PR #780 (18/18 tests); walk verifier `verifyAuthenticatedWalk` PR #785 (8/8 tests); HTTP endpoint `POST /api/v1/memory/verify-walk` PR #788 (7/7 tests, mounted `src/index.ts:76`). Acceptance test met: multi-hop walk verifies hop-by-hop against the root, exposed over HTTP under the DB-issued agent key contract. Verified by beat 2026-09-19 fourth run, reading route mounting + running tests.** |
| 13 | **Hierarchical durable memory** — heat-based promotion/eviction, dormancy/night consolidation, tiered storage (hot/warm/cold/on-chain) | #3 | — | GA | low-heat leaves flushed to cold; root preserved; reactivation triggers | **DONE at primitive + HTTP level [MEASURED 2026-10-01, beat sixth run, verified by fourth/fifth runs]. All acceptance criteria primitives on main: `performHeatEviction` (PR #817, 8/8 tests, tombstones cold-tier leaves); `evictAndUpdateRoot` (PR #821, 7/7 tests, eviction + Merkle root recomputation + storage); `reactivateLeaves` (PR #1012, 9/9 tests, cold→warm promotion); `POST /api/v1/memory/evict` HTTP route (PR #1022, mounted `src/index.ts:85,665`) — all gated behind `HEAT_EVICTION_ENABLED` (default off). Enabling in prod is Sean GO. Night/dormancy consolidation is not explicitly wired but the off-peak batching primitive (`isOffPeakHour`/`selectOffPeakBatch`) exists in `memory-root-anchor.ts:117-130` and is used by `runMemoryRootAnchorSweep`. Previous row text "eviction side not yet built" was stale — PRs #817/#821 both merged 2026-09-21.** |
| 14 | **P4 Plonky3 non-membership AIR** — batch inclusion+non-membership → one STARK (reuse Poseidon2 Merkle AIR) | #1/#2 | P4 | CC | AIR proof verifies; wrong witness fails | **DONE — `src/zkp/merkle-air.ts` (PR #1237, beat 2026-10-07). AIR columns: `current_in`/`sibling`/`sibling_left`/`current_out`. Constraints R0 (hash correctness), R1 (direction-bit binary), B0/B1 (boundary), C0 (continuity), plus ordering + tombstone checks for non-membership. 24/24 tests (24 after Strix fix, beat 2026-10-07 second run) under real Poseidon2-BabyBear. Strix flagged a soundness bug (HIGH) — ordering fields were not bound to the committed `leaf_digest`, allowing forged non-membership proofs; fixed in beat 2026-10-07 second run by re-deriving the digest from prover-supplied fields and requiring a match before trusting them. Strix re-review triggered. Patent #1/#2 reduction-to-practice. The Rust zkp-vault prover consumes these traces when its HTTP wrapper ships.** |
| 15 | **WHIR aggregation PCS** (+ frontier Merkle pruning, PR #1919) for the aggregation tier | #2 | P4 | CC | recursive proof size ↓ vs FRI baseline (measure) | LATER (verify PR#1919 numbers first) |
| 16 | **P5 ZK inclusion/property proofs** for sensitive/health data (domain-scoped nullifiers) | #1/#3 | P5 | CC | property proven w/o revealing content; PHI off Trinity prod | LATER (health vertical) |
| 17 | **Verifiable ranking** — VeriRAG sort-bypass / V3DB multiset / zkRAG PQ-checkers | #3 | P4+ | CC | top-k correctness proof; ANFIS-gated, offline/high-stakes only | GATED (needs committed vector index) |
| 18 | **KoalaBear A/B** vs BabyBear on the LeanIMT+/non-membership AIRs | — | — | CC+XC | measured prover-time/AIR-width delta; Invariant-1/5 + Sean GO to switch | GATED |
| 19 | **ANFIS COMPUTE-PLACEMENT axis (resource-aware routing)** — autodetect resource pressure (RAM/CPU/queue depth/free-tier quota) → route heavy jobs (build/test, tsc, jest, ZK proving, HAL verification) to the cheapest CAPABLE compute (local → GitHub Actions/Codespaces → cheap VPS/spot → proving service), the SAME pattern as the LLM cost/capability router. Sean's idea 2026-07-27. | #2 | — | GA/CC | policy picks placement by measured cost/capability/availability; measured $ + wall-clock vs always-local | LATER (PRODUCT fabric only). ⚠ NOT a dev-machine fix — CI/Codespaces already solve the laptop today (RULE-10 arbitrage-first); do not build a bespoke router to fix local dev. |
| 20 | **Commitment well-formedness** — what a peer can check about a committed list it did NOT build. A stateless verifier binds a leaf's contents and its position (path), but **not** the global sorted-linked-list invariant: a forging committer can publish a sentinel whose `next` skips over live values, and no single non-membership witness detects it. Indexed Merkle trees normally close this by constraining INSERTION in-circuit; this reference has no such constraint. Opened by Beat 50 (repid-engine #247), which closed the *reachable* half — a value-0 leaf planted at a non-zero index proved a LIVE value absent because the guard read the witness's unauthenticated `index`. | #1 | P1/P4 | CC+XC | either (a) an insertion AIR that makes a well-formed root the only provable one, or (b) a written, tested statement of the residual trust assumption that the non-membership claim carries | **DONE (option b) — `auditCommitment()` in `src/memory/leanimt-plus.ts:296` (PR #250, merged 2026-07-28), file header states the two soundness scopes explicitly, called and fail-closed on `commitment-audit-failed` from `src/memory/memory-publication.ts:156`. Verified by Beat 66, 2026-08-27, by reading the call site, not the table. (a) — the in-circuit insertion AIR — remains open if a stronger guarantee than "sound relative to a published, audited list" is ever needed.** |

## Verify-before-depend (post-cutoff claims to confirm when each item activates)
WHIR PR #1919 −13/−22% numbers · MoE routing papers (MoSE/AdaMoE/MoE++/RouteMoA) · PAGE-RAG · zkRAG/VeriRAG/V3DB benchmark seconds. (LeanIMT+, zkRAG, WHIR, V3DB, VeriRAG existence already verified 2026-07-26.)

## Enabling-disclosure note (helps patent grant)
For #1 and #2, document as we build: exact leaf schema (`encodeLeaf`), the low-leaf non-membership + revocation algorithm (leanimt-plus.ts), the answer→proof binding, and the ANFIS feature vector + decision logic — each with **measured cost/reliability numbers** (hallucination drop, RepID delta grounded vs ungrounded, amortized gas/epoch, ANFIS regret vs shadow). Working+tested code = reduction to practice.
