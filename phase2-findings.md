# Phase 2 Decisioning — Labels Findings

## FIX CYCLE 1 (CC, 2026-07-05)

Blind red-team (XC) failed **A1** (sampler bias) + **A3** (canary poisoning). A2, A4 passed and were
NOT touched (RULE-3: fix only the named errors — sampler (seed,id) logic, jury, extraction untouched).

### A1 — SAMPLER OUTCOME-SUBSET BIAS (FIXED)
`cap_hit` is a real terminal status (schema CHECK `2026-05-07-llm-spend-tracking.sql:15`
`status IN ('success','failed','rate_limited','cap_hit')`; type `src/billing/log-call.ts:12`) but was
omitted from `TERMINAL_STATUSES`, so cap-hit calls never entered the verification floor → the labeled
subset was biased against that outcome.

- `src/decisioning/verification-sampler.ts:38` — added `'cap_hit'` to `TERMINAL_STATUSES`; the frozen
  tuple now matches the schema CHECK exactly (all four terminal statuses). Header enumeration
  (`:25-30`) updated to match.
- Test `tests/decisioning-phase2-labels.test.ts` — new case
  *"A1: a cap_hit call is a terminal status and IS eligible for sampling"* asserts `cap_hit` ∈
  `TERMINAL_STATUSES`, `isCompletedDefault({status:'cap_hit'})===true`, and that a lone `cap_hit` call is
  selected (not skipped) at rate=1. The denominator test also now includes a `cap_hit` row
  (consideredCount 3→4).

### A3 — CANARY POISONING (all 3 holes FIXED) — `src/decisioning/canary-corpus.ts`
1. **SEED PROTECTION** (`:217-224` old last-wins → fixed): added `SEED_CANARY_IDS` (immutable, derived
   from `SEED_CANARIES`). The loader now REJECTS (loud, into `rejected[]`) any external row whose id
   collides with a built-in SEED id — seeds cannot be overridden. Reason string contains "SEED".
2. **INTRA-FILE DEDUPE**: the loader tracks `seenExternalIds`; a duplicate id within the external file
   is rejected-loud (`reason: 'duplicate id "<id>" within external corpus'`), keeping the FIRST
   occurrence rather than silently last-winning.
3. **PROVENANCE (anti-fabrication gate)** (`validateCanaryRow`, was `:152-157`): added
   `isValidSourceUrl()` (`new URL()` parse + http/https scheme check). External rows now MUST carry a
   valid `source_url` or are rejected as *unprovenanced*. Added `source_url?` to `CanaryProbe` and
   aligned the row schema with the T12 corpus format `{claim,label,domain,difficulty,source_title,
   source_url}` — `source_title` is accepted as the provenance-note alias for `source`.

### Tests (all under `tests/decisioning-phase2-labels.test.ts`; jest roots = `tests/` only)
- cap_hit sampled ✓ (A1 case above)
- seed cannot be overridden ✓ (*"A3 SEED PROTECTION"* — reject + seed answer stays `68`, not poisoned)
- intra-file dup rejected ✓ (*"A3 INTRA-FILE DEDUPE"* — first kept, second rejected)
- no-URL / bad-URL / non-http row rejected ✓ (*"A3 PROVENANCE ... unprovenanced"*)
- valid-URL provenanced row accepted ✓ (*"A3 PROVENANCE ... accepted (T12 format aligns)"*)
- pre-existing external-corpus test updated to add `source_url` and drop the now-invalid
  "external overrides seed" assertion.

### Verification
- `tsc --noEmit` → exit 0.
- `jest tests/decisioning-phase2-labels.test.ts tests/decisioning-disjointness.test.ts` →
  **41 passed / 41 total** (existing decisioning tests still green).

### Untouched (A2/A4 passed — RULE-3)
- verification-sampler (seed,id)-only inclusion logic; jury-assembly; rule-extraction module.
