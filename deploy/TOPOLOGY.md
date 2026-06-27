# TOPOLOGY — repid-engine deploy targets vs worktree copies (Phase 0)
PREP doc · 2026-06-26 · XC lane · verified [V] via `ls -d` + `git worktree list` 2026-06-26

## TL;DR (the "75 → 2–3" reconcile)
The "many repid-engine dirs" are **agent git worktrees of ONE source repo**, not separate services.
**Distinct deploy targets ≈ 3** (repid-engine, hyperdag-core/zkp-postcard, landing). The cleanup is
**prune stale worktrees + one canonical config per repo**, NOT 75 migrations. No directory is deleted
this sprint — this is an enumeration + disposition plan only (AXIOM A4: enumerate-before-absence).

## VERIFIED COUNTS [V 2026-06-26]
- `ls -d repid-engine*` = **67 dirs** = 1 canonical (`repid-engine`) + 1 NEW this sprint
  (`repid-engine-xc-standby`, my clean worktree) + **65 agent worktrees**.
- `git -C repid-engine worktree list` = **63 entries** (canonical + 62 registered worktrees).
  The 67-vs-63 delta: `repid-engine-mvp` etc. that are plain checkouts/not-registered worktrees, plus
  the 2 just-noted (canonical counted once; standby just added). Treat the `git worktree list` set as
  authoritative for "safe to `git worktree remove`".
- `ls -d hyperdag-core*` = **8 dirs**; `git -C hyperdag-core worktree list` = **8 entries**
  (canonical + 7 worktrees).

## DISTINCT DEPLOY TARGETS (the real surface)
| Target | Source repo | Host today | Standby (this sprint) |
|---|---|---|---|
| **repid-engine** (reputation API) | `DealAppSeo/repid-engine` | Railway `repid-engine` project | Fly `repid-engine-standby` (sjc, IDLE) |
| **hyperdag-core / zkp-postcard** (Rust prover) | `DealAppSeo/HyperDAG-core` | Railway (zkp-postcard svc in AITrinitySymphony; HyperDAG-core svc) | NOT in scope (repid-engine is the first/only standby) |
| **landing** (static) | `aitrinitysymphony-landing` / others | Railway landing + Vercel | NOT in scope |

(The 12 Trinity agents are a 4th surface but live in `trinity-symphony-shared`, out of scope here.)

## DISPOSITION: repid-engine worktrees (registered via `git worktree list`)
**KEEP (canonical / active this sprint):**
- `repid-engine` — canonical checkout (currently on `feat/xc-2026-06-07-verify-proof-golive`, dirty WIP).
- `repid-engine-xc-standby` — THIS sprint's clean worktree on `feat/xc-2026-06-26-portable-standby`.

