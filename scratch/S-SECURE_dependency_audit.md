# S-SECURE Dependency Vulnerability Audit

**Date:** 2026-06-02  
**Source:** `npm audit` (and --json) run read-only on the three repos.

## Summary by Repo

### repid-engine
- **11 vulnerabilities**
  - critical: 1 (protobufjs: Arbitrary code execution GHSA-xq3m-2v4x-88gg)
  - high: 4 (including @xenova/transformers via onnxruntime-web, onnx-proto, tmp path traversal, etc.)
  - moderate: 5 (ethers/ws, express-rate-limit/ip-address, qs, several protobufjs)
  - low: 1 (solc/tmp)
- Prod deps: 249
- Many fixes available via `npm audit fix` or `--force` (some are semver major for transformers/ethers/solc).
- Notable production-relevant: protobufjs (deep dep, code gen issues), ws (uninitialized memory in ethers), rate-limit related (GMPD known area).

### trinity-symphony-shared
- **5 vulnerabilities**
  - high: 1 (qs arrayLimit bypass DoS GHSA-w7fw-mjwx-w883)
  - moderate: 4
- Fewer issues than engine.

### trustchat-backend
- **5 moderate severity vulnerabilities**
- No critical/high reported in the scan output.

## Production Impact Assessment
- **Critical/High affecting live paths**: Yes in repid-engine (protobufjs code execution risk, transformers/onnx for any local model or HAL-related inference if used in prod, tmp for solc if contracts involved).
- Rate limiting / express-rate-limit moderate issues may tie into the known IPv6 GMPD bug.
- No evidence these are only devDeps; some (ethers, ws, transformers) are likely used in scoring/zkp/on-chain paths.
- trinity-shared and backend lower severity.

## Recommended Fixes
1. **repid-engine (highest priority)**:
   - Run `npm audit fix` first (safe changes).
   - For major: evaluate `npm audit fix --force` in a branch + full test suite (1,277 tests).
   - Specific: Pin or update protobufjs, onnxruntime-web/transformers, ethers, ws, tmp.
   - Review if @xenova/transformers is used in production inference or only tests/local.

2. **trinity-symphony-shared**:
   - `npm audit fix` for qs and related.

3. **trustchat-backend**:
   - `npm audit fix` for the 5 moderate.

4. Enable Dependabot + scheduled `npm audit` in CI for all three repos.

5. After fixes, re-audit and update this file.

**Overall supply chain posture**: Needs work. The critical in repid-engine is a blocker for high-security pen-test.

---
End of S-SECURE_dependency_audit.md (Phase 2 complete)