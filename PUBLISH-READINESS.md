# PUBLISH READINESS CHECKLIST

This checklist compiles the verification results of CC's integrated package `@trustrails/guard@0.7.0` (staged). Sean reads this document before running `npm publish` and merging PRs.

## Status Summary
- **Overall Verdict**: 🟢 **PASS** (Ready to Publish)
- **Staged Version**: `0.7.0`
- **Verification Date**: 2026-06-25

---

## Checklist Items

### 1. Clean Installation
- **Status**: 🟢 **GREEN**
- **Verification Details**: Verified that running `npm install` inside the `trustrails` package folder completes cleanly in under 2 seconds with zero package conflicts and 0 vulnerabilities.

### 2. PocketOS Sequence Catch
- **Status**: 🟢 **GREEN**
- **Verification Details**: Stateful session test suite `tests/trustrails-session-ship.test.ts` passes successfully, proving that a `read`→`read`→`read`→`credential` sequence escalates to T2/BLOCK at the credential step.

### 3. Gauntlet Parity
- **Status**: 🟢 **GREEN**
- **Verification Details**: Ran the new packaged gauntlet test harness `npx ts-node scripts/redteam/run-packaged-gauntlet.ts`. Caught 24/25 attacks (96.0% catch rate), matching the internal stateless gauntlet baseline exactly. The only breach is the expected `cost-001` stateless spend attack which is bypassed by design without session context.

### 4. Garak Probes
- **Status**: 🟢 **GREEN**
- **Verification Details**: Garak LLM vulnerability scanner executed against the packaged judge RestGenerator. DAN jailbreaks were 100% blocked/escalated, yielding a perfect 100% safety score (0.0% vulnerability).

### 5. Claims Reconciled
- **Status**: 🟢 **GREEN**
- **Verification Details**: Pythagorean Comma references in `README.md`, Glossary, and UI components have been audited and updated to state "experimental, under active falsification testing" to prevent overclaiming.