**PRUNE-CANDIDATE (stale agent worktrees — branch already merged or superseded; safe `git worktree remove` follow-up):**
Enumerated from `git worktree list` (branch in brackets). Anything whose branch is merged to `main`
(e.g. control-lane #108, HAL strict-mode landings) or clearly an old dated sprint is a prune candidate:
- repid-engine-a2 [feat/cc-2026-06-09-poseidon2-leaf-drain]
- repid-engine-anfis [feat/cc-2026-06-06-anfis-shadow-trim]
- repid-engine-b [feat/cc-2026-06-08-hal-category-aware]
- repid-engine-cc [feat/cc-2026-06-04-honest-hal]
- repid-engine-cc-anfis [feat/cc-2026-06-16-anfis-routing]
- repid-engine-cc-cache [feat/cc-2026-06-02-dragonfly-cache]
- repid-engine-cc-consequence [feat/cc-2026-06-24-r3]
- repid-engine-cc-crosscheck [feat/cc-2026-05-30-crosscheck-harness]
- repid-engine-cc-dualband [feat/cc-2026-06-15-dual-band]
- repid-engine-cc-fix [feat/cc-2026-06-02-fix-real-gaps]
- repid-engine-cc-hal [feat/cc-2026-05-29-hal-truth-repair]
- repid-engine-cc-halv1 [feat/cc-2026-06-16-hal-v1-readiness]
- repid-engine-cc-hitl [feat/cc-2026-06-15-hitl-decide]
- repid-engine-cc-infra [feat/cc-2026-06-10-quota-registry]
- repid-engine-cc-measure [feat/cc-2026-05-30-hal-measurement]
- repid-engine-cc-proofdrain [feat/cc-2026-06-07-proofdrain-statement-agentid]
- repid-engine-cc-r4 [feat/cc-2026-06-24-r4-package]
- repid-engine-cc-r5 [feat/cc-2026-06-24-r5-harden]
- repid-engine-cc-r6 [feat/cc-2026-06-24-r6-session]
- repid-engine-cc-r7 [feat/cc-2026-06-24-r7-wire]
- repid-engine-cc-rep1 [feat/cc-2026-05-30-s-stable2]
- repid-engine-cc-rls [feat/cc-2026-06-01-rls-lockdown]
- repid-engine-cc-sbfa [feat/cc-2026-06-15-honesty-commitment]
- repid-engine-cc-ship [feat/ga-2026-06-25-key-health]
- repid-engine-cc-stubguard [feat/cc-2026-06-15-stub-quarantine]
- repid-engine-cc-traceproducer [feat/cc-2026-06-16-escalation-trace-producer]
- repid-engine-cc-vloop [feat/cc-2026-06-17-validation-loop]
- repid-engine-cc-zkp [feat/cc-2026-05-29-zkp-anchoring-closure]
- repid-engine-cc-zkpbind [feat/cc-2026-06-16-zkp-pin-agentbind]
- repid-engine-cc1-gate2 [feat/cc1-2026-06-11-hal-opinion-abstain]
- repid-engine-cc1-mainnet [feat/cc1-2026-05-27-fact-check-handler]
- repid-engine-cc2-fedmkt [feat/cc2-2026-05-26-marketplace]
- repid-engine-cc2-filters [feat/cc2-2026-05-27-llm-trust-multi-provider]
- repid-engine-cc2-onchain [feat/cc-2026-05-22-onchain-write-selffeedback-guard]
- repid-engine-cc2-verdict [feat/cc-2026-05-22-hal-x402-verdict-wiring]
- repid-engine-cc3 [feat/cc-2026-06-03-comma-deploy]
- repid-engine-cc4 [feat/cc-2026-06-03-r3-armtruth]
- repid-engine-cc5 [feat/cc-2026-06-03-r4-quorum]
- repid-engine-cc6 [feat/cc-2026-06-03-r5-resilient-quorum]
- repid-engine-cc7, repid-engine-cc96, repid-engine-cc1-gate2 … (remaining cc/cc1/cc2/cc3-7 + ga/ga3/ga4
  + xc3/xc4/xc5 + a2/b + redteam/redteam-r7/redteam-v2/redteam-v3 + reaper + merges + mvp + e1 +
  conservator + cors-fix + fix + claude-deferred + claude-genfix + integration-governance + verifyproof + xc)

> NOTE on completeness (A4): the **full** registered set is `git -C repid-engine worktree list` (63
> rows). Every entry not in KEEP above is a PRUNE-CANDIDATE pending a one-line merged/superseded check.
> Disposition rule for the follow-up cleanup sprint: `git -C repid-engine worktree remove <dir>` for any
> worktree whose branch is fully merged to `origin/main` (`git branch --merged origin/main`) AND has no
> dirty state (`git -C <dir> status --porcelain` empty). Dirty/unmerged worktrees are KEEP-until-reviewed.

## DISPOSITION: hyperdag-core worktrees [V]
KEEP: `hyperdag-core` (canonical). PRUNE-CANDIDATE (same merged-and-clean rule):
- hyperdag-core-a1 [feat/cc-2026-06-10-zkp-aggregation-depth]
- hyperdag-core-b3 [feat/cc-2026-06-07-babybear-leaf-b3]
- hyperdag-core-cc-pin [feat/cc-2026-06-07-plonky3-pin]
- hyperdag-core-cc1 [feat/cc-2026-06-11-prover-redeploy]
- hyperdag-core-cc2-env [feat/cc-2026-06-11-envelope-salt-seal]
- hyperdag-core-cc2-let [feat/cc-2026-06-11-letter-commitment-bind]
- hyperdag-core-pin-clean [feat/cc-2026-06-07-plonky3-pin-clean]

## VERIFY COMMANDS (for the follow-up prune sprint — NOT run here)
```
git -C repid-engine worktree list
git -C repid-engine branch --merged origin/main        # which worktree branches are safe
git -C repid-engine worktree remove <stale-dir>        # per safe candidate (NOT this sprint)
git -C repid-engine worktree prune                     # clean stale admin entries
```

*No directory deleted this sprint. Railway primary, build path untouched.*
