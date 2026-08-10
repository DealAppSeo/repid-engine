# Session handoff — 2026-08-09 → 08-10 (tooling eval, HAL experiment, lanes, repo drain)

**Why this file exists.** claude-mem was installed mid-session, and Claude Code loads hooks at
session *start* — so its capture hooks were never active here. `session_start_context` for
this project returns *"This project has no memory yet."* **Nothing from this session is in
claude-mem.** This file, the git history, and `reports/2026-08-09/` are the durable record.

---

## Merged tonight — 6 PRs, 0 open

| PR | what |
|---|---|
| #400 | calibrator was fitted on a run that no longer ships |
| #401 | one shared `LESSONS.md`, injected into every agent |
| #402 | lease **heartbeat** + machine-checked **lane definitions** |
| #403 | free frontier HAL member (nemotron-3-ultra-550b, default OFF) + golden-math retry-to-width |
| #404 | identity-token issuance (`hdg_byok_*`) + public-repo hygiene + session reports |
| #405 | consolidated **node record** (lease + capability + liveness) |

## Applied to prod `[V]`

`agent_node_registry` + `v_node_truth` in `qnnpjhlxljtqyigedwkb` (2026-08-10). Table at 0 rows,
RLS on, 0 policies (service_role only), 5 indexes, view `security_invoker = true`.

The security advisor flagged the view as **ERROR — SECURITY DEFINER** within seconds of the
create: it would have read the table with RLS *bypassed*. Fixed and re-verified. **Any future
view over that table needs the same line.**

---

## The three findings that matter most

**1. HAL's ceiling is partly a provider-availability artifact, not model quality.**
Across 16 eval runs: cerebras rate-limited on **71–90 of 99 cases in every run**; gemini and the
paid openrouter voter died on **HTTP 402** mid-experiment because the **OpenRouter balance hit
zero**. Last night's F1 (0.876–0.886) sits below the morning's (0.9078) *because providers died*,
not because HAL regressed. The two are not comparable numbers.
→ **Fix availability before running another lever experiment.** It is cheaper and bigger.

**2. The nemotron result is a null, and both runs are compromised.**
Order-balanced ABBA n=4: ΔF1 = **−0.0022** (p ≈ 0.63, CI [−0.016, +0.011]). An earlier
unbalanced design showed +0.019 — an artifact. Both runs ran on a credit-starved panel, and the
voter itself **timed out on ~1/3 of cases** against HAL's 12s cap (too tight for a reasoning
model under concurrency). The voter *works* ($0, correct, parseable, distinct family); its
effect on F1 is **not established**.

**3. The fence was built and never switched on.**
`lane-write-guard.js` was registered in `.claude/settings.json` the whole time, but
`.git/hyperdag-lane-leases.json` held `{"leases": []}` and `HYPERDAG_LANE` was unset in every
session — so it failed open on every write, by design. 50 sessions shared one working tree with
nothing allocating work.

---

## Corrections I had to make to my own claims

Logged because the pattern matters more than the individual errors — every one came from
trusting a cached field instead of the live source.

- **"~20 open PRs"** — read from the session records' cached `prState`. GitHub said **2**.
- **"Another agent is writing right now"** — inferred from one vanishing scratch file.
  `isRunning: false` on all 50 sessions, a clean tree, and a full filesystem scan all disagreed.
- **"The leaderboard fix is not on main"** — checked commit *ancestry*, not content. It was
  squash-merged, so the SHA is absent while the change is fully present.
- **"Order effect explains the +0.019"** — the groq asymmetry persisted with order balanced, so
  it was a *treatment* side-effect (a slow voter spaces out calls and shields fast free voters
  from rate limits), not position.

## Not done / still open

- **OpenRouter credit is at −$0.20.** `gemini` and the paid `openrouter` voter are 402-ing in
  **production** HAL, not just in evals. Cheapest unblock on the board.
- **Hetzner CAX21 not provisioned.** Everything always-on (OmniRoute, evidence cron, manager
  loop, node #0) is blocked on it. Oracle Free was rejected: capacity lottery + a **June 2026
  silent halving** of the ARM tier (4 OCPU/24GB → 2/12).
- **Lanes are defined but not issued.** No session sets `HYPERDAG_LANE`; the registry is empty.
- **Registry is a local file** — Railway/VPS/Grok/Gemini cannot see `.git/hyperdag-lane-leases.json`.
  Cross-surface lanes need `agent_node_registry` (now applied) as the backing store.
- **Provenance hook is in `shadow`** — logs, never blocks. Flip via
  `echo on > ~/.claude/hooks/provenance-check.mode` once its false-positive rate is read.
- **`src/services/**` is unleasable** as a flat 100-file directory. Breaking it into
  subdirectories makes each piece leasable for free — the real fix.

## Installed on the laptop

- **codegraph** v1.5.0 — telemetry off, MCP wired, repid-engine indexed
  (1,058 files → 11,043 nodes / 44,077 edges in 17.4s). For contrast, our own Graph-RAG store
  held 241 nodes / 154 edges after eight months.
- **claude-mem** v13.14.0 — telemetry off, provider **openrouter**, model
  `google/gemma-4-26b-a4b-it:free`. The vendor default (`xiaomi/mimo-v2-flash:free`) **does not
  exist** in OpenRouter's catalog; left alone every compression call would have failed.
- **Provenance guard extended** — recalled memory (`<claude-mem-context>`, `<observation>`) is
  stripped from the Stop hook's evidence pool. Without it, installing memory would have silently
  disabled the auditor: any stale recalled fact would have satisfied the "some tool produced it"
  test. Fresh tool output stays admissible; the line is recency-of-derivation.

---
*Verified against live Supabase, GitHub, and disk on 2026-08-10. Vendor capability claims are
`[R]`. `[V]` marks a tool result shown in-session.*
