# HyperDAG Sprint Backlog — Dependency-Ordered
**Generated:** 2026-07-25 (corpus scout) · **Source:** HYPERDAG_VISION_AND_BUILD_ORDER_2026-07-24 + CONTINUOUS_SWARM_LOOP_SPEC_2026-07-24 + STATE_OF_THE_SYSTEM + repid-engine code.
**Used by:** the autonomous build-loop (`AUTONOMOUS_LOOP_CONTRACT.md`). Pick the dependency-earliest OPEN free-tier task each beat.

---

## ⚠ RECONCILIATION — verified live 2026-07-25 (correct the backlog's stale assumptions BEFORE acting)
The scout worked partly from stale docs. Verified corrections (`[V]` = live-checked this session):
- **`trinity_tasks` pending = 0** `[V]` — the "33k pending" in tasks 1.0 & the critical path is **DRAINED**. Task 1.0 (triage 33k) is **largely MOOT**; the real problem is the queue is *empty* (starved), not overfull.
- **HAL purpose-gate is LIVE and discriminating** `[V]` — operational-tagged vetoes → delta 0, deliverable → −10. Task references to "purpose-gate fix pending" are DONE.
- **x402 settlement + ERC-8004 writes restored 2026-07-22** `[V per state]` — Layer 5 "x402 continuous" is largely DONE (writes now stale ~2d only because throughput is idle, not because it's broken).
- **RLS 579/579 tables** `[V per state]` — any "enable RLS" item is DONE.
- **hyperdag.org/more glossary shipped (hyperdag-landing #4, ~21 terms)** `[V per state 07-23]` — task 6.0 is **mostly DONE**; verify coverage vs the scout's 23-term list before re-drafting (don't redo).
- **No-self-validation (PR #185/#186 on trinity-task-bridge)** — status to confirm against git before treating 5.0 as merged.
- **peer_verification_queue enqueue STALLED ~4 days** (0 new rows since 2026-07-21; 135k dormant rows) `[V]` — a real regression to investigate; NOT in the scout's list.
- **Each OPEN task must be re-confirmed against live state/git before dispatch** (verify-before-build). A per-task DONE/OPEN reconciliation pass is dispatched as Beat 1.

**Net:** the loop's near-term free work = restart *real throughput* through the proven pipeline + build the anti-fragile safety floor (breakers/kill-switch) BEFORE ramping producers. The broker keystone is the linchpin but gates on Sean's Precondition Zero.

---

## Backlog table (30 tasks)

| # | Task | Unblocks / dependency | Fleet tier | Acceptance test | Cost |
|---|---|---|---|---|---|
| **L0 — PRECONDITION ZERO** | | | | | |
| 0.1 | Rotate leaked secrets (Supabase service_role/secret/DB pw; provider keys GROQ/OpenRouter/Cohere/Perplexity/DeepSeek); re-key x402 CAIP-2. | all safety | Claude (decisions) | Old keys 401/403; new 200; service_role ≥5h newer. | **SEAN-GATE** |
| 0.2 | Capability removal: strip secret-read tools; 24h-TTL task-scoped job tokens issued at claim, revoked at complete. | all autonomy | GA + Claude | Grep agents: 0 direct `process.env.*KEY`; job-token RPC returns 24h token; old env var → 401. | **SEAN-GATE** |
| 0.3 | Credential isolation: sandbox Railway project separate from prod; zero prod god-keys in sandbox. | all autonomy | Claude | Sandbox vars: 0 keys w/ prod/DEPLOYER/WALLET; test branch /health=200 w/o prod creds. | **SEAN-GATE** |
| 0.4 | **Kill switch** — `emergency_halt` bool in `trinity_system_config`, checked every tick; true → workers PARK, enqueue 503, admin off. Rollback = flip false. | all autonomy gates | T12/Claude | Set true → /tick returns immediately; POST /create → 429; false → resume. | free |
| **L1 — SWARM HEALTH** | | | | | |
| 1.0 | ~~Triage 33k pending~~ **MOOT (pending=0)**; instead: root-cause why peer_verify enqueue stalled 2026-07-21. | honest scoring | XC (SQL) | Time-series of peer_verification_queue.created_at shows gap cause; fix identified. | free |
| 1.1 | Drain 13 HITL `hitl_pending` >24h: auto-expire >72h + Sean approves/rejects a few via /hitl. | honest scoring | Claude + Sean | `COUNT pending >24h` = 0; ≥1 manually resolved. | free |
| 1.2 | Restart proof-drain worker (reported down since 06-07); batch un-anchored `repid_zkp_proofs` → EAS. **Verify actually-down first.** | ZKP anchoring | Claude | un-anchored count decreases T→T+1h; deployed commit ≤1wk. | free |
| 1.3 | Remove 4 orphaned Supabase keys from repid-engine Railway env (SERVICE_ROLE/ANON/NEXT_PUBLIC/NEXT_SUPABASE). Grep 0 refs first. | hygiene | Claude | Railway env: 0 of those 4; grep src/dist 0; /health=200. | free |
| **L2 — BREAKERS (anti-fragile floor — build BEFORE ramping producers)** | | | | | |
| 2.0 | Enqueue birth-rate control: ceiling per task_class+source; pending/completed >2.0 over 15m → halt producers (drain-only). | producer safety | GA | Inject 100 tasks; ratio>2 → POST/create 429; queue drains; logged. | free |
| 2.1 | Producer kill-switch `producer_halt_class` set; task_class in set → skip enqueue; workers still drain. | drain-only | GA | Add "verify" → spawn verify 0 rows; SQL-queued verify still drains. | free |
| 2.2 | Lineage + depth budget: `lineage_id` + `depth`; enqueue validates depth<5; spawners pass lineage_id=self. | fork-bomb prevention | GA | 5-deep succeeds; depth 6 → 400; MAX(depth)≤5. | free |
| 2.3 | Self-referential work ban: tasks targeting system artifacts (HAL/verify/queue) → shadow queue, ceiling 10, allowlist. | anti-thrash | GA | shadow count ≤10; "verify HAL" → shadow. | free |
| 2.4 | Content-hash dedupe at enqueue: identical {class,params} pending <1h → coalesce to existing id. | efficiency | T12 | Double POST identical → same id; COUNT hash=X = 1. | free |
| 2.5 | Cost/side-effect budgets HARD breaker: $1 LLM/hr, 100k writes/hr, 10 concurrent fanout → PARK+FREEZE+auto-halt. | explosion protection | Claude | Simulate $2/hr → PARK; log COST_CEILING_BREACHED; manual recover. | free |
| **L3 — TRUSTKEYS BROKER KEYSTONE (the linchpin)** | | | | | |
| 3.0 | Build broker: POST /broker/complete {provider,model,prompt,job_token} → injects key server-side → {completion,tokens,cost}, no secrets. Keys in broker env only. | ANFIS real | Claude | valid token 200; no token 401; grep logs 0 key strings. | free (code) + **SEAN-GATE** (prod) |
| 3.1 | Wire ENGINE_LLM_PROXY: 12 agents call /engine/llm-proxy not direct providers. | ANFIS real | GA | grep 0 direct provider calls; trace agent→proxy→broker; ANFIS logs outcomes. | free |
| 3.2 | Broker security audit: no key leak in logs/errors/cache/metrics. | prod gate | Claude | grep 0 credential patterns; malformed error sanitized; sign-off. | free |
| **L4 — ZKP DURABILITY** | | | | | |
| 4.0 | Complete Poseidon2 leaf (~70% on feat/cc-2026-06-08-poseidon2-leaf); TS↔Rust parity KATs (0x32ed1341, 0x669d7ab7). | durable ZKP | Claude | jest poseidon2 pass; cargo test commitment pass; 0 bits differ. | free |
| 4.1 | Prove leaf+aggregation E2E: Groth16+Poseidon2 leaf → Plonky3 STARK aggregate → verify; testnet. | attestation | Claude | zkp-e2e test passes; rows in repid_zkp_proofs w/ eas_uid; verify on BaseScan; <10s. | free |
| 4.2 | Migrate POSTCARD leaf sha256→Poseidon2 (dual-write parity, don't flip primary). | migration | GA | hash_type col; both rows; both verify. | free |
| 4.3 | Cutover gate: shadow → red-team 100 proofs → flag POSEIDON2_PRIMARY_HASH; old sha256 still valid. | formalization | XC + Claude | readiness report; post-flag 10 = poseidon2; historic verify. | free |
| **L5 — E2E DOGFOOD** | | | | | |
| 5.0 | Enable peer-verify loop (no self-validation; #185): flag PEER_VERIFY_REPID_ENABLED; disputed peer-verify costs RepID. **Confirm #185/#186 merged first.** | credibility | GA | flag deployed; low-conf HAL → peer_verify rows; verified_by_peer true; deltas flow. | free |
| 5.1 | Synthetic dogfood corpus (10 contracts, 0.01 USDC): create→12 agents claim→HAL→peer-verify→scores→ERC-8004 write. Breakers live. | prod confidence | GA + Claude | scripts/demo/run-dogfood-corpus.ts; 12 claim; ≥5 HAL complete; ≥5 Base Sepolia txs; $0. | free (testnet) |
| 5.2 | E2E single-contract trace, zero NULLs, <1 min. | measurement | Claude | grep all stages; chain contracts→...→BaseScan tx. | free |
| **L6 — CONTENT / VISION** | | | | | |
| 6.0 | hyperdag.org/more glossary — **MOSTLY DONE (#4)**; verify 23-term coverage + first-appearance links, fill gaps only. | coherence | T12 | more/index.html ≥20 anchors; ≥5 first-appearance links; 0 404s. | free |
| 6.1 | TrustShell Stake tab: explanation + 2 paths (Create RepID via email-OTP; Import wallet). | participation | GA | /stake 2 CTAs; flow A → commitment_hash; flow B linked. | free |
| 6.2 | TrustShell footer → github.com/DealAppSeo/trust-commons/discussions (enable + 1 pinned). | community | T12 | footer link live; Discussions on; ≥1 pinned. | free |
| 6.3 | AISocialMirror audit + bilateral rating loop (users rate AI → agent RepID; agent rated → user RepID). | bilateral surface | GA | site 200; POST /api/rating 200; both deltas on 1 cycle. | free |
| **L7 — HEARTBEAT / MEASUREMENT** | | | | | |
| 7.0 | UptimeRobot /tick endpoint (idempotent): {tasks_claimed,drained,cost_hr,halt}. | heartbeat | GA | 5 calls/1s → 1 claim/task; UptimeRobot up; tick logs q5min. | free |
| 7.1 | pg_cron heartbeat + dead-man's switch → Telegram if stale >5m. | liveness | Claude | trinity_heartbeat updates q1m; disable → alert; resume → ok. | free |
| 7.2 | Railway cron batch (proof-fold, archive, cleanup) hourly, skip-if-running. | background | GA | cron logs start→folded N→complete hourly. | free |
| 7.3 | Telegram alerting (cost >$0.50/hr, idle 0 claims/hr, halt, rate-limit). | reactive ops | GA | thresholds → Telegram <30s; 2 examples. | free |
| **L8 — CRAG GATES** | | | | | |
| 8.0 | Stage-0 CRAG heuristics (BM25/dense agreement/source floors) <100ms before durable write; ambiguous → HAL grader. | gate | GA | crag-stage0.ts + tests pass; <100ms; FP<1% FN<10%. | free |

---

## Critical path (shortest chain to a peer-review-defensible foundation)
1. **Precondition Zero** (0.1 + 0.3) — rotate leaked keys + sandbox isolation. **SEAN-GATED.** Blocks full autonomy.
2. **Breakers** (2.0–2.2) — birth-rate + producer kill-switch + lineage/depth. Free (GA). Anti-fragile floor.
3. **Broker keystone** (3.0–3.2) — TrustKeys broker + ENGINE_LLM_PROXY + audit. Free code / Sean-gated prod. **Linchpin** (makes ANFIS real, kills key exposure).
4. **ZKP durability** (4.0–4.1) — Poseidon2 leaf parity + leaf→aggregation E2E. Free (Claude apex).
5. **E2E dogfood** (5.1–5.2) — 10-contract corpus through the full pipeline on testnet. Free.

**Parallel free tracks (don't block critical path):** L6 content, L7 heartbeat, L8 CRAG — free-tier, run alongside.
