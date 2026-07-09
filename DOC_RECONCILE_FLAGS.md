# DOC_RECONCILE_FLAGS — 2026-07-08 (branch: feat/cc-2026-07-08-doc-reconcile)

These are stale/contradictory doc facts found during the doc-reconcile sprint that were
**NOT edited** because they need Sean's call (creating a new wrong number is worse than a
flag). Each entry gives the exact `file:line`, the observed problem, and the open question.

---

## FLAG 1 — repid-engine/CLAUDE.md: "SOPHIA RepID: 10,000 AUTONOMOUS"

- **Location:** `C:\Users\Cash4\repos\repid-engine\CLAUDE.md:112`
- **Text:** `- SOPHIA RepID: 10,000 AUTONOMOUS (cap). repid_earned: 19,157`
- **Two problems:**
  1. **Value drift** — the live `/api/v1/agents/minted` endpoint shows `trinity-sophia`
     `current_repid = 1087` (token `3747`), and STATE_OF_THE_SYSTEM records the Epoch-1 reset
     that recalibrated the 12 core agents to a **1,000** baseline. So "10,000" is no longer
     Sophia's current value.
  2. **Tier mislabel** — per the canonical 5-tier scheme in this same file, **10,000 is
     VETERAN (8,000–10,000), not AUTONOMOUS (5,000–7,999)**. The label "10,000 AUTONOMOUS"
     is internally inconsistent regardless of the value question.
- **Open question for Sean:** Is this line meant to state Sophia's *current* RepID (then it
  should be ~1,000 ESTABLISHED, per Epoch-1 reset + live endpoint) or the *cap / historical
  peak* (then it should read "10,000 VETERAN (cap)", fixing the tier)? Needs your intent
  before edit — this is the canon/project-rules file, left untouched.

---

## FLAG 2 — hyperdag-protocol/README.md: "54,789+ real reputation writes" vs engine's 70 lifetime on-chain writes

- **Locations:** `C:\Users\Cash4\repos\hyperdag-protocol\README.md:32` ("**54,789+ real
  reputation writes** (score events) recorded") and `:135` ("... 54,789+ attestations ...").
- **Discrepancy:** The engine's live `/api/v1/observability/onchain-stats` reports
  `lifetime_onchain_writes = 70` (verified 2026-07-08). 54,789 is ~780× larger, so these are
  almost certainly **different metrics** — 54,789 likely counts `repid_score_events` rows
  (off-chain score events), while 70 counts `erc8004_reputation_writes` rows (actual on-chain
  txs). README:32 even parenthesizes 54,789 as "(score events)".
- **Not edited:** guessing which number belongs where would risk a new wrong figure. Both
  numbers may be individually correct for their own metric; the risk is a reader conflating
  "reputation writes" (off-chain score events) with "on-chain writes/attestations".
- **Open question for Sean:** Confirm 54,789 = off-chain `repid_score_events` count (and is it
  still current?), and confirm the README wording should distinguish "score events" (54,789)
  from "on-chain reputation writes" (70) so the two aren't read as the same thing. The `:135`
  roadmap cell calls 54,789 "attestations" — if attestations == on-chain writes, that cell is
  inconsistent with the 70 lifetime figure. Needs your ruling on the intended metric labels.

---

## FLAG 3 — ~/.claude/CLAUDE.md: stale @-import of HYPERDAG_TRUE_NORTH_ROADMAP_v0.md (May 22) vs current HEAD roadmap

- **Location:** `C:\Users\Cash4\.claude\CLAUDE.md` — the CANON+STATE `@import` block imports
  `@E:/dev/living-docs/HYPERDAG_TRUE_NORTH_ROADMAP_v0.md`.
- **Problem:** That roadmap is dated **2026-05-22 (v0.5)** and appears superseded by a newer
  HEAD roadmap **`V1_E2E_ROADMAP_2026-07-06.md`**. The session loader is auto-importing the
  older execution roadmap on every session, which risks routing work against stale gates.
- **Not edited:** this is Sean's private global config (`~/.claude/CLAUDE.md`) — out of the
  three-repo scope and off-limits for autonomous edits.
- **Recommended Sean edit:** repoint the `@import` line from `HYPERDAG_TRUE_NORTH_ROADMAP_v0.md`
  to the current HEAD roadmap (`V1_E2E_ROADMAP_2026-07-06.md`), or add the newer file to the
  import set and mark the v0 roadmap superseded, so first-actions read current gates. Verify
  the exact HEAD filename/path on disk before repointing.
