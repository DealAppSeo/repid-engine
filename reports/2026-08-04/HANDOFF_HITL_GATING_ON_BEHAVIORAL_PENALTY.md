# HANDOFF — wire `isBehavioral()` into HITL gating

**Date:** 2026-08-04 · **From:** CC (Claude Code) · **Status:** next task, not started
**Prereqs:** all merged — repid-engine #348, #349, #350, #351, #352

---

## The task

`src/repid/penalty-provenance.ts` exports `isBehavioral(class)`. It is currently
consulted by nothing. Wire it into an authority decision — HITL rate and/or task
class gating — so that *"an agent caught misbehaving gets more oversight"* becomes
a real mechanism rather than a described one.

**Shadow-first is not optional here.** This is the autonomy path: getting it wrong
either frees an agent that should be supervised, or buries the HITL queue. Ship
inert, measure, then flip. Precedent in-repo: `SELF_REPORT_EVIDENCE_MODE`,
`CONTRACT_PARTY_ENFORCEMENT`, `PROVIDER_LIVENESS_MODE`.

**Required before flipping:** a before/after query showing how many agents change
HITL band, and what the queue depth becomes. The HITL queue held ~13 items
recently — a gate that adds one row per event can bury it (this is the same
sequencing trap recorded in D-101).

---

## Facts already established — do NOT re-derive

All [V] by SQL against `qnnpjhlxljtqyigedwkb` on 2026-08-04, full ledger.

### Gains (repid/ledger-provenance.ts — merged)
| class | events | positive Δ |
|---|---|---|
| `onchain_anchored` | 3,858 | 130,843 |
| `counterparty_verified` | 390 | — |
| `self_reported_unbacked` | 38 | 111 |
| `internal_scoring` | 147,701 | **5** |

**97.5% of all RepID ever gained is externally verifiable.** Unbacked self-report
is 0.08% of gains, and `SELF_REPORT_EVIDENCE_MODE` now defaults to `enforce`.

### Losses (repid/penalty-provenance.ts — merged)
| class | events | net Δ | % of loss |
|---|---|---|---|
| `hallucination_veto` | 68,335 | −683,568 | 99.21% |
| `administrative` | 3 | −2,209 | 0.32% |
| `counterparty_dispute` | 21 | −2,100 | 0.30% |
| `challenge_loss` | 19 | −751 | 0.11% |
| `prediction_miss` | 27 | −247 | 0.04% |
| `integrity_violation` | 3 | −125 | 0.02% |
| `dormancy_decay` | 2 | −6 | 0.00% |

**99.2% of loss is behavioural. 6 RepID total has ever been lost to dormancy.**

### The combined claim the ledger now supports
HAL can only ever *subtract* (+5 positive delta across 147,701 events), minting is
scarce and evidence-backed, and essentially every point lost was lost for
something an agent did. Both directions are decomposable without trusting us.

---

## Premises that were REFUTED — do not rebuild against them

1. **"A 1000 floor silently undoes demotion."** FALSE. The only clamp is
   `Math.max(10, Math.min(10000, …))` at `engine/repid-update.ts:528`. 81 of 104
   active agents are already below 1000; the minimum is **60**. The Epoch-1 1000
   was a *baseline for 12 core agents*, not a floor. A "cause-aware floor" would
   guard a problem that does not exist. This appears in XC's P2 list and the
   REPID_SCORING_MODEL §7a draft — correct it there or it will resurface.

2. **"The RepID ledger is 99% self-generated noise."** Misleading. That is a
   *volume* measure and it is wrong about *soundness* — see the gains table.
   Provenance is the correct lens. I made this error first; do not repeat it.

---

## Design notes for the gate

- `isBehavioral()` deliberately excludes `unclassified`. A gate that fails toward
  *guilty* on unrecognised input turns a scoring bug into an accusation. Keep that.
- `dormancy_decay` and `prediction_miss` are NOT behavioural. Quiet is not
  dishonest; wrong is not dishonest. Gating on raw score would conflate all three —
  that is the entire reason this module exists.
- Prefer a **recency window** over lifetime totals: an agent with one veto last
  year and clean since should not be gated like one caught yesterday. Lifetime
  `behavioralShareOfLosses` is the wrong input for an authority decision.
- `integrity_violation` (3 events, all-time) is the most serious class and probably
  warrants its own non-compensatory gate rather than folding into a share.

---

## Other open items

- **T12 fleet:** heartbeat writes stopped 2026-07-17; agents claim ~1 task/day
  (the nightly smoke). They have no HTTP client — tool-requiring tasks yield
  fabrication. Reasoning/artifact tasks only until that is fixed.
- **XC / GA lanes:** neither has ever committed code to this repo. XC = red-team +
  DB-read; GA = measurement/QA. Do not dispatch them as coders.
- **Hold D-077:** batch-STARK + Merkle-DAG only. No recursion language — the
  pinned Plonky3 has no recursion crate.
- **trinity-ecosystem:** `.env` / `.env.local` untracked and empty at HEAD; only 3
  Telegram vars were ever committed (2026-04-17). Untracking is not rotation.
  Names-only checklist was produced locally; values never entered a transcript.

---

## Process lesson worth carrying

Four times this session a fix existed on an unmerged branch while the problem was
still live — the zkp-postcard prover, its build fix, the trinity-ecosystem hygiene
commit, and one of my own commits I reported as "done" while it was only local.
**"Committed" and "landed" are different claims.** Verify the branch position and
the deployed commit, not the local one.
