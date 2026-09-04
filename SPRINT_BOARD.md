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

## OPEN AS OF 2026-09-04 (session handoff — do not re-derive)

Everything below was measured this session against the live database or the code on
`main`. Dates are attached because a number without one is an assertion.

### Human-gated — nothing below moves without Sean

| Item | Where exactly | Value |
|---|---|---|
| `SERVICE_QUALITY_HOOK_MODE` | Railway → project `repid-engine` → **service** `repid-engine` → Variables (NOT project-shared) | literal `shadow` |
| `TRUSTRAILS_HMAC_SECRET` | Vercel project `trustrails` **and** Railway `repid-engine` — same value both | generate: `openssl rand -hex 32`. A publicly-known placeholder is in use today, so audit hashes are forgeable. Deleting it from HEAD is not rotation. |
| `SUPABASE_URL` + `SUPABASE_SECRET_KEY` | Vercel project `trustmarket-landing` | the `sb_secret_…` key from Supabase → Settings → API Keys. NOT `sb_publishable_…` (that one ships in the browser). Route 503s by design until both exist. |
| trustmarket.dev deploy target | Vercel | domain is served by an April static upload from `trustmarket-coming-soon`, not the landing project — merged fixes will not appear until this is repointed |
| `www.trustmarket.dev` TLS | DNS / Vercel | certificate invalid |

### Verification debts — real work that is NOT_CHECKED until something runs

Neither of these is a failure. Both are claims with no live witness yet, and each
names the single observation that would close it.

- **The 2026-08-17 HAL orientation fix has never scored a real deliverable.** Deliverable
  traffic stopped 2026-08-17, the same day the fix landed. VERIFIED in simulation
  (`npm run repid:sim`: monotone, zero violations), NOT_CHECKED in production. Closes on
  the first `purpose: deliverable` event dated after 2026-08-17.
- **The service-quality hook (#603) has never executed.** It is on `main` and inert —
  mode defaults to `off`. Closes on the first row where
  `service_contracts.metadata ? 'hal_quality_shadow'`.

### Found this session, not yet acted on

- **CLAUDE.md is stale and says so nowhere.** It records all 12 Trinity agents as offline
  since ~2026-07-17. FALSE [MEASURED 2026-09-04]: `trinity-nexus` and `trinity-hdm` scored
  on 2026-09-03, `trinity-gcm` and `trinity-veritas` on 09-02. Read liveness from recency,
  never from that line.
- **Live fulfilments still pass `task_domain: 'general'`.** So today's real service work
  classifies as non-deliverable and earns nothing from HAL. #603 fixes this for its own
  event only; the existing `SERVICE_FULFILLED` path is untouched.
- **Peer-verification is dead and was never load-bearing.** Completer last ran 2026-07-04,
  producer stopped 2026-07-21, 62,841 rows stuck `in_review` with `completed_at` NULL. It
  has produced **zero** RepID events in its entire history — so its death cost nothing in
  scoring, but the anti-gaming consequence path `chronic-flag-accumulator` routes to has
  never once fired.
- **`PREDICTION_RESOLVE` has gone quiet** — 2,892 events lifetime, 11 since July. Second-
  largest event type in the ledger. Whether the producer is still wired is UNVERIFIED.
- **`repid_agents.risk_tolerance` is read by no code.** Dead column. Harmless today, but it
  is the shape a user-settable risk knob would take, and such a knob is a measured +73 RepID
  arbitrage on identical work (`npm run repid:sim`, Part 4). Do not wire it without reading
  that first.

### Designed, not built

The E2E transaction (x402 + ERC-8004 + RepID + HAL in one contract), a chess match as an
honesty-under-stakes test, and a posed-problem event class that pays only when someone
else resolves the question. Reasoning for all three is in the session transcript, not here.

## DONE (this run)

| Surface | Evidence |
|---------|----------|
| Tier-0 harness built + verified live + packaged as MVP | PR #364; `reports/2026-08-07/TRUST_HARNESS_MVP_VERIFIED.md` |
| A — 3-file source of truth | this branch `feat/cc-2026-08-07-orchestration-sot` |
