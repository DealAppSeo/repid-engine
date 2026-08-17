# VISION_VS_VERIFIED.md

The gap table. Left is where we're going; right is what is provable *today*. The
middle column is the honest delta — the thing an agent picks up and closes. No
row is allowed to describe the vision as if it were the present tense.

Pair with [CLAIM_LEDGER.md](CLAIM_LEDGER.md) (state per claim) and
[SPRINT_BOARD.md](SPRINT_BOARD.md) (ordered work). Last updated 2026-08-17 by CC.

**2026-08-17:** the swarm row was rewritten — it read "T12 exists on Railway",
which was true and misleading: it has been dormant for a month. Three rows added
for target-system pieces (selective disclosure, issuer-staked reputation, the
decay ratchet) that appeared in **no** vision or goals doc, two of which already
exist in code. A gap table that omits a gap is worse than no table.

---

| Vision (where we're going) | Verified today | The gap (the work) |
|----------------------------|----------------|--------------------|
| Any reviewer installs a package and watches the whole trust loop prove itself | `npm run demo:harness` runs the 7-step loop live, all legs REAL (PR #364) | Public npm/CLI wrapper that ships **only** public endpoints (this repo is proprietary — `private:false` + no `files` = bare publish leaks the scoring formula). **BLOCKED_FOR_SEAN: npm publish.** |
| A portable proof a third party can present and verify without our API key | Range proof is fetched + verified locally inside the demo | `presentProof` / badge surface in TrustShell that a reviewer calls standalone — Surface B |
| A marketplace where agents transact and are rated at 3 stages, ratings un-gameable | Fold root + dual-auth decision are produced per outcome | Rating ingestion backend that *consumes* the fold root + gate decision; verified-engagement gating — Surface C |
| Humans + agents stake and trade on reputation | Hero receipt proves one real USDC→attestation loop; RepID drives tiers | TrustTrader backend consuming fold root / RepID (not marketing pages) — Surface D |
| Every Trust* surface shares one auth/RepID/gate spine | The gate, RepID read, and HAL veto are live + keyless | Shared hooks wired into trustchat / AISocialMirror where repos exist; clean stub interfaces where they don't — Surface E |
| Trinity swarm (T12) does long-running verification autonomously | **DORMANT since 2026-07-17 22:18Z** — all 12 heartbeats stopped inside a 48-second window, after a sustained ~3× throughput drop that began 07-16 ~05:00Z. Root cause of neither event established | Two problems, not one. Also: 3 agents are still *running* and emitting alerts; only the heartbeat write died, and every reader infers death from heartbeat staleness. Toolless-ness remains true and unfixed underneath. See `reports/2026-08-17/SWARM-DORMANCY-2026-07-17.md` |
| A proof discloses only the predicate, never the score behind it | Seam exists in `src/services/receipt-issuer.ts`; named in the hyperdag README | Not represented in any vision or goals doc until now, so parallel lanes could not find it. `witnessHidden` / `provenWithoutSecret` need a stated contract before a second implementer touches them |
| Reputation is issuer-staked — an attestor has something at risk | **Nothing.** The string `issuer-stak*` appears in no doc and no source file across all four repos | Greenfield. Owned elsewhere (Gate 2); listed here so it stops reading as built |
| Score decays unless re-earned — a ratchet, not a plateau | Ratchet logic exists in `src/scoring/decay-bridge.ts`, `score-event-guard.ts`, `peer-verify-score.ts` and one migration | Present in code, absent from every vision/goals doc. The design question — what re-earning means against agents already sitting on the floor — is unanswered, not unimplemented |
| Confidence numbers are calibrated + comparable across evals | One calibrated run captured (T=0.8192 @ ruler 596f10de18d0) | Published ECE on the current frozen corpus, ruler attached to every HAL number |
| An always-on manager keeps the loop running with Sean's laptop closed | The overnight branch loop is running (this session) | Railway worker "manager" deploy — prepared on branch, **BLOCKED_FOR_SEAN: Railway infra GO** |

## Standing honesty rules (apply to every row)

- A leg that cannot run is a **gap**, printed as such — never a fabricated success.
- "Done" = provable (run / tx / test artifact), not an agent's say-so.
- Live-system facts are dated snapshots; re-verify against Supabase / on-chain before asserting.
- No external claim (marketing, patent, investor) from anything short of VERIFIED **and** Sean-audited.
