# P0 "Contain" — reputation writer map

Trust Harness gate P0, lane CC1-A. Read-only map of every code path that changes reputation in
`repid-engine`, `trinity-symphony-shared` and `trustrails-dev`, read from code at:

| repo | origin/main |
|---|---|
| repid-engine | `584d165f` |
| trinity-symphony-shared | `06b7eb5c` |
| trustrails-dev | `d852ce5` |

Line numbers are **origin/main** (before this PR). Nothing here was read from production.
**Every production flag value is NOT_CHECKED** (Sean reads those himself). Where the code cannot
answer a question the cell says UNKNOWN.

Legend:
- **Auth** — where the route is mounted relative to the global `app.use(authMiddleware)` (`src/index.ts:710`), and what checks the caller.
- **Bound?** — is the agent whose score moves bound to the authenticated key, or can the caller name it.
- **Outcome** — where the "this went well / badly" signal comes from. *Self* = asserted by the actor or the caller; *independent* = a party other than the actor.
- **Both apply?** — can the app AND the DB trigger `apply_repid_score_event` apply the same delta.

## 0. The DB applier every writer interacts with

`trg_apply_repid_score_event` — BEFORE INSERT on `repid_score_events`, function
`apply_repid_score_event()`. **Its CREATE is not in this repo** (no `*.sql` in `supabase/migrations`,
`migrations`, `scripts`). The body is known only from transcriptions: `src/routes/score-event-guard.ts:6-15`
and `tests/scoring2-zero-delta.test.ts:42-80`. As transcribed:

```
IF NEW.repid_delta_applied IS NOT NULL THEN RETURN NEW; END IF;          -- caller already applied
v_delta := COALESCE(NEW.repid_delta_calculated, NEW.delta, 0);
IF v_delta = 0 THEN RETURN NEW; END IF;                                   -- zero: no-op
SELECT current_repid ... FOR UPDATE; UPDATE repid_agents SET current_repid = before + v_delta;
NEW.repid_before := before; NEW.repid_after := after; (+ agent_repid_history row)
```

So, per writer:
- **sets `repid_delta_applied`** → trigger stands down; one applier.
- **inserts first, then writes `current_repid` absolutely** → trigger adds, then the app overwrites with its own absolute value. Two appliers, **last write wins, not additive** (a concurrent event between the two writes is lost).
- **writes `current_repid` first, then inserts with no applied value** → trigger adds the delta a **second time** on top. **Double-apply.** Measured in a rolled-back prod transaction, per `score-event-guard.ts:24-27`: 699 → 706 → 713.
- **inserts delta 0 and no `repid_delta_calculated`** → trigger no-op; one applier (or none).

The guard flag that makes writers set `repid_delta_applied` is `SCORE_EVENT_GUARD_MODE`, code default `off`
(`score-event-guard.ts:52-55`). Other related flags and their code defaults:
- `WRITER_DIRECT_APPLY` defaults to `true` (`!== 'false'`), so the app also applies.
- `ENGINE_LEDGER_RECONCILE_MODE` defaults to `off`; in `enforce` it sets `repid_delta_applied` in `updateRepId`.

## A. repid-engine — HTTP routes

