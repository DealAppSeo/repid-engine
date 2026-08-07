# SPRINT_BOARD.md

The ordered queue. Agents pull from the top; they do not reinterpret the order.
Hard parts first. When a surface closes: commit + evidence, update
[CLAIM_LEDGER.md](CLAIM_LEDGER.md), move to the next row.

Companion files: [CLAIM_LEDGER.md](CLAIM_LEDGER.md) · [VISION_VS_VERIFIED.md](VISION_VS_VERIFIED.md).
Last updated 2026-08-07 by CC.

---

## Execution graph (the loop every agent obeys)

```
SPRINT_BOARD (ordered)
      │ pull next
      ▼
  IMPLEMENTER ── evidence ──▶ VERIFIER (≥95% of original spec?)
      ▲                          │
      │  <95%: fix loop          │ ≥95%
      └──────────────────────────┤
                                 ▼
                    COMMIT + evidence + ledger update
                                 │
                                 ▼
              next priority  ──or──  PARKING_LOT (if blocked)
                                 │  tokens out / wall-clock end?
                                 ▼
                          TOTAL_RECAP.md
```

**Boundary — stop and wait ONLY for these five live-state gates:**
merge to main · npm publish · prod deploy / env secrets / Railway infra GO ·
on-chain txs that spend real funds · domain / DNS ownership actions.

Everything else: log under **BLOCKED_FOR_SEAN**, pull the next surface, keep building.
Waiting for approval on a non-live-state item is a process failure.

**Verifier loop (mandatory, per task):** implement against the original spec →
self-check (tests/smoke/measured output) → separate verifier pass with a *different*
checklist → if <95% match, fix and re-verify → only then advance. Evidence or it didn't happen.

---

## QUEUE (ordered)

| # | Surface | Definition of done (≥95% of spec) | State |
|---|---------|-----------------------------------|-------|
| A | 3-file source of truth | The three files exist on a branch, populated only with evidenced claims | **IN PROGRESS** (this commit) |
| B | TrustShell `presentProof` / badge path | A portable proof surface a reviewer calls standalone (no engine API key); tests | QUEUED |
| C | TrustMarket backend wiring | Rating ingestion consuming fold root + dual-auth decision; schema + API + tests; **no UI theater** | QUEUED |
| D | TrustTrader backend | Fold-root / RepID consumption; schema + API + tests | QUEUED |
| E | trustchat + AISocialMirror backend plugs | Shared auth/RepID/gate hooks where repos exist; clean stub interfaces where they don't | QUEUED |
| F | AITrinitySymphony.com deploy diagnosis | Correct Vercel/project mapping as a branch/PR with exact steps for Sean; **do NOT flip DNS** | QUEUED |
| G | Parking lot (when A–F blocked) | Ship commits on branches from PARKING_LOT | FALLBACK |

## PARKING_LOT (pull when the primary queue is blocked)

- Searchable encrypted memory cell (agent memory, committed + queryable)
- Plonky3 recursion stub + measure (proof-of-proof, capture proving time)
- Family-BFT docs-as-code tests (the quorum-family invariants as executable tests)
- Canary hardening (fetch-timeout on the HAL harness; the harness lacked one)

## BLOCKED_FOR_SEAN (human-gated — parked, not stopping the loop)

| Item | Gate type | Exact action Sean takes | Unblocks |
|------|-----------|-------------------------|----------|
| Merge PR #364 (Tier-0 harness + MVP packaging) | merge to main | Review + squash-merge #364 | mainline `npm run demo:harness` |
| Publish the public trust-harness/CLI package to npm | npm publish | Decide public package boundary (must NOT be this proprietary repo), then publish | reviewers `npm install` without repo access |
| Deploy the always-on Railway "manager" worker | Railway infra GO | Approve service deploy (prepared on branch when ready) | laptop-closed overnight loop |

## DONE (this run)

| Surface | Evidence |
|---------|----------|
| Tier-0 harness built + verified live + packaged as MVP | PR #364; `reports/2026-08-07/TRUST_HARNESS_MVP_VERIFIED.md` |
| A — 3-file source of truth | this branch `feat/cc-2026-08-07-orchestration-sot` |
