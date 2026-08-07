# VISION_VS_VERIFIED.md

The gap table. Left is where we're going; right is what is provable *today*. The
middle column is the honest delta — the thing an agent picks up and closes. No
row is allowed to describe the vision as if it were the present tense.

Pair with [CLAIM_LEDGER.md](CLAIM_LEDGER.md) (state per claim) and
[SPRINT_BOARD.md](SPRINT_BOARD.md) (ordered work). Last updated 2026-08-07 by CC.

---

| Vision (where we're going) | Verified today | The gap (the work) |
|----------------------------|----------------|--------------------|
| Any reviewer installs a package and watches the whole trust loop prove itself | `npm run demo:harness` runs the 7-step loop live, all legs REAL (PR #364) | Public npm/CLI wrapper that ships **only** public endpoints (this repo is proprietary — `private:false` + no `files` = bare publish leaks the scoring formula). **BLOCKED_FOR_SEAN: npm publish.** |
| A portable proof a third party can present and verify without our API key | Range proof is fetched + verified locally inside the demo | `presentProof` / badge surface in TrustShell that a reviewer calls standalone — Surface B |
| A marketplace where agents transact and are rated at 3 stages, ratings un-gameable | Fold root + dual-auth decision are produced per outcome | Rating ingestion backend that *consumes* the fold root + gate decision; verified-engagement gating — Surface C |
| Humans + agents stake and trade on reputation | Hero receipt proves one real USDC→attestation loop; RepID drives tiers | TrustTrader backend consuming fold root / RepID (not marketing pages) — Surface D |
| Every Trust* surface shares one auth/RepID/gate spine | The gate, RepID read, and HAL veto are live + keyless | Shared hooks wired into trustchat / AISocialMirror where repos exist; clean stub interfaces where they don't — Surface E |
| Trinity swarm (T12) does long-running verification autonomously | T12 exists on Railway | T12 is toolless (no HTTP client) → its reports fabricate. Equip with real tools before trusting output — tomorrow's "specialize the swarm" |
| Confidence numbers are calibrated + comparable across evals | One calibrated run captured (T=0.8192 @ ruler 596f10de18d0) | Published ECE on the current frozen corpus, ruler attached to every HAL number |
| An always-on manager keeps the loop running with Sean's laptop closed | The overnight branch loop is running (this session) | Railway worker "manager" deploy — prepared on branch, **BLOCKED_FOR_SEAN: Railway infra GO** |

## Standing honesty rules (apply to every row)

- A leg that cannot run is a **gap**, printed as such — never a fabricated success.
- "Done" = provable (run / tx / test artifact), not an agent's say-so.
- Live-system facts are dated snapshots; re-verify against Supabase / on-chain before asserting.
- No external claim (marketing, patent, investor) from anything short of VERIFIED **and** Sean-audited.
