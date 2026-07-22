# CC-1 — Evidence-gate self-reported RepID deltas (shadow-first)

**Branch:** `feat/cc-2026-07-21-self-report-evidence` (from `origin/main`)
**Date:** 2026-07-21
**Author:** CC
**Status:** shadow-first, flag-gated, additive. Default changes NO live behavior.

## The systemic root (what #171 exposed)

PR #171 fixed STAKE: a caller-supplied `stakeProof` was treated as "verified" and
awarded +5 for any string, so the STAKE branch in `src/engine/repid-update.ts` was
hard-gated to delta 0 until a real on-chain verifier lands.

STAKE was not unique. The **entire FIXED_DELTAS positive table** is awarded for a
**caller-asserted `eventType` with no proof**. On the auth-gated `POST /api/v1/score`
path, any API-key holder can self-award:

| eventType              | delta |
|------------------------|-------|
| REFERRAL               | +20   |
| CODE_CONTRIBUTION      | +25   |
| PEACEMAKER             | +15   |
| WORKFLOW_CONTRIBUTION  | +20   |
| TOOL_PIONEER           | +12   |
| SELF_MONITOR           | +10   |

Repeatable → RepID inflation. That is the root this task closes.

## What changed

`src/engine/repid-update.ts` only (+ a new test). Additive; no existing rule removed.

1. **New env-driven mode** `SELF_REPORT_EVIDENCE_MODE ∈ { off | shadow | enforce }`,
   DEFAULT `shadow`. Resolved ONCE at module scope (`resolveSelfReportEvidenceMode()`),
   logged LOUDLY at first use (`logSelfReportModeOnce()`) — no silent modes.
2. **`SELF_REPORTED_EVIDENCE_TYPES`** = { REFERRAL, CODE_CONTRIBUTION, PEACEMAKER,
   WORKFLOW_CONTRIBUTION, TOOL_PIONEER, SELF_MONITOR }. STAKE deliberately excluded
   (already gated to 0); GENESIS is 0; challenge/prediction/deception have their own scorers.
3. **Optional input field** `evidence?: { kind: string; ref: string }` on
   `RepIdUpdateInput`. Never required anywhere — adding it breaks no caller.
4. **`evidencePresent(input)`** = a non-empty `evidence.ref` (co-sign / artifact / tx /
   attestation reference). Liberal by design — presence, not verification, mirroring how
   STAKE first gated on presence before its on-chain verifier.
5. **Gate in the FIXED_DELTAS branch** (new `else if` for the self-report set):
   - `off`     → apply the delta exactly as today. metadata `{ mode:'off' }`.
   - `shadow`  → apply the delta **exactly as today (no change)**, record metadata
     `{ mode:'shadow', required:true, present, would_gate: !present }`.
   - `enforce` → if unproven (`!present`) → `rawDelta = 0` (mirrors the STAKE stopgap);
     proven → unchanged. Same metadata shape.
   - Non-self-report events are untouched.

## Why shadow-first

`shadow` is the default and **must move no live delta** — proven by test (a): an unproven
REFERRAL still yields +20 under the default. Shadow only *records* `would_gate` so we can
measure, from the live ledger, how many real self-reports arrive unproven before flipping
enforce on. This follows the repo's established shadow-first pattern (TRUST_DECEPTION_MODE,
HAL plurality guard) and RULE-4 (no fake gate steering scoring).

## Shadow metadata shape (in `repid_score_events.metadata`)

```json
"self_report_evidence": {
  "mode": "shadow",        // off | shadow | enforce
  "required": true,        // always true for the 6 self-report types
  "present": false,        // was a non-empty evidence.ref supplied?
  "would_gate": true       // (required && !present) — what enforce WOULD zero
}
```
`off` records `{ "mode": "off" }`. Non-self-report events record `null`.

## How Sean sizes the enforce flip

Run against the live ledger after shadow has soaked:

```sql
SELECT event_type,
       count(*)                                                        AS total,
       count(*) FILTER (WHERE (metadata->'self_report_evidence'->>'would_gate')::bool) AS would_gate,
       round(100.0 * count(*) FILTER (WHERE (metadata->'self_report_evidence'->>'would_gate')::bool) / count(*), 1) AS pct_unproven
FROM repid_score_events
WHERE metadata->'self_report_evidence'->>'mode' = 'shadow'
GROUP BY event_type
ORDER BY would_gate DESC;
```

`would_gate` = deltas that ENFORCE would zero. A high `pct_unproven` on legitimate
traffic means callers need an evidence-attach path before flipping; a low one means
enforce is safe to turn on (`SELF_REPORT_EVIDENCE_MODE=enforce`, one env change,
one-action reversible). XC will red-team the gate + the evidence-presence definition.

## Verification (evidence over claims)

- `npx tsc --noEmit` → exit 0.
- `npx jest --config jest.config.js tests/self-report-evidence.test.ts tests/stake-delta-gate.test.ts`
  → **2 suites passed, 9 passed + 1 todo**.
- Tests assert: (a) shadow unproven REFERRAL = +20 AND would_gate recorded;
  (a2) shadow proven REFERRAL = +20, would_gate false; (b) enforce unproven REFERRAL = 0;
  (c) enforce proven REFERRAL = +20; enforce unproven CODE_CONTRIBUTION = 0;
  off unproven REFERRAL = +20; (d) STAKE still 0 (unchanged, no self_report metadata).

## Guardrails honored

Branch-only, no merge, no peer-branch push, no prod DDL, no Railway/secrets/on-chain.
Shadow default = no live delta change (test-confirmed). Additive only.
