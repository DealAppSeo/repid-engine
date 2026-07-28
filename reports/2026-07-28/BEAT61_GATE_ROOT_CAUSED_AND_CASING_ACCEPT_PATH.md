# Beat 61 — the shadow gate is fully attributable and rejected nothing for its quality; and #264's new counter is computed and never read

**Date:** 2026-07-28 · **Verifies:** repid-engine #264 (Beat 60), and Beat 60's #1 Sean-facing claim
**Ships:** this report + ledger. **Review posted on:** #264. **Dispatched:** T12 #435045.

---

## STEP 1 — Beat 60's shadow-gate claim reproduces exactly [V], then root-caused past it

Beat 60 told Sean, as item #1: *"the T12 shadow gate is not a quality signal … #435040 (0 `[reasoned]` tags) and #435041 (30, plus a genuinely strong artifact) were both `shadow_reject`, all three verdict columns NULL on every task. Anything in the loop's record that reads `shadow_reject` as 'the gate caught something' should be discounted **until the gate is attributable**."*

The measurement reproduces [V sql]: artifact `196628` (task #435041) is **12,673 chars carrying 30 `[reasoned]` tags** and its task is `shadow_reject`. Beat 59 had read the same task as "185 chars, pure meta-assertion" — it read `trinity_tasks.result` and never opened `artifact_url`. **Beat 60's correction of Beat 59 was right.**

**But the gate's code is readable — it is in a sibling repo already cloned on this machine, `trinity-symphony-shared/lib/ConstitutionalAgentV4.js`.** Three beats treated it as opaque and inferred from status columns. `validateSubstance()` (`:2311`) is 55 lines and decides in this order:

1. `template_placeholder_detected` — regex `/\[insert\s|\[INSERT\s|\[TODO|\[PLACEHOLDER|\[FILL_IN|\{\{|\}\}|<placeholder/i` over the **chat output**.
2. `output_too_short` — the output stripped of headings and fenced code, against `HAL_MIN_SUBSTANCE_CHARS` (**default 200**).
3. `success_criteria_unmet` — <30% word overlap with `success_criteria`.
4. `artifact_missing_or_empty` — **an existence check only.** It selects `content, content_preview` and tests for non-empty. **It never grades the artifact.**

And the decisions are recorded, per attempt, in **`substance_gate_events`** — a table with `failure_reasons text[]`, `char_count`, and four `signal_*` booleans. Beats 59 and 60 checked `verifier_verdict` / `tiebreaker_verdict` / `final_verdict` on `trinity_tasks`, found them NULL, and concluded unattributable. Those three columns belong to a different, unwired mechanism.

### Every rejection, with its exact recorded reason [V sql]

| task | agent | char_count | `failure_reasons` |
|---|---|---|---|
| #435038 | trinity-apm | 142 | `output_too_short: 142/200` |
| **#435040** | trinity-nexus | 11,685 | **`template_placeholder_detected: }}`** |
| **#435041** | trinity-hdm | 185 | **`output_too_short: 185/200`** |
| #435042 | trinity-gcm | 48 | `output_too_short: 48/200` |
| #435043 | trinity-hdm | 1,132 | *(passed)* |

**So Beat 60's conclusion is CONFIRMED and its diagnosis is REFUTED.** `shadow_reject` is indeed not a deliverable-quality signal — confirmed now at the source rather than by correlation, because the artifact is only ever existence-checked. But the gate is **not** unattributable and it does **not** fail to track a stated standard. It tracks its standard exactly. The standard simply was not the one the dispatches were written against.

Two consequences worth stating plainly:

- **#435041 was rejected for being 15 characters short of a 200-character floor.** Its 12,673-char artifact with 30 `[reasoned]` tags was never opened by the gate. The agent wrote its deliverable to the artifact and a pointer to chat, which is precisely the shape the gate discards.
- **#435040 — the anchor cost model Beats 57 and 58 both said the simulation could not supply — was rejected for containing `}}`.** `signal_artifact_passed=true`; the placeholder regex fired on a closing double brace inside a *symbolic cost model*, which is the one genre of document guaranteed to contain them. That is a false positive of the detector on legitimate mathematical notation, and the 12,309 chars are still sitting in `trinity_tasks.result`, unread.

**Correction to my own earlier hypothesis:** I first proposed the gate grades `result` length, and the aggregate refuted it — two `done` rows carry 64-char results (both have `claimed_by` NULL, i.e. never claimed by an agent, so never gated). The length rule is real but it is one of four clauses, and reading the source rather than fitting a curve to the statuses is what separated them.

---

## STEP 2 — [X] THE FINDING against #264: the field it added is not read by the verdict, and the one path where that matters flips to ACCEPT

Beat 60 asked for a second opinion on exactly one clause: *"the exact-match (non-case-folded) committer comparison, since it trades observations for identity safety and nothing measures how often real `agentId` casing varies."* The module's header states the trade as an unconditional guarantee:

> *"A casing mismatch therefore costs observations (→ toward refusal), never comparability (→ toward acceptance)."*

**Measured, not argued** — the module compiled standalone (its only import is type-only) and probed directly:

```
--- CONTROL: committer case MATCHES (evidence is in scope) ---
match  + requireObservation:true    ok=false reasons=[epoch-equivocation,stale-epoch] lag=35 other=0
match  + requireObservation:false   ok=false reasons=[epoch-equivocation,stale-epoch] lag=35 other=0
--- FINDING: committer differs ONLY in letter-case ---
folded + requireObservation:true    ok=false reasons=[no-usable-observation]  lag=null other=3
folded + requireObservation:false   ok=true  reasons=[]                       lag=null other=3
--- ASYMMETRY: the SAME module folds case on roots ---
root differs only in case           ok=true  reasons=[] lag=0 other=0
```

The evidence held in all four rows is identical and damning: a proven **equivocation** (two roots for epoch 5) and a root **35 epochs newer** than the one presented. With the committer cased identically, both fire. With the committer differing only in case, under the module's own documented opt-out, the verdict is **`ok: true` with an empty reason list**.

- **The guarantee holds under the default and inverts under the opt-out.** `requireObservation: true` → `no-usable-observation` → refuse, exactly as claimed. `requireObservation: false` → three well-formed observations are reclassified to `otherCommitterObservations` and absence-of-scope is treated as absence-of-evidence, which the opt-out defines as accept.
- **The asymmetry is real and confirmed in the same run.** `sameRoot` folds case (`0xAAAA` ≡ `0xaaaa` → no equivocation), because hex identifiers vary in case. The committer is hex-ish too and is not folded. One module, two rules, opposite directions.
- **This is the loop's recurring shape, for the fourth consecutive beat.** #264 *separated* `otherCommitterObservations` from `skippedObservations` and argued the separation carefully — *"one is noise, the other is somebody else's perfectly good anchor"* — and then **did not read the new counter in the verdict.** Beat 55: a field written and never read. Beat 56: a clause computed and never read. Beat 60: the credited clause was not the load-bearing one. Here: a counter added, justified, and omitted from the only expression that could act on it.
- **Not a live exploit.** `grep` confirms no consumer of `checkEpochFreshness` in `src`, `scripts` or `tests` outside the unmerged stack, and the default policy refuses. This is a soundness surface about to be wired, and its header states a property its own opt-out path does not have.

### The fix #264's own reasoning already argues for

Making `otherCommitterObservations > 0` verdict-bearing under `requireObservation: false` — i.e. *"I hold evidence, none of it in scope"* is **not** the claim *"I hold no evidence"* — is the same distinction the PR drew when it split the counters. It costs nothing in the default path and closes the accept path. Case-normalizing the committer is the other candidate and the PR's argument against it stands (folding invents an identity equivalence); the third option, documenting the conditionality, is the weakest and is what the header currently does *incorrectly* by asserting the unconditional form.

**Not shipped as a fourth stack layer.** #264 is already three deep (#260 → #262 → #264) and this is a judgment its author should make; posted as a review on #264 instead.

---

## STEP 3 — T12 [V sql], and a falsifiable test of Step 1

`claude-loop` at beat start: 33 done · 6 `shadow_reject` · 0 pending · 0 in flight. #435043 (Beat 60's dispatch) came back **`done`** — 14,475-char artifact, 21 `[reasoned]` tags.

**Dispatched #435045** — committer identity normalization and the migration against anchors already on chain: where to normalize (four placements, which is irreversible), whether the fold/no-fold asymmetry is principled, whether "evidence but none in scope" should be verdict-bearing, and a migration that cannot rewrite history. Ranked recommendation must state its own strongest counter-argument.

**The dispatch encodes Step 1 as a prediction.** Its output rules now name the two real rejection causes explicitly — ≥400 chars of substance **in the final chat response** (not a pointer), and **no double-brace sequences** — citing the two discarded artifacts by size. If the root cause is right, this passes; if it is rejected anyway, Step 1 is wrong and the recorded `failure_reasons` will say so.

**PREDICTION RESOLVED, same beat [V sql]: #435045 → `done`, `claimed_by = trinity-gcm`, `result` 519 chars.** The same agent whose 48-char pointer produced `output_too_short: 48/200` on #435042 cleared the gate on the next task, with the only difference being an instruction to write the substance into the response. That is confirmation of the mechanism, not merely of the correlation — and it means the six `shadow_reject` rows in this loop's record are a **dispatch-format defect, now fixed**, not six caught fabrications.

---

## MISTAKES / process notes

- **[X] I inferred a mechanism from statuses before checking whether the code was readable.** The "gate grades `result` length" hypothesis was half-right, fit to five data points, and refuted by the sixth. The gate's repo was cloned on this machine the entire time. Three beats reasoned around an opaque component that was two `grep`s away — *check whether the thing is readable before modelling it from its outputs.*
- **The attributability claim was falsified by one query.** `substance_gate_events` carries a `failure_reasons` array per attempt. Beats 59 and 60 checked three NULL columns on a different table and generalized to "unattributable". Absence of evidence in the first place looked at is not absence of evidence [rule 14].
- **What the probe bought over reading:** reading the diff, the exact-match clause looks obviously safe — every path it changes moves toward refusal. It is the *interaction* with `requireObservation:false`, a policy option decided elsewhere in the file, that inverts it. A second opinion by reading would have agreed with the header.
- **Weaker-property count / shape. This beat's shape: a distinction drawn, defended, and then not used.** #264 argued at length that out-of-scope anchors are categorically different from noise, gave them their own counter, and left the verdict reading neither. And Step 1 is the same shape one surface over — the gate records a precise reason for every decision, and three beats read the status instead.

---

## Open for Sean (rule-4)

1. **⚠ REVISED — Beat 60's item #1 was half wrong, and the revision is actionable.** `shadow_reject` is **not** a quality signal (confirmed at source: the artifact is existence-checked, never graded). But the gate **is** fully attributable via `substance_gate_events.failure_reasons`, and every rejection so far is `output_too_short` or `template_placeholder_detected` — **none is a judgment about the work.** No infra change needed; the fix is dispatch wording, applied in #435045.
2. **A recoverable loss, not a defect to file:** #435040's 12,309-char anchor cost model — the input Beats 57/58 said the simulation could not supply — is intact in `trinity_tasks.result` and was rejected for containing `}}`. Worth reading, not re-dispatching.
3. **`cron.job` jobid 8 `e2e_smoke_nightly` still emits fabricated green daily** (traced Beat 56; the permission gate denies me the disable). One reversible statement:
   `UPDATE cron.job SET active = false WHERE jobid = 8 AND jobname = 'e2e_smoke_nightly';`
4. **repid-engine #264** — verified; one finding posted (Step 2). The merge train is **#260 → #262 → #264** as one ordered set; merging any prefix ships the 100%-false-refusal behaviour.
5. **⚠ `strict: false` + only `test` required is still a loop-wide hazard** (Beat 57). `crosscheck` / `zkp-vault` / `gitleaks` run and are advisory.
6. **repid-engine #249** — reviewed Beat 57, merge-worthy and inert on merge.
7. **repid-engine #255** — still needs a verifier from a lineage that has not touched it.
8. **Carried unchanged:** Patent #1 RTP gap (c) — one real Base Sepolia anchor with the funded attester · #242/#243/#245 green and unmerged · #258 report-only, unmerged · #254's header still reads "throwaway, not for merge" · #225 + #233 order · #231/#216 conflicting · `PROOF_ENQUEUE_HAL_MODE=enforce` · the dead `jest` key in `package.json` · `trinity-symphony-shared` #34.

**Next beat:** (1) **#435045's normalization answer**, then the `otherCommitterObservations` verdict fix on #264's branch if its author has not taken it. (2) **Read #435040's recovered cost model** and use it — it answers the anchor-cadence question #258 proved the simulation cannot. (3) **Wire `current_memory_root`** once #255 lands: #258 says which root, #260 how fresh, #264 whose. (4) Merge-train #242/#243/#245.
