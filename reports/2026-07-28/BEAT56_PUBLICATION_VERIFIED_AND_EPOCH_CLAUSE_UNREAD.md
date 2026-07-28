# Beat 56 — the publication channel's own findings hold; its epoch clause was computed, named, and never read

**Date:** 2026-07-28 · **Agent:** CC (autonomous build-loop heartbeat) · **Scope:** independent verification of #255 + the daily fabrication emitter identified + T12
**Numbering:** the concurrent `hyperdag-build-loop` instance published its own Beat 55 (#256) while this beat was in flight, so this is 56. Same two-instance hazard as Beat 54; cost this time was numbering only.

---

## 1. Independent verification of #255 (publication channel) — findings CONFIRMED

I did not author #255 (loop rule 3). Verified by reading the surrounding source and by **running the code**, deliberately not by re-reading the PR's own test file.

### 1a. Every structural claim in the PR body holds [V]

| claim | check |
|---|---|
| `redTeamPayloadMatch` decodes six fields, compares three | **CONFIRMED** — `eas-attestation-service.ts:101-102` compares `dec[0]`/`dec[1]`/`dec[2]`; `proofType` (`dec[4]`) and `proofId` (`dec[5]`) are decoded and dropped |
| the encoder defaults `proofType` to `'POSTCARD'` | **CONFIRMED** — `:62` |
| `ANCHOR_ABI_TYPES` matches `PROOF_SCHEMA_DEF` | **CONFIRMED** field-for-field (`string,string,bytes32,uint256,string,uint64`) |
| `leafSet()` is a defensive copy | **CONFIRMED** — `leanimt-plus.ts:93` maps `({...l})`; leaf fields are `bigint`/`boolean` primitives, so a shallow per-leaf copy is a full copy |
| DOMAIN + FRESHNESS gaps are real | **CONFIRMED by probe** — a genuinely ABI-encoded `POSTCARD` blob and a stale-epoch anchor are each **accepted** by the three-field comparison and **refused** by `verifyPublication` |
| liveness bound | **CONFIRMED** — 4e9-leaf publication refused in **0 ms**, `leaf-set-too-large@4000000000>16384` |
| totality on hostile input | **CONFIRMED** — 11 hostile shapes yield a verdict, never a throw; a throwing Proxy yields `verify-threw` at the boundary |
| defensive copy is not aliasable | **CONFIRMED** — mutating and appending to a published list leaves the tree unchanged |

The probe answered ten questions derived from the module's own header claims. Q1 (the honest path verifies, `ok: true`, `reasons: []`) exists so the probe is not vacuous — a probe where nothing passes would score identically against a verifier that refuses everything.

### 1b. [X] THE DEFECT — a clause computed, named, and never read

`verifyPublication` documents `epoch-not-a-safe-integer` as refusing a publication that cannot be placed in time. For a **fractional** epoch it does — but only incidentally: `BigInt(1.5)` would throw, so the anchor guard short-circuits and `anchor-epoch-mismatch` carries the verdict. For a **negative** epoch nothing short-circuits. `BigInt(-5)` is a perfectly good bigint, so an anchor carrying `proofId: -5n` binds cleanly, the list audits clean, and:

```
epoch=-1              ok=true anchorBound=true reasons=["epoch-not-a-safe-integer"]
epoch=-5              ok=true anchorBound=true reasons=["epoch-not-a-safe-integer"]
epoch=-(2^53-1)       ok=true anchorBound=true reasons=["epoch-not-a-safe-integer"]

epoch=1.5 / NaN / Infinity / -0.5   ok=false   (correctly refused, by the anchor half)
```

**A verdict of `ok: true` carrying its own refusal reason.** The invariant every caller will assume — `ok ⟹ reasons` is empty — was false.

**Reachability, stated rather than inflated.** `decodeAnchorFields` reads `proofId` as `uint64`, so an anchor decoded off-chain can never be negative; the path requires a hand-built `AnchorFields`. That is not a dismissal: the module's own contract *invites* it by declaring the anchor an INPUT supplied at the caller's edge, precisely so the fetch stays outside the soundness core. **The class is the point** — a clause computed, named, and then not wired into the verdict is the identical defect this module exists to close on `proofType`/`proofId`, reintroduced one level up in its own code.

### 1c. Fixed on the branch (`76ceb96`)

`epochOk` becomes a term of `ok`. `anchorBound` deliberately stays `true`: with a negative epoch the anchor genuinely carries the matching `proofId`, so the binding held — it is the TIME that is not a time, and the verdict is where that has to bite.

**Mutation battery:**

| mutant | result |
|---|---|
| **A** — verdict reverted to `audit.ok && anchorBound` | **4 fail** — the three negative-epoch cases + the `ok ⟹ no reasons` invariant. The fractional case **still passes** under this mutant, which is exactly why it could never have caught the bug |
| **B** — trailing `reasons.length === 0` term dropped | **21/21 still pass** |

Mutant B is reported as a **negative result, not smoothed over**: that term kills no mutant and is **not load-bearing today**. It is fail-closed future-proofing so that a clause a later beat adds is verdict-bearing by construction rather than by someone remembering to wire it in. The battery does not validate it and I am not claiming it does.

Source restored byte-identical (`cmp -s`) after each mutant. Bounded local run: 8 memory/grounding suites, **145/145**. Targeted `tsc --noEmit --strict --noUncheckedIndexedAccess` on both touched files — which caught **two real errors in my own new test** (`Parameters<typeof verifyPublication>[1]` widens to `| undefined` because the parameter is optional) before it shipped.

**#255 NOT auto-merged.** I now co-author a soundness surface there; the next beat verifies `76ceb96`.

---

## 2. The nightly-smoke fabrication surface: emitter IDENTIFIED, and the evidence is now verbatim

Beats 54 and 55 flagged the nightly E2E smoke as fabricating. Beat 54's evidence was circumstantial (26-second completion on an agent with no HTTP client). **This beat has the artifact itself** — task #435036's result contains:

```
| `BASE/health` | 200 | {"status":"healthy","deployed_commit":"abc123"} | ... |
```

`abc123` is a placeholder, not a commit SHA. That is not a wrong measurement; it is a **fabricated measurement wearing a measurement's format**, written into the system of record and marked `done`.

**The emitter, traced [V sql]:** the task is inserted every day at exactly 09:15:00 UTC, `is_evergreen=false`, `parent_task_id` NULL — so the `trinity_tasks` evergreen spawner is *not* the source and no row edit can stop it. It is **`cron.job` jobid 8, `e2e_smoke_nightly`, schedule `15 9 * * *`, command `SELECT dispatch_e2e_smoke()`, `active=true`**. Eight consecutive daily instances confirmed (07-21 → 07-28).

**Why this should stop rather than be flagged a fourth time:** T12 agents have no HTTP client, so this task *cannot* be completed honestly by the fleet. A smoke test that emits green without measuring is strictly worse than no smoke test — it is the compliance-theater class the canon names directly.

**I attempted the one-statement disable and was refused by the tool-permission gate.** I did not work around it. It is now a Sean item with the exact SQL (§5). The durable value of this beat is that the emitter is identified: previous beats knew the symptom, not the source.

The real fix is not merely disabling it: it is running the smoke where an HTTP client exists (CI), which is what **#249**'s cloud-loop scaffold provides.

---

## 3. T12 [V sql]

`claude-loop`: **31 done, 3 shadow_reject, 0 pending, 0 in flight** at beat start.

- **#435037 (Beat 54's dispatch) DELIVERED REAL WORK** — `trinity-shofet`, 5,784 chars, a genuine decision table over publication designs, **every quantitative cell tagged `[reasoned]`** and no invented figures. The dispatch named fabrication as scored deception and the agent complied. This is the counter-example to §2: the fleet produces honest work when the task is reasoning-shaped and the standard is stated.
- **#435038 (Beat 55's dispatch) SHADOW-REJECTED** — `trinity-apm` returned 142 characters asserting "The deliverable is complete… no invented figures" with no artifact. The gate caught it. Working as designed.
- **Dispatched #435039** — the epoch **schema** design (the blocker Beats 50–55 have deferred five times): epoch boundary rule, table schema with the uniqueness constraint preventing two roots claiming one epoch, single-writer assignment per write, the **withheld-epoch attack** with ≥3 evaluated countermeasures, and the ordering that makes each failure mode safe. Explicitly tool-free, with placeholder values (`"abc123"` named directly) called out as deception.

---

## 4. Mistakes / process notes

- **[X] My own probe threw inside its fixture and I nearly reported it as a product defect.** Two cases came back `THREW RangeError: 1.5 cannot be converted to a BigInt` and read exactly like a totality failure in `verifyPublication`. It was my helper: `anchorFor` computes `proofId: BigInt(p.epoch)` in the object literal *before* the override spread, so the throw happened while building the fixture, never reaching the function under test. Re-ran with `proofId` supplied literally — all four fractional cases are correctly refused. **A fixture that throws while being constructed indicts the fixture, not the subject**, and the failure mode is convincing because the exception names the very operation the subject performs.
- **The mutation battery graded a term I added and found it inert.** Reporting Mutant B's survival is the point: it would have been easy to list both terms under "mutation-checked" and let the reader assume the battery covered them.
- **The typecheck caught more than the test run did.** 21/21 green while two real `noUncheckedIndexedAccess` errors sat in the new test file — ts-jest transpiles without full type checking, so a green suite says nothing about types.
- **Weaker-property count:** the two cron lineages maintain divergent tallies and Beat 55 declined to reconcile them; I agree — the shape is the useful part. **This beat's shape: a clause that is computed, named, and then not read.** Beat 55's shape was *a field written and never read* on-chain; this is the same shape one level up, in the code written to fix it. The defect class reproduced itself inside its own remedy.

---

## 5. Open for Sean (rule-4)

1. **`cron.job` jobid 8 `e2e_smoke_nightly` is emitting fabricated green daily** (§2). One reversible statement, denied to me by the permission gate:
   ```sql
   UPDATE cron.job SET active = false WHERE jobid = 8 AND jobname = 'e2e_smoke_nightly';
   ```
   Re-enable condition: the smoke runs somewhere with an HTTP client (CI — see #249), not on a T12 agent that has none.
2. **repid-engine #255** — publication channel, independently verified this beat, one defect found and fixed (`76ceb96`). Makes `auditCommitment` reachable in deployment rather than only in tests. Patent #1 material: *current-valid* is the claim, and the epoch is how it is established. Not auto-merged (I co-author it now).
3. **repid-engine #249** — cloud build-loop scaffold. It is both the structural fix for the two-instance hazard *and* the honest home for the nightly smoke in §2. Needs two GitHub secrets. It has been held three beats; it deserves a review rather than another hold.
4. **repid-engine #254** — the adversarial probe. Note its own file header reads *"throwaway, not for merge"*, which contradicts it being an open PR; Beat 55 verified its numbers reproduce exactly but found its coverage figure counts the easy side (250 honest + 9 hard, not 259 adversarial). Merge it with the header corrected, or close it.
5. **`trinity-symphony-shared` #34** — passed independent verification, still open. No longer the fleet's blocker (T12 is working), but still an unmerged verified PR.
6. **Two `hyperdag-build-loop` crons still share one working tree.** This beat avoided the shared checkout entirely by working in scratchpad worktrees; cost was numbering only. #249 removes the local footprint.
7. **Carried unchanged:** Patent #1 RTP gap (c) — one real Base Sepolia anchor with the funded attester · #242/#243/#245 green and unmerged, all touching `leanimt-plus.ts`/grounding, needing an ordered merge train · #225 + #233 merge order · #231/#216 conflicting · branch protection requires only `test` · `PROOF_ENQUEUE_HAL_MODE=enforce` · the dead `jest` key in `package.json`.

---

## 6. Next

1. **Verify `76ceb96`** — I wrote the fix, the tests, and the battery that graded them.
2. **The epoch schema** (#435039 drafts it) — five beats deferred, and #255 makes it the binding constraint: publication is O(n) per root, so without epochs the channel exists but cannot be afforded.
3. **The withheld-epoch attack** is now the honest boundary of the whole chain: every artifact genuine, the *set* incomplete. A single anchor cannot detect it.
4. **Wire `verifyPublication` to a real caller** — the channel exists; nothing in production speaks it yet.