| path | file:line | auth | flag (code default) | delta formula | bound? | outcome | both apply? |
|---|---|---|---|---|---|---|---|
| **POST /score** → `updateRepId(req.body)` | `src/routes/score.ts:15-51` (mounted `app.use(scoreRouter)` `src/index.ts:973`) | **after** authMiddleware; any `REPID_API_KEYS` key or DB key | — | per `eventType` from the body (see B1) | partly. A bound key must equal `body.agentId` (`score.ts:32-41`); a **non-bound env key scores any agent** | self (body) | see B1 |
| ↳ **PREDICTION_RESOLVE** (P0 target) | `src/engine/repid-update.ts:569-575` → `src/layers/prediction-scoring.ts:14-25` | as above | none | `round(scorePrediction)`: on a correct call (`pCorrect>=0.5`) `log(1/pStated)`, so **stating 1% pays most**; on a miss `-log(1/(1-pStated))`, floored at `-φ³`; × importance × time weight × tuned base | as above | **self**: `pStated` and `pCorrect` both from the body | trigger adds `delta`, then app overwrites absolutely (`:748` then `:894`): last write wins |
| **POST /api/v1/agents/:id/score-event** (P0 target) | `src/routes/agents-external.ts:464-990`; `baseDelta = round(certainty*10)` `:621` | **after** authMiddleware (mounted `src/index.ts:801`), plus `requireApiKey(['score_event'])` | `REPID_RUN_EARN_GATE` (default **shadow**: `=== 'true'` enforces, `:680`); `HAL_FACTCHECK_SCORE_EVENTS` (default on) | approved: `calculateFullReward(baseDelta, …)`, capped and clamped; not approved: `-abs(round(certainty*10))`. **`outcome` is never read** (stored as `decision_outcome`) | **yes** (`req.agent_id === :id`, `:466`) | **self**: `certainty` and `outcome` from the actor's own key | guard off: trigger adds `delta`, then app overwrites absolutely (`:879-890`). Guard enforce: `repid_delta_applied` set, single applier. Vesting case: see the comment at `:786-800` |
| POST /api/v1/agents-external/:id/score-event → `runScoreEvent` | `src/routes/agents-external-score.ts:84` | **before** authMiddleware (`src/index.ts:623`); own `requireApiKey(['score_event'])` plus ownership, unless `SCORE_EVENT_PUBLIC_ALPHA=true` (default secure) | as B2 | HAL `computeDelta` (B2) | yes (unless alpha) | HAL quorum over the submitted answer | no (applied set) |
| POST /bounties/:id/verify → `updateRepId(AUDIT_CONTRIBUTION)` | `src/routes/bounties.ts:165,215` | **before** authMiddleware (`index.ts:579`); own `authorizeBountyVerification` (credential-derived verifier) | `SELF_REPORT_EVIDENCE_MODE` (AUDIT_CONTRIBUTION is enforce-exempt) | `FIXED_DELTAS.AUDIT_CONTRIBUTION` | claimant from the bounty row | verifier ≠ claimant (service checks) | as B1 |
| substance-gate events → `slashRepIDForGateFail` | `src/routes/v1/substance-gate.ts` → `src/services/substance-gate-writer.ts:117,261,288` | after authMiddleware (v1 router `index.ts:754`) | guard off → legacy branch | `reapCount>3 ? -150 : -50` | name from the request | client-computed gate result | legacy branch: trigger adds, then the app writes; not additive |
| POST /bet/resolve, /trader/round/*, /demo/run-round-anonymous → `resolveBet` → RPC `apply_linked_bet_resolution` | `src/routes/v1.ts:676` (resolveBet `:681`), `:688`, `:697`, `:817` → `src/services/linked-bet-resolver.ts:288` | after authMiddleware; `ORACLE_HMAC_SECRET` required; demo needs an operator key and a daily cap | — | `±floor(claimed_confidence/10000*100)` (`linked-bet-resolver.ts:241-255`) | no (agent from the `linked_bets` row) | HMAC "oracle"; the demo uses a mock oracle | **YES, double-apply.** The SQL does `UPDATE repid_agents` and then `INSERT repid_score_events` with no applied value (`supabase/migrations/20260427_add_linked_bets.sql:114-125`). Its `GREATEST(0, …)` also conflicts with the ≥10 floor |
| POST /api/v1/agents/:id/reputation/write (force on-chain) | `src/routes/agents-reputation.ts:52` | after authMiddleware (`index.ts:814`); any API key | breaker `cb_disable_onchain_writes` | on-chain snapshot of `current_repid` | **no**: `:id` from the path | snapshot | n/a (on-chain only) |
| arena red-team route → `src/testing/red-team.ts:385-428` | `src/routes/v1.ts:934` | after authMiddleware | guard off | `round(before + delta)`, floor 0 | name | harness | update, then insert. The insert fails (`agent_name` column) → applied once with no event row |

## B. repid-engine — non-route writers

| path | file:line | reached by | flag (code default) | delta formula | bound? | outcome | both apply? |
|---|---|---|---|---|---|---|---|
| **B1 `updateRepId`** | `src/engine/repid-update.ts:405`; insert `:748`; update `:893-899` | /score, bounties, `failed-receipt-settler.ts:222` (`CONFIRMED_FAILED_SETTLE_MODE`, default off), `deception-emitter.ts:258` (`TRUST_DECEPTION_MODE`, default unset = no-op) | `CONFIRMED_OUTCOME_SCORING_ENABLED` (off); `SELF_REPORT_EVIDENCE_MODE`; `TRUST_DECEPTION_MODE` (shadow); `GROUNDING_MODE`; `WRITER_DIRECT_APPLY` (on); `DOGFOOD_REPID_FROM_COSIGN` (off) | `FIXED_DELTAS` / challenge scorer / prediction scorer / gated deception. Then redemption, decay, clamp [10,10000] | whatever the caller passes (see the routes) | per event type | insert (trigger applies), then an absolute overwrite: last write wins, not additive |
| **B2 `runScoreEvent`** | `src/scoring/pipeline.ts:276`; insert `:678`; update `:765-772` | `trinity-task-bridge.ts:222` (`ENGINE_WORKERS_ENABLED` and `TRINITY_BRIDGE_ENABLED`, both default **on**); `service-quality-hook.ts:268` (`SERVICE_QUALITY_HOOK_MODE`, default off); routes A | `REPID_PURPOSE_GATE_ENABLED` (on); `HAL_DIRECT_PENALTY_REQUIRES_HALLUCINATION` (on) | HAL `computeDelta`: vetoed −10; clean `1+(0.5−risk)·4`; flagged/abstain 0; plus decay | no; the bridge takes the name from `trinity_tasks` fields | HAL over output the agent submitted itself | no (applied set) |
| B3 `applyValidationEvent` | `src/scoring/pipeline.ts:873`; update `:1016-1023` | validation, dispute, cascade and x402-release workers; peer panel (`peer-verify-consensus.ts:498`). All default **off** | per worker | `SERVICE_FULFILLED_DELTAS` / satisfaction / rater-weighted / `DISPUTE_DELTAS`; 0 when simulated | contract parties | PCP judge / buyer rating / dispute verdict | no (applied set) |
| B4 `recordOutcome` | `src/services/repid-earning.ts:139`; update `:209` | scripts only (`scripts/repid-earning-backfill.ts`) | `WRITER_DIRECT_APPLY` | `scoreTrade` ladder | `trade_execution_log.agent_name` | paper-trade P&L | no (applied set) |
| B5 peer-verify score | `src/services/peer-verify-score.ts:120` | peer verify | — | — | — | — | trigger is the only applier. The file header says inserts currently fail |
| B6 confession | `src/services/repid-confession.ts:293` | — | — | — | — | — | `applier: 'trigger'`, single applier |
| B7 red-team adjudication | `src/testing/redteam-adjudication.ts:64,87` | `scripts/redteam/synthetic-round.ts` | guard off | `REDTEAM_REWARDS` | name | synthetic | **YES, double-apply** (update, then insert with no applied value) |
| B8 T12 e2e proof | `src/testing/t12-e2e-proof.ts:55,76` | `scripts/t12/run-e2e-proof.ts` | guard off | default +3 | name | harness | **YES, double-apply** |
| B9 repid-sync aggregator | `src/services/reputation/repid-sync-aggregator.ts:224,255-257,151-159` | CLI only; worker has 0 callers and never passes `apply` | needs `REPIDSYNC_DRY_RUN=false` **and** `REPIDSYNC_APPLY=true` **and** `--apply` | `current + Σ delta` since the watermark | n/a | ledger | **YES** if run while `WRITER_DIRECT_APPLY=true` (re-adds applied deltas) |
| B10 decay script | `scripts/run-repid-decay.ts:84` | manual | `--apply` / `REPID_DECAY_APPLY=true` | idle-week decay | n/a | inactivity | no (compare-and-set, no event row) |
| B11 recompute | `scripts/repid-recompute.mjs:300` | manual | `--apply` | ledger reconcile | n/a | ledger | no (compare-and-set) |
| B12 seed migration | `supabase/migrations/20260427_seed_two_builder_demo.sql:80-103` | one-shot | — | absolute set, then insert `delta = new − old` | n/a | hard-coded | YES if the trigger existed at apply time (UNKNOWN) |

## C. Other DB triggers / functions

| trigger / fn | where | effect on reputation |
|---|---|---|
| `trg_hal_penalty_guard` (BEFORE INSERT `repid_score_events`) | body not in repo; rename staged at `migrations/2026-08-03-hal-penalty-guard-trigger-order.sql:103-104` ("NOT APPLIED") | zeroes a negative HAL delta with no `hallucination_caught`. Sorts after the apply trigger by name, so today it edits the row only, not `repid_agents` |
| `trg_sync_tier` → `sync_tier()` → `compute_tier(int, uuid)` | fn `supabase/migrations/20260523140000_repid_inflation_counterparty_gate.sql:33-88`; prod trigger CREATE not in repo | tier only (counterparty gate); never the score |
| `trg_repid_earned_floor` (on `repid_agents`) | not in repo (`src/services/floor-policy.ts:8-12`) | raises `current_repid` to the tier floor of the peak; absorbs deltas without the ledger showing it |
| `apply_vertical_accuracy` (AFTER INSERT) | not in repo (`src/services/validation-repid-delta.ts:430-436`) | `domain_accuracy` only |
| `repid_score_events_peer_verify_trigger` | `supabase/migrations/20260526000000_peer_verification_queue.sql:30-67` | queues peer verification when `certainty_at_claim < 0.85`; no score change |

## D. ERC-8004 `giveFeedback` writers (on-chain)

None of these sends a per-event outcome. Each sends a snapshot of DB `current_repid`, signed by a house key, for an
`agentId` the server picks. **None binds `agentId` to an authenticated caller.** All of them check the breaker
`cb_disable_onchain_writes`, which fails closed on a missing config row (`src/middleware/circuit-breaker.ts:71-82`).

| writer | file:line | reached by | flag (code default) | value | bound? |
|---|---|---|---|---|---|
| `Erc8004ReputationWriter.writeRepIDFeedback` (chokepoint) | `src/services/erc8004-reputation.ts:100` (giveFeedback `:146-155`) | everything below except the poster | key env present; non-Sepolia refused unless `ALLOW_MAINNET_REPUTATION_WRITES=true`; value integer in [10,10000]; writer allowlist (`writerAllowlistFromEnv` in `src/services/erc8004-writer-allowlist.ts`; empty = allow all) | `current_repid` snapshot | house key; token id from the caller |
| `postReputationSignal` | `src/services/erc8004-poster.ts:32` (giveFeedback `:74-83`) | only `scripts/demo-receipt-flow.ts:194` | breaker only. **No allowlist, no mainnet guard, no range check** | `round(score·10^decimals)`; the demo hard-codes `hal_score 0.95` | a house agent key is used as the operator key; token hard-coded |
| FeedbackLoopWorker | `src/workers/feedback-loop-worker.ts:271` (started `src/index.ts:1274`) | 60 s interval | `ENGINE_WORKERS_ENABLED` (default **on**); tier floor 1000 | snapshot | subject from server-written `repid_events` rows |
| `maybeWriteOnChainReputation` | `src/services/onchain-reputation-trigger.ts:192` | service-fulfilled path (`validation-repid-delta.ts:525`) | `ONCHAIN_REPUTATION_TRIGGER_ENABLED` (default off) | snapshot | contract provider |
| `writeRepIDCanonical` | `src/services/erc8004-canonical-writer.ts:81` | `/demo/run-round-anonymous` | operator key + daily cap | post-round snapshot of a **simulated** round (mock oracle); no `is_simulated` gate | hard-coded agent names |
| force-write route | `src/routes/agents-reputation.ts:52` | any API key | breaker | snapshot | `:id` from the path |
| backfill / first-write scripts | `scripts/erc8004-reputation-backfill-spokespersons.ts:219`, `scripts/erc8004/produce-first-onchain-write.ts:177` | manual | `--dry-run` opt-in / `--execute` opt-in | snapshot | CLI args |
| `scripts/t12-chess-log.mjs` | **does not exist** on origin/main or in any branch history (`git log --all`) | — | — | — | — |

## E. trinity-symphony-shared

| path | file:line | reached by | flag (code default) | delta formula | bound? | outcome | both apply? |
|---|---|---|---|---|---|---|---|
| **`ConstitutionalAgentV4.updateReputation`** (P0 target) | `lib/ConstitutionalAgentV4.js:3013-3057` | every task claimed via `CLAIM_SQL` (`getNextTask` `:2161`). Callers: `:1514` pulse check `(true)`; `:1927` contract success `(true)`; `:2486` legacy `(evaluation.score > 60)` (the default loop); `:2972` peer slash `(false, parentTask.claimed_by, -5)`; `:2100/:2115` (dead code) | **none** | `delta = override ?? (success ? 1 : −5)`. **On success**: `φ·max(1, s+delta)^(1/φ)`. That is contractive: 50 → 18.38 after one success, and repeated successes converge near 4.8. On failure: linear. Clamp [0,100], tier from the score | the row is `targetAgent \|\| this.name`; a null `claimed_by` slashes the reviewer itself | **self**: `evaluateResult` (`:2814-2827`), i.e. `min(40,len/500·40) + ('#' ? 30:10) + ('Virtue' ? 29:10)` over the agent's own text | n/a (no trigger on `trinity_agent_registry` known). Select-then-update is not atomic. The heartbeat writes `wisdom.tier` back to `current_tier` (`:656-664`) |
| `w3c.index.js` `updateRepID` → `agent_repid` upsert | `w3c.index.js:126-138` | `completeTask:279` (+10/task) | none | +10 / +5 linear | self | self (template echo) | — . Not deployed (referenced by no deploy config, per `lib/emergency-halt.js:56`) |
| `log_repid_event` RPC +0.04 | `constitutional-agent-base.js:1641-1649` | `trinity-worker.js` | none | +0.04 (RPC body not in repo: UNKNOWN) | UNKNOWN | self | UNKNOWN. Probably unreachable: `trinity-worker.js:28` requires an untracked file |
| `conductor.py` `log_repid_event` | `conductor/conductor.py:432-442, 464-470` | `_complete_task` / `_fail_task` | none | +0.02…+0.04 / −0.05 (RPC body UNKNOWN) | `p_subject_id = self.agent_name` | self | UNKNOWN. Live deploy UNKNOWN |
| engine-side (indirect) | `_postPeerVerdict` `:2750-2812`; `lib/substance-gate-client.js` (`shadow_mode: true`); `lib/service-contract-client.js:16-50` | HTTP to repid-engine | needs `REPID_API_URL`/`KEY` | the engine decides (see A/B) | bearer key | LLM verdict / client gate | see A |

## F. trustrails-dev

The repo has no auth middleware, and no API route reads an auth header, session or key. No env flag gates any writer.

| path | file:line | reached by | delta / fields | bound? | outcome | insert checked? |
|---|---|---|---|---|---|---|
| `/api/vouch` → `repid_scores` | `app/api/vouch/route.ts:15-22` | unauthenticated POST, **anon** client | target +20 (time_locked) / +15; sponsor +5/+2; read-then-write; no clamp | no. The sponsor is hard-coded and `target` comes from the body | self (`txHash` random) | no |
| `/api/remove-vouch` → `repid_scores` | `app/api/remove-vouch/route.ts:37-45` | unauthenticated POST, anon client | sponsor −1; target `max(0, s−15)` | no | self | no |
| `KYAValidator.updateRepID` → `agent_kya_registry.repid_score` | `lib/trustshell/KYAValidator.ts:107-148` | `/api/trustrails/pay` `:136`, +10 after a transfer that is never confirmed | clamp [0,10000] | no (`agentName` from the body) | self | — |
| **`ComplianceReceiptGenerator.generate`** → `kya_compliance_receipts` (P0 target) | `lib/trustshell/ComplianceReceipt.ts:73-98` | `/api/trustrails/pay` `:128` (and `/demo` self-fetch) | HMAC secret falls back to the public `'trinity-default-sbt-secret'` (`:105`); synthetic `FB-PREAUTH-<8 hex>` (`:22`); BFT proof embedded | no | Solana devnet tx (unconfirmed) + **simulated** BFT | **no** |
| `/api/trustrails/generate-compliance-receipt` | `app/api/trustrails/generate-compliance-receipt/route.ts:54-65` | unauthenticated POST | unkeyed sha256 receipt hash | partial (`sbt_token_id` must exist; ownership not proven) | self | yes |
| `BFTAuthorizer.authorize` | `lib/trustshell/BFTAuthorizer.ts:9-88` | `/pay`, vault | fixed rules: VERITAS `amount<=limit`, SHOFET `Math.random()<0.05` veto, SOPHIA `true`; weights from the registry | — | **simulated** | its log insert is not checked |
| scripts | `final-harvest.js:44-53`, `scripts/mint-real-receipts.ts:77-99` | manual | — | — | fabricated / real Base Sepolia tx | no |

## G. Can the caller and the DB trigger both apply a P0-contained delta?

After this PR, for the two contained paths:

- **/score PREDICTION_RESOLVE** — `updateRepId` writes the row with `delta: 0` and **no** `repid_delta_calculated`. In off mode `ledgerColumns()` adds nothing, so the trigger computes `v_delta = 0` and returns before touching `repid_agents`. The app's absolute write is `decayed + 0`. **One applier, and the delta is 0.** Tested in `tests/p0-contain-prediction-zero-delta.test.ts` against a transcription of the trigger. The shadow Brier number lives only in `metadata.prediction_shadow`, which the trigger does not read.
- **score-event** — the guard-off branch inserts `delta: 0` with no `repid_delta_calculated`, so the trigger is a no-op. The guard-enforce branch sets `repid_delta_applied: 0`, so the trigger stands down. The app writes `current + 0`. The withheld certainty-scaled number lives only in `metadata.p0_contain`. Both branches are tested in `tests/p0-contain-score-event-zero-delta.test.ts`.
- **NOT_CHECKED:** that the production trigger body still matches the transcription. Its CREATE is not in the repo, and this lane may not read prod. Sean can check with `select pg_get_functiondef('apply_repid_score_event()'::regprocedure);`.

Double-apply paths that P0 does **not** fix (rows B7, B8, B9, B12 and the linked-bet RPC in A) remain. That is the follow-up for single-applier cutover.

## H. NOT_CHECKED (this map)

- Every production env flag value named above.
- The production bodies of the triggers in §0 and §C, and whether `repid_events` has a trigger.
- Whether `apply_linked_bet_resolution` in prod matches the repo migration.
- Railway deploy state of `w3c.index.js`, `trinity-worker.js` and `conductor`.
- `kya_compliance_receipts` / `repid_scores` schema and RLS (there are no migrations in trustrails-dev).
