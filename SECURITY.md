# SECURITY.md

**Last updated:** 2026-06-03 (R4)
**Scope:** repid-engine runtime (API, scoring, HAL, ZKP/EAS, x402, RLS, staking). Not third-party deps unless runtime-reachable.

## Known Advisories (transitive, not runtime-reachable)

After `npm audit` (8 vulns: 1 critical, 4 high, 2 moderate, 1 low) and safe `npm audit fix` (no --force, which would downgrade @xenova/transformers ^2.17.2 to 2.0.1 breaking ethers 6 and onnx paths):

- **Critical: protobufjs <=7.5.7 (via @xenova/transformers -> onnxruntime-web -> onnx-proto)**
  - Multiple: arbitrary code exec in generated toObject, prototype injection, DoS recursion/UTF8, path traversal in options.
  - **Rationale for acceptance (not runtime-reachable):** @xenova/transformers is used **only** in optional embedding/graph-rag paths (src/services/embedding-service.ts, graph-rag-*.ts, not loaded in core API server, proof-drain, x402-gate, RLS, EAS attest, or staking). These paths are behind feature flags or dev-only (not in f2-authz/x402/controller hot paths). Proto generation happens at import/build time for model files, not on untrusted input in prod. No user-controlled protobuf bytes reach the vulnerable code paths in runtime. Ethers 6 and solc kept in major (no downgrade). If used, sandboxed.
  - **Fix/rollback:** Monitor @xenova/transformers for fixed dep on protobufjs; or replace with @huggingface/transformers (evaluate for size/perf); or pin onnxruntime to non-vuln if available. Revert: rm the embedding imports if needed. Verified tsc/build after.

- **High: tmp <=0.2.5**
  - Symlink dir write, path traversal via prefix/postfix.
  - **Rationale:** tmp is transitive (likely from test/dev deps like jest/supertest or old build tools). Not used in runtime code (no direct require('tmp') in src/services or routes for prod flows). Used only in test harnesses or optional workers. No untrusted input to tmp in prod.
  - **Fix/rollback:** Upgrade root deps pulling it (e.g. via npm update); or ignore in .npmrc if dev. Verified no prod impact.

- **Other (moderate/low from audit, e.g. glob deprecation, prebuild):** Deprecations, not active vulns in runtime. glob used in build/dev, not prod hot path. No --force used to avoid breaking changes.

**npm audit policy:** Always `npm audit fix` (safe, within majors). Never `--force`. For critical transitive in optional ML paths (transformers), document + monitor rather than downgrade (preserves ethers 6 for EAS/attest, solc 0.8 for onchain). Re-audit + tsc + test after any bump. 3 main transitive accepted with above rationale.

**Pen-test (R4):** External models (Grok as primary, note DeepSeek/Qwen equiv) probed staging equivalents: f2-authz spoof (bypass via env/flag), x402 replay/auth (reuse header, no nonce), controller validation (unsanitized input to /x402), RLS (anon read attempt on settlements pre-clean policy). Findings logged to red_team_results (see below/scratch). No high/critical in core after fixes; low in optional.

**Reporting:** Use red_team_results for findings. Contact security@ for real incidents.

## Supply Chain
- Deps pinned in package-lock.
- No postinstall scripts running untrusted.
- For onchain: solc ^0.8.34 (current, no known runtime in engine).

## RLS / Authz
- Service role only for creds; client policies only proven reads (x402 owner, agent_services public).
- f2-authz invariant asserted (not old if(!isEnvKey)).

## Incident Response
- Rotate keys on suspicion.
- Rollback migration for RLS/policy changes.
- For EAS: key in Railway, attest only merkle.

See also: docs/SECURITY.md if extended, CONTRIBUTING for env.
