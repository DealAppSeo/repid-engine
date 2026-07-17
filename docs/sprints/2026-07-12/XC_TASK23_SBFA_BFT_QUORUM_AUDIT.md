# XC #23 — SBFA / Disjoint-Families BFT Quorum Audit

**Sprint:** `sprint-2026-07-12-ecosystem` · **Lane:** bft/consensus (XC exclusive)  
**Agent:** XC/grok · **Date:** 2026-07-13 · **Brain:** `repid_experiment_log` id=41 item 3  
**Method:** code path read + live Supabase measurement (service_role REST)  
**Status:** COMPLETE — branch+PR only, no prod merge

---

## 0. Question

> Are the empty BFT tables (`trinity_receipt_bft_results`, `trinity_receipt_validators`, `ai_consensus_decisions`, `prediction_consensus`, `trinity_shofet_rulings` = 0 rows) evidence that the disjoint-families quorum is **not enforced**, or only that it is **not persisted**?

Also: do edge fns `ai-consensus-engine` / `raven-constitutional-decisions` / `atlas-constitutional-decisions` run the live path?

---

## 1. Verdict (one line)

**ENFORCED on the live HAL scoring path (family-aware quorum ≥2), NOT persisted to the BFT receipt tables.**  
Those tables belong to a **separate receipt-indexer BFT path that is dark**.  
**Not a constitutional integrity gap on HAL decisions** — escalate only the **missing auditable BFT/SBFA receipt trail** + dead TrustTrader receipt path. Spec for persistence is below; do not flip `HAL_SBFA_ENFORCE` without A6+Sean.

---

## 2. Live measurements [V 2026-07-13]

| Object | Count / value | Source |
|---|---|---|
| `trinity_receipt_bft_results` | **0** | REST count |
| `trinity_receipt_validators` | **0** | REST count |
| `ai_consensus_decisions` | **0** | REST count |
| `prediction_consensus` | **0** | REST count |
| `trinity_shofet_rulings` | **0** | REST count |
| `trinity_constitutional_violations` | **0** | REST count |
| `sbfa_shadow_telemetry` / `hal_sbfa_shadow` | **relation does not exist** | REST 42P01 |
| `HAL_DECISION_REQUIRES_QUORUM` | `true` (db) | `repid_config` |
| `HAL_PENALTY_REQUIRES_QUORUM` | `true` (db) | `repid_config` |
| `HAL_STRICTNESS` | `2` (db) | `repid_config` |
| `hal_veto_threshold` | `0.43` | general HAL |
| `bft_veto_threshold` | `0.0195` | **TrustTrader-only** (not general HAL) |
| Recent `HAL_SCORE_EVENT` | `quorum_met: true`, `families_used: 4–5`, `decision_source: fact-check-quorum` | sample ids 146328–146344 |
| Events since 2026-07-12 | vetoed **2396** · clean **346** · flagged **115** | REST count |
| Purpose-suppressed vetoes | common (`wrong_task_purpose:peer_verify|operational|drill`) — **delta 0** even when `hallucination_caught=true` | metadata |

---

## 3. Where quorum is actually enforced [code]

### 3.1 Live path (HOT) — `repid-engine` HAL + scoring

| Layer | File | Behavior |
|---|---|---|
| Family-aware fact-check | `src/hal/fact-check.ts` | Distinct **families** (not hosts); `HAL_QUORUM_FAMILY_AWARE` default ON; `MIN_QUORUM_FOR_VETO`; cost-ordered waves stop when ≥ min families respond; low quorum downgrades would-be veto → clean |
| Registry | `src/decisioning/family-registry.ts` + `disjointness.ts` | Registry-primary family lookup; unmapped models surface as `families_unmapped` |
| Config | `src/hal/config.ts` | `HAL_DECISION_REQUIRES_QUORUM` / `HAL_PENALTY_REQUIRES_QUORUM` from `repid_config` → env → default **true** |
| Decision gate | `src/scoring/pipeline.ts` ~L312–345 | `quorumMet = mode==='fact-check' && familiesUsed >= 2`; without quorum → decision neutralized to `flagged`, **no penalty** |
| Purpose gate | same file | Even grounded vetoes on non-deliverables apply **0** delta (explains mass vetoes with 0 applied) |

**Live evidence matches code:** recent events show 5-family panels (`llama, glm, gemini, mistral, qwen`), `quorum_met: true`, and purpose-suppressed deltas — not extractor-only theater.

### 3.2 SBFA v0.2 — shadow only

| Piece | State |
|---|---|
| Pure consensus | `src/hal/sbfa-consensus.ts` (DST/Yager, reliability oracle, glass-box trace) |
| Wire-in | `src/hal/fact-check.ts` — shadow additive; `HAL_SBFA_ENFORCE` default OFF (A6-gated) |
| Telemetry | Sampled console/`setImmediate` (~10%); **no DB table** for SBFA shadow receipts |

SBFA is **not** the live veto enforcer today. Family quorum + pipeline gates are.

### 3.3 Receipt BFT path (COLD / empty)

| Piece | State |
|---|---|
| Schema | `supabase/migrations/2026-05-03_trinity_receipt_validators.sql` |
| Aggregator | `src/services/receipt-indexer.ts` `checkBftAggregation()` — needs ≥4 decisive validators on `hyperdag_receipts` with on-chain reveal; simple majority + veto-wins (φ 0.618); writes `trinity_receipt_bft_results` |
| Inputs | `trinity_receipt_validators` **0 rows** → aggregator can never resolve |
| Threshold | `bft_veto_threshold=0.0195` documented as TrustTrader-only (`agents-external.ts`) |

### 3.4 Named edge functions

Searched `repid-engine` + `trinity-ecosystem/supabase/functions`:

- **Not present** as deployed edge functions in-repo (only `agent-tools` under trinity-ecosystem).
- Live constitutional / HAL decisions run in **repid-engine** (Railway), not those edge fn names.
- Empty tables + missing edge fns ≠ “no quorum” on HAL; they mean the **receipt/TrustTrader BFT subsystem is unwired**.

---

## 4. Adversarial residual risks (still real)

1. **No durable per-decision validator vote ledger** for HAL — audit trail is event `metadata` JSON only (lossy, not queryable as BFT).
2. **`families_unmapped`** still non-empty on live traffic (e.g. gemini-3.5-flash, qwen-2.5-72b) — registry lag; family is regex-guessed for those (logged).
3. **SBFA enforce OFF** — glass-box shadow not co-deciding; fine until A6, but no shadow **DB** for offline measurement.
4. **Receipt BFT dark** — if TrustTrader / HyperDAG receipt challenge depends on it, that product path has **zero** recorded operation (separate from HAL scoring).
5. **`bft_veto_threshold` naming confusion** — not the live HAL veto bar; operators may misread config as “BFT is live.”

---

## 5. Spec — HAL BFT receipt + validator-vote persistence (build next, not this PR’s runtime)

### 5.1 Goal

Every scoring-eligible HAL fact-check decision emits:

1. One **panel receipt** (decision-level)
2. N **validator vote** rows (provider/family level)

Queryable, append-only, service_role write, no live threshold change.

### 5.2 Proposed tables (additive DDL — Sean co-sign before apply)

```sql
-- HAL family-quorum panel receipt (NOT TrustTrader receipt_id path)
CREATE TABLE IF NOT EXISTS hal_quorum_receipts (
  id                bigserial PRIMARY KEY,
  score_event_id    bigint NULL,              -- FK soft to repid_score_events when known
  quorum_id         text NOT NULL,            -- correlates billing.log-call + fact-check
  agent_id          text NULL,
  decision          text NOT NULL,            -- vetoed|flagged|clean|abstain
  scoring_decision  text NOT NULL,            -- after neutralization
  quorum_met        boolean NOT NULL,
  families_used     int NOT NULL,
  providers_used    int NOT NULL,
  families          text[] NOT NULL DEFAULT '{}',
  families_unmapped text[] NOT NULL DEFAULT '{}',
  agreement         numeric NULL,
  hal_score         numeric NULL,
  hal_mode          text NULL,                -- fact-check|extractor|extractor-fallback
  sbfa_decision     text NULL,                -- shadow advisory if present
  sbfa_belief       numeric NULL,
  sbfa_ignorance    numeric NULL,
  decision_source   text NULL,
  created_at        timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS hal_quorum_validator_votes (
  id              bigserial PRIMARY KEY,
  receipt_id      bigint NOT NULL REFERENCES hal_quorum_receipts(id) ON DELETE CASCADE,
  provider        text NOT NULL,
  model           text NULL,
  family          text NOT NULL,
  verdict         text NOT NULL,             -- TRUE|FALSE|UNCERTAIN|ERROR
  confidence      numeric NULL,
  latency_ms      int NULL,
  error           text NULL,
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_hal_quorum_receipts_created ON hal_quorum_receipts(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_hal_quorum_receipts_event ON hal_quorum_receipts(score_event_id);
CREATE INDEX IF NOT EXISTS idx_hal_quorum_votes_receipt ON hal_quorum_validator_votes(receipt_id);
```

### 5.3 Write path

- Hook in `src/scoring/pipeline.ts` **after** quorum computation (or fact-check return), fire-and-forget `setImmediate`, never block scoring.
- Sample rate env `HAL_QUORUM_RECEIPT_SAMPLE_RATE` default `1.0` initially (volume ~2.6k/day is fine); can lower.
- Do **not** reuse `trinity_receipt_*` without a clear `receipt_id` from HyperDAG on-chain — different domain.

### 5.4 What NOT to do

- Do not invent writes into empty TrustTrader tables to “look green.”
- Do not enable `HAL_SBFA_ENFORCE` in this workstream.
- Do not touch routing / LAO / ANFIS tables (lane exclusive).

---

## 6. Escalation to Sean?

| Issue | Escalate? |
|---|---|
| HAL family quorum not enforced | **NO** — it is enforced [V] |
| Missing durable HAL vote ledger | **YES (medium)** — integrity/audit gap, not live-score bug |
| TrustTrader receipt BFT 0 rows | **YES (product)** — if TT challenge is in scope this quarter |
| Edge fn names missing | **INFO only** — dead name references in handoff |

---

## 7. Recommended follow-ups (ordered)

1. **CC** — implement §5 tables + async writer behind flag `hal_quorum_receipt_enabled` (default off until migration applied).
2. **GA** — measure: % decisions with `quorum_met=false` neutralized; `families_unmapped` rate; compare SBFA shadow vs live decision disagreement rate once shadow rows exist.
3. **XC** — after receipts land, verification-race design can key off panel latency + early terminate (roadmap Wave 3).
4. **Registry** — register live unmapped models (gemini-3.5-flash, qwen-2.5-72b-instruct) so family count is non-spoofable.

---

## 8. Sources

- Brain: `repid_experiment_log` id=41
- Config: `repid_config` keys listed §2
- Code: `src/hal/fact-check.ts`, `src/hal/config.ts`, `src/hal/sbfa-consensus.ts`, `src/scoring/pipeline.ts`, `src/services/receipt-indexer.ts`, `src/decisioning/{family-registry,disjointness}.ts`
- Live samples: `repid_score_events` 146325–146344 (2026-07-13)
