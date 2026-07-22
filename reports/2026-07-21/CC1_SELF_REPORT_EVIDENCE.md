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

| eventType              | delta | enforce                     |
|------------------------|-------|-----------------------------|
| REFERRAL               | +20   | gated (zero if unproven)    |
| CODE_CONTRIBUTION      | +25   | gated (zero if unproven)    |
| PEACEMAKER             | +15   | gated (zero if unproven)    |
| WORKFLOW_CONTRIBUTION  | +20   | gated (zero if unproven)    |
| TOOL_PIONEER           | +12   | gated (zero if unproven)    |
| SELF_MONITOR           | +10   | gated (zero if unproven)    |
| AGENT_TEACHING         | +15   | gated (zero if unproven)    |
| AUDIT_CONTRIBUTION     | +15   | **exempt** (measured only)  |

Repeatable → RepID inflation. That is the root this task closes.

### 2026-07-21 amend — coverage-gap close

The adversarial verify found the first cut measured only **6 of 8** caller-assertable
positive types: **AGENT_TEACHING (+15)** and **AUDIT_CONTRIBUTION (+15)** were both
awarded via the `FIXED_DELTAS` else-branch and both accepted by `POST /api/v1/score`
(they are in the `score.ts` VALID_TYPES allowlist), yet neither was in the gated set —
so an attacker could still self-inflate through those two. This amend adds both to the
**MEASURED** set. The **full gated set is now 8 types** (table above).

**AUDIT_CONTRIBUTION is ENFORCE-EXEMPT.** Unlike the other seven, it has a legitimate
INTERNAL emitter: `src/routes/bounties.ts:118` calls `updateRepId({ eventType:
'AUDIT_CONTRIBUTION' })` server-side, but only AFTER a bounty is marked `VERIFIED` —
that server-side verification IS the proof, and the internal call supplies no
`evidence.ref`. Zeroing it in `enforce` would silently break real bounty payouts.
So AUDIT_CONTRIBUTION is added to a small `ENFORCE_EXEMPT = { AUDIT_CONTRIBUTION }` set:
shadow still records its `would_gate` (measurement is complete), but enforce records the
metadata AND applies the delta — it is never zeroed. AGENT_TEACHING has no internal
emitter, so it is fully gated (measured in shadow, zeroed when unproven in enforce).

## What changed

`src/engine/repid-update.ts` only (+ a new test). Additive; no existing rule removed.

1. **New env-driven mode** `SELF_REPORT_EVIDENCE_MODE ∈ { off | shadow | enforce }`,
   DEFAULT `shadow`. Resolved ONCE at module scope (`resolveSelfReportEvidenceMode()`),
   logged LOUDLY at first use (`logSelfReportModeOnce()`) — no silent modes.
2. **`SELF_REPORTED_EVIDENCE_TYPES`** = { REFERRAL, CODE_CONTRIBUTION, PEACEMAKER,
   WORKFLOW_CONTRIBUTION, TOOL_PIONEER, SELF_MONITOR, AGENT_TEACHING, AUDIT_CONTRIBUTION }
   (8 types after the 2026-07-21 amend). STAKE deliberately excluded (already gated to 0);
   GENESIS is 0; challenge/prediction/deception have their own scorers.
   **`ENFORCE_EXEMPT`** = { AUDIT_CONTRIBUTION } — measured in shadow, never zeroed in
   enforce (legit internal bounty-verify emitter, see amend note above).
3. **Optional input field** `evidence?: { kind: string; ref: string }` on
   `RepIdUpdateInput`. Never required anywhere — adding it breaks no caller.
4. **`evidencePresent(input)`** = a non-empty `evidence.ref` (co-sign / artifact / tx /
   attestation reference). Liberal by design — presence, not verification, mirroring how
   STAKE first gated on presence before its on-chain verifier.
5. **Gate in the FIXED_DELTAS branch** (new `else if` for the self-report set):
   - `off`     → apply the delta exactly as today. metadata `{ mode:'off' }`.
   - `shadow`  → apply the delta **exactly as today (no change)**, record metadata
     `{ mode:'shadow', required:true, present, would_gate: !present }`.
   - `enforce` → if unproven (`!present`) AND **not** enforce-exempt → `rawDelta = 0`
     (mirrors the STAKE stopgap); proven → unchanged; enforce-exempt (AUDIT_CONTRIBUTION)
     → metadata recorded (incl. `would_gate`) but delta **applied**, never zeroed.
   - Non-self-report events are untouched.

> **Stopgap disclosure (RULE-4):** `evidencePresent()` still checks only that a
> **non-empty `evidence.ref` string is present** — it does NOT verify that the ref
> resolves to a real co-sign / artifact / on-chain tx / attestation. That is the same
> presence-before-verification stopgap STAKE used before its on-chain verifier. A real
> ref verifier (resolve + bind the ref to the agent + guard replay) is **owed before the
> enforce flip** — until it lands, enforce would gate on presence alone, which a
> determined caller can satisfy with any non-blank string. Shadow measurement is safe
> regardless; enforce is not "secure" until the verifier ships.

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
  "required": true,        // always true for the 8 self-report types
  "present": false,        // was a non-empty evidence.ref supplied?
  "would_gate": true,      // (required && !present) — what enforce WOULD zero
  "enforce_exempt": true   // PRESENT ONLY for AUDIT_CONTRIBUTION; absent === not exempt
}
```
`off` records `{ "mode": "off" }`. Non-self-report events record `null`.
The `enforce_exempt` key appears ONLY for exempt types (AUDIT_CONTRIBUTION); for the
other seven the metadata shape is unchanged (`enforce_exempt` absent, i.e. not exempt).

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
  → green (see run log in PR #172 checks).
- Tests assert: (a) shadow unproven REFERRAL = +20 AND would_gate recorded;
  (a2) shadow proven REFERRAL = +20, would_gate false; (b) enforce unproven REFERRAL = 0;
  (c) enforce proven REFERRAL = +20; enforce unproven CODE_CONTRIBUTION = 0;
  off unproven REFERRAL = +20; (d) STAKE still 0 (unchanged, no self_report metadata).
- **Amend coverage:** (e) shadow unproven AGENT_TEACHING = +15 AND would_gate recorded;
  (f) enforce unproven AGENT_TEACHING = 0 (gated); (g) shadow unproven AUDIT_CONTRIBUTION
  = +15, would_gate + enforce_exempt recorded; (h) **enforce unproven AUDIT_CONTRIBUTION =
  +15** (EXEMPT — bounty payout path preserved) but would_gate STILL recorded.

## Guardrails honored

Branch-only, no merge, no peer-branch push, no prod DDL, no Railway/secrets/on-chain.
Shadow default = no live delta change (test-confirmed). Additive only.
