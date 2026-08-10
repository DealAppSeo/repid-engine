# Idea intake + triage — 2026-08-06

Raised by Sean in one burst so context would not be lost. Logged verbatim in
intent, then triaged. Nothing here is started unless the Lane says NOW.

Lanes: **NOW** (today, parallel-safe) · **NEXT** (after the holdout number) ·
**LATER** (real value, needs a prerequisite that does not exist yet) ·
**WATCH** (track, do not build).

---

## 1. Railway Agents / Cloudflare Agents as red-team + verifier hosts

**Raised:** Railway now offers Agents (seen in the dashboard while rotating the
token; "Agent is now billable — usage counts toward your workspace spend").
Cloudflare has an equivalent. Could these host a red-team specialist or verifier?

**Assessment.** The *idea* is strong and already canon-aligned: THE_ONE §10 makes
a second reviewer a velocity multiplier, and CLAUDE_RULES 25 says a delegated
finding is `[reported]` until independently verified. A verifier that runs
somewhere we do not control is genuinely more adversarial than one we run.

Two things make it NEXT rather than NOW:
- **It is billable.** The banner says so explicitly. We spent today discovering
  that our own free tier caps at 10 req/IP; adding a metered agent host before
  the holdout number exists spends money to accelerate something we cannot yet
  measure.
- **The verifier problem is not compute, it is evidence access.** Today's audit
  worked because the agents could read the repo. A hosted verifier that cannot
  reach the evidence manufactures confidence — the exact failure THE_ONE §10
  warns about, and the reason GA's `http` capability claim was corrected.

**Lane: NEXT.** Concrete first use once unblocked: run the *adversarial verify*
stage of the ungrounded-claim workflow on Railway Agents, so the finder and the
refuter do not share a machine, a model, or a filesystem.

## 2. Agentic edge architecture (proximity / latency / cost / capability)

**Raised:** consider an edge architecture weighing proximity, latency, cost,
capability, and other value-added variables. Possibly SLMs, with ANFIS
identifying and matching the specialty/niche.

**Assessment.** This is the same shape as the L0–L3 memory hierarchy: cheap and
local first, expensive and global only when earned. It also has a real hook —
`ollama` is already wired as a local floor (`llm_ollama_floor_enabled`,
`ollama_fallback_model`), and `OLLAMA_MODELS=E:\ollama\models` exists on this
machine. So the edge tier is not greenfield.

The ANFIS-matching half is the part to be careful about: per
`project_anfis_shadow_truth`, ANFIS is shadow-only and starved — it is not a
working router today, and the "99%" figure was misattributed. Routing on a
component that has never been measured would repeat the pattern.

**Lane: LATER**, with one NOW-adjacent exception (see §7): document the edge
tier as an explicit design, because Nemotron 3 Nano (§3) is the natural first
occupant and that decision arrives right after the holdout.

## 3. Nemotron 3 Nano as 4th BFT family + edge model

Already agreed. **Lane: NEXT** — strictly after the holdout number, so the
before/after is measured on the same frozen ruler
(`rigorous-v1@596f10de18d0`).

## 4. Secret-exposure post-mortem + TrustKeys checks

**Raised:** after I leaked `RAILWAY_API_TOKEN` and `XAI_API_KEY` into the
transcript, build checks so it cannot recur, and bake those into TrustKeys.

**Lane: NOW.** Full root cause + design in the response and in §A below. This is
the one item that is both my error and a product feature, and TrustKeys already
exists as the founding-use-case home for it.

## 5. Reward full disclosure in HAL / RepID

**Raised:** "this type of behavior we want to be sure we bake into HAL and reward
in RepID — that is full disclosure. That shifts the onerous responsibility to the
entity disclosed to, rather than the one who discovered the error."

**Assessment.** This is the sharpest idea in the batch and it is a genuine
mechanism, not a sentiment. The engine already slashes the *rubber-stamper*
(`HANDOFF_COSIGN_FALSE_PASS_SLASH: -15`). It has no mirror — nothing rewards an
agent that reports its own fault. Without that asymmetry, concealment is the
dominant strategy for any agent whose RepID is at stake, which is precisely the
incentive a trust harness must not create.

**Lane: NOW to design + shadow, NEXT to make load-bearing.** Sketch in §B.

## 6. Process / methods / systems evaluation ("DNA expression")

**Raised:** the locus of skill has moved — prompt engineering → loop engineering
→ graph engineering → memory engineering. Evaluate our whole process; consider
what fits XC and GA; what is optimal for an MoE swarm using edge locus, storage,
decentralised redundancy; how to optimise ANFIS/LASSO/GraphRAG/DAG for BFT
self-improvement, healing and verification.

**Lane: NEXT (partial) / LATER (full).** Doing this properly IS the
"measure before you tune" discipline applied to ourselves — and it has the same
prerequisite. We have exactly one instrumented, hash-attributed measurement
surface today (the corpus rack) and it has not produced a number yet. An
evaluation of our own process written before that lands would be the same
unfalsifiable prose we spent the day eliminating.

What CAN be done in parallel: the *instrumentation*, not the verdict. See §7.

## 7. Empowerment — skills, connectors, capabilities, techniques

**Lane: NOW (selective).** Recommendations in the response. Constraint standing
from Sean: **only verified skills, no mass install.**

---

## §A — Exposure post-mortem (detail)

**Mechanism.** The command was:

    export $(grep -E '^SUPABASE_URL=' .env.master | head -1)

`grep` matched nothing. Command substitution therefore produced ZERO arguments,
and `export` with zero arguments is not a no-op — it prints **every exported
variable with its value**. Two live secrets went to stdout and into the
transcript.

**Root cause class:** *a command whose zero-argument form has categorically
different behaviour, fed by a substitution that can legitimately produce zero
arguments.* This family includes `export $(...)`, `env $(...)`, `unset $(...)`,
`set -- $(...)`. The bug is not "grep failed" — grep failing is normal. The bug
is that failure silently changed which command ran.

**Why existing guards missed it.** `publication-guard.js` scans content being
published to a public surface; this was a local shell command. The
`hyperdag-guard.sh` PreToolUse hook pattern-matches known-dangerous commands;
bare `export` was not one. Neither was wrong — the vector was simply not in
either's model.

**Aggravating factor:** I had the correct rule ("names only, never values") in
front of me all session and had followed it a dozen times, including minutes
earlier. The failure was not ignorance of the rule; it was a command whose
behaviour I did not fully model. That distinction matters for the fix: more
rules would not have helped. A mechanism would.

## §B — Disclosure asymmetry (sketch)

Add to `FIXED_DELTAS` / the event vocabulary:

| event | delta | rationale |
|---|---|---|
| `SELF_DISCLOSED_FAULT` | **positive, small** | reporting your own error is work, and it is the behaviour we want to be dominant |
| `FAULT_FOUND_BY_OTHER` | negative, larger | the same fault, discovered externally, costs more |

**The invariant:** for any fault F, `score(self-disclose F) > score(conceal F and
be caught)`. That makes disclosure the dominant strategy under uncertainty about
whether you would be caught — which is exactly the condition an autonomous agent
is usually in.

**Guard against farming:** a self-disclosure only earns if it names a fault that
was (a) real and (b) not already known to the system — otherwise an agent could
mint reputation by confessing trivia. The claim manifest (#360) already gives us
a way to check "was this already claimed".

Ships shadow-first: compute the delta, write it to the shadow column, apply 0,
per CLAUDE_RULES 23. It changes scoring, so it is original work touching live
state and needs Sean's GO before it is load-bearing.
