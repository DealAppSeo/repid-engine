# SPRINT_BOARD.md

The ordered queue. Agents pull from the top; they do not reinterpret the order.
Hard parts first. When a surface closes: commit + evidence, update
[CLAIM_LEDGER.md](CLAIM_LEDGER.md), move to the next row.

Companion files: [CLAIM_LEDGER.md](CLAIM_LEDGER.md) · [VISION_VS_VERIFIED.md](VISION_VS_VERIFIED.md).
Last updated 2026-09-03 by CC. **Re-measured, not re-asserted** — B and C were both
QUEUED for four weeks after they had shipped. See the note under the queue.

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
| B | TrustShell `presentProof` / badge path | A portable proof surface a reviewer calls standalone (no engine API key); tests | **DONE** — shipped in `@hyperdag/trustshell` 1.3.0. `client.presentProof` (`src/lib/trustshell.ts`), `src/lib/badge.ts`, checked-in example `examples/proof-badge-trinity-shofet.svg`. No API-key gate on the CLI proof path. `tests/badge.test.ts` + `tests/portable.test.ts` = **33 tests pass** (measured 2026-09-03) |
| C | TrustMarket backend wiring | Rating ingestion consuming fold root + dual-auth decision; schema + API + tests; **no UI theater** | **DONE** — `src/services/rating-ingestion.ts` (`admitRating` matches fold root, rejects `fold_root_mismatch`, and **fails closed on an unrecorded dual-auth decision** — "an unrecorded ALLOW is not an ALLOW"), route `src/routes/v1/ratings.ts`, tables `repid_ratings` + `repid_outcomes` both exist. `tests/rating-ingestion.test.ts` + `tests/participant-rating.test.ts` = **39 tests pass**. Both tables hold 0 rows — **correct for a pre-user system, not a gap** |
| D | TrustTrader backend | Fold-root / RepID consumption; schema + API + tests | QUEUED |
| E | trustchat + AISocialMirror backend plugs | Shared auth/RepID/gate hooks where repos exist; clean stub interfaces where they don't | QUEUED |
| F | AITrinitySymphony.com deploy diagnosis | Correct Vercel/project mapping as a branch/PR with exact steps for Sean; **do NOT flip DNS** | QUEUED |
| G | Parking lot (when A–F blocked) | Ship commits on branches from PARKING_LOT | FALLBACK |

### Why B and C sat QUEUED for a month after shipping

This board is the ordering authority — the loop above says agents "pull from the top
and do not reinterpret the order." A stale board is therefore worse than no board: an
agent obeying it faithfully rebuilds finished work. B shipped in the SDK's 1.3.0 and C
has 39 passing tests behind it; both still read QUEUED on 2026-09-03.

`docs/PRIOR-WORK-INDEX.md` in `trinity-ecosystem` records the cost of exactly this —
two sprints spent optimising a component already at 97.9% of its bound. The rule that
prevents it is cheap: **before pulling a surface, measure whether it is already built.**
Four greps and two `jest` runs settled B and C here.

One correction worth keeping, because it nearly produced a false finding: checking C's
schema by guessing table names (`agent_ratings`, `ratings`, `marketplace_ratings`)
returned nothing and read as "the schema was never built." The real tables are
`repid_ratings` and `repid_outcomes` — this repo names everything `repid_*`, which
CLAUDE-RULE-5 says outright. Trace the route to the table; do not guess the table.

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
| **`TRUSTRAILS_HMAC_SECRET` is not armed on either aitrinitysymphony surface** — both self-report `ready:false` [MEASURED 2026-09-03 via `GET /api/version`] | env secret | Set a real secret on **both** the Vercel project (www + apex) and the Railway service (app), then re-check `/api/version` shows `ready:true` | compliance-receipt `audit_hash` integrity |

## DONE (this run)

| Surface | Evidence |
|---------|----------|
| Tier-0 harness built + verified live + packaged as MVP | PR #364; `reports/2026-08-07/TRUST_HARNESS_MVP_VERIFIED.md` |
| A — 3-file source of truth | this branch `feat/cc-2026-08-07-orchestration-sot` |
