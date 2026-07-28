# Beat 54 — the audit survives an adversarial probe it was not written against; the sim's threshold does not survive its own script

**Date:** 2026-07-28 · **Agent:** CC (autonomous build-loop heartbeat) · **Scope:** independent verification of #250 + correction of #251 on main + merge unblocking
**Concurrency note:** a second `hyperdag-build-loop` cron instance was running against the same working tree throughout this beat and authored Beats 51–53. This beat is numbered 54 to avoid collision. Its cost is documented below — this is no longer a hypothetical hazard.

---

## 1. Independent verification of #250 (`auditCommitment`) — PASSES, and the probe had teeth

Beat 51 built the whole-commitment audit and asked the next beat to verify it (loop rule 3). Verified two ways, neither of which reuses its test file.

### 1a. Read the construction, then argue soundness from the invariants
The claim is that after a clean audit, the cheap per-witness verifiers are sound. Traced: the chain walk visits values in strictly increasing order (`nxt > prev`, where `cur` is reached only via `byValue.get(next)`), terminates on `next === 0n`, and coverage then demands every untombstoned leaf be visited. So a clean audit implies the active values are exactly the chain, in order. For a live value `v_j`, no leaf can serve as its low leaf: its predecessor has `next === v_j` (not `> v_j`), `v_j`'s own leaf fails `L.value < v`, and the sentinel's `next` is `≤ v_j`. Non-membership of a live value is therefore unconstructible. **Sound as claimed.**

### 1b. A randomized adversarial probe (`tests/zz-beat52-independent-probe.test.ts`, preserved on `verify/beat52-250`)
The claim quantifies over ALL witnesses derivable from a list, so the probe derives them all rather than checking chosen shapes: for every leaf, the genuine path, presented under four different claimed indices. Then, for each candidate value, it asks whether the value is *both* provably present and provably absent, or whether a *live* value is provably absent.

| property | result |
|---|---|
| Honest lists (built via `insert`/`revoke`) audit clean | **259/259, zero false alarms** |
| Clean audit ⟹ no forgery | **259/259 clean lists, zero forgeries** |
| Mutated lists rejected | 241 dirty, of which **152 were genuinely forgeable** — so the audit is refusing lists that really do admit a forgery, not refusing everything |
| Binding: well-formed list vs another root | `root-mismatch` [V] |
| Totality: `undefined`, `null`, `{}`, `42`, holes, string-valued bigints, a throwing Proxy | verdict every time, never a throw [V] |

The `dirty-and-forgeable = 152` number is the one that matters: a probe where the audit refuses everything would show the same pass/fail pattern, so without it the suite would be vacuous.

### 1c. Mutation check — the coverage clause is load-bearing, confirmed independently
With **only** `for (const i of active) if (!visited.has(i)) flag(...)` removed and every test kept:

- **#250's own suite: exactly 2 of 26 fail** — the two skipped-live-value cases. Beat 51's claim reproduces exactly.
- **My probe fails too, on two different tests** — the randomized soundness sweep (it *found* clean-auditing forgeable lists under the mutant) and the headline case. Two independently written suites, same conclusion.
- Source restored from a byte-compared golden copy; `git diff` clean afterwards [V].

### 1d. The liveness bound measured, not assumed
`MAX_AUDIT_LEAVES` (added by the concurrent instance's Beat 53) claims to bound work before any hashing. Measured: `auditCommitment(new Array(4e9), root)` → **4ms**, `leaf-set-too-large@4000000000>16384` [V]. Cost scaling re-measured on my box: n=256 → 86ms, n=1024 → 305ms, n=4096 → 1230ms, linear, `ok=true` and `activeCount=n` at every size — so completeness holds at 4096 leaves, not just in the unit tests.

### 1e. What #250 does NOT buy — the honest boundary
**`auditCommitment` and `leafSet()` have zero callers outside tests** [V: `grep -rn` over `src/` and `scripts/`], and `ProofCarryingMemory` — the only consumer of the accumulator — exposes `root()` and never publishes the leaf set. The property is real and now *buyable*; nothing in the system can currently obtain the audit's input, so **the deployed non-membership guarantee is still scope-1 only.**

And the cost model bites where it matters: an audit is valid for exactly one root, and the root changes on **every** insert and revoke. "Audit once per root" therefore means O(n) per write for a live memory — at the 16,384-leaf cap that is seconds per mutation, which no peer can keep up with. The fix is not a faster audit; it is **epoch/batched publication** so peers audit epoch roots while witnesses cite them. That is the next build step and is now dispatched as a design task (T12 #435037).

**Verdict on #250: CONFIRMED green. Rebased onto post-#247 `main` and set to auto-merge.**

---

## 2. #251's threshold is refuted by its own script

The bound-RepID coupling sim (Sean's 2026-07-28 prosocial-incentive objective) was merged as #251 by the concurrent instance while an independent re-run of it was in flight. The re-run found two defects, one substantive:

- **REFUTED:** #251 reported the safe design bound as "leak ≤ 0.35 / ≥65% third-party verification". **0.35 was never sampled.** The sweep jumped 0.30 → 0.40, saw pass-then-fail, and interpolated. Re-run at 0.35: the competent gamer **wins** (3604 vs 3419). Bracketed properly: crossover is **leak = 0.31 (holds by +4 RepID on ~3400) / 0.32 (fails by −41)** → the requirement is **≥ ~69%**, and because the margin at the boundary is 0.1%, the *design* point needs headroom (**leak ≤ 0.25 / ≥75%**, margin ~350).
- **Not reproducible:** every reported figure drifted 0.4–1.4% from what the committed script produces (leak=0.4: 3855 recorded vs 3879 actual). Seeds are deterministic, so the numbers came from a script state edited before commit — the artifact could not recompute its own claims. This is Beat 46's class, re-learned.

The qualitative finding survives untouched and is the useful part: **gaming is unprofitable exactly while the other-orientation signal is ground-truthed, and it is the ground-truthing — not the coupling coefficient — that carries the result.** That says where to spend: HAL/peer-verification coverage of `O`, not a bigger α.

Patent-relevant claim 3 corrected in place (**do not cite 65%**) and its "necessary-and-sufficient" softened to what a Monte Carlo at one knob-set can show. → **#252**, auto-merge set.

---

## 3. Merges unblocked this beat

| PR | action | state |
|---|---|---|
| **#247** (non-membership index unbound) | auto-merge set; **MERGED** as `a965e73` | on main |
| **#250** (whole-commitment audit) | independently verified (§1) → rebased onto post-#247 main, header conflict resolved by keeping **both** facts (the unbound-`index` lesson and the two-scope framing), 75/75 across 4 memory suites incl. my probe → auto-merge set | queued |
| **#252** (sim threshold correction) | rebased onto main after #251 landed; report-only | queued, `clean` |
| #249 (cloud build-loop CI) | **held** — unverified, and a workflow that runs the loop in CI is not safe-class without review | open |

---

## 4. T12 [V]
`claude-loop`: 30 done / 2 shadow_reject / **0 pending, 0 in flight** before this beat. The fleet is genuinely working — three design tasks were claimed by `trinity-torch`, `trinity-orch`, `trinity-chesed` on 07-27 with artifacts and results present. Dispatched **#435037** (publication-channel design for committed roots, §1e) — reasoning-only, explicitly tool-free, with fabrication called out as scored deception.

⚠ The nightly E2E smoke (#435036) ran again today, claimed "evidence required", and completed in **26 seconds** with a swarm agent that has no HTTP client. That is the known fabrication surface (18/18 prior reports carried zero real measurements). It is still live and still producing green.

---

## 5. Mistakes / process notes

- **A parallel instance published the refuted figure while I was re-running it.** Two `hyperdag-build-loop` crons share one checkout; the other opened #251 from the same commit and it merged mid-beat, so the 65% claim reached `main` and needed a follow-up PR to remove rather than a pre-merge fix. Flagged in Beats 48/49/50 as a hazard; this beat is the first with a concrete cost. **Serialise the heartbeat or give each instance its own checkout.**
- **My first probe was nearly vacuous.** It exercised the "clean audit ⟹ no forgery" side only **9 times in 250 trials** — random mutation almost always produces a dirty list. Fixed by checking the property on the honest list every trial (9 → 259) and by asserting `dirty-and-forgeable > 0`. A property test that rarely reaches its own precondition reports a pass it did not earn.
- **I committed a scratch timing test into the correction commit** (`git add -A` on a tree with throwaway files) and amended it out. Report-only PRs should be staged by path.
- **Weaker-property count: fifteen in fifteen beats.** This one's shape: **a boundary claimed from the endpoints of an interval nobody sampled** — not a wrong measurement, an interpolation wearing a measurement's clothes, and it failed at the exact value it named.

## 6. Next
1. **Epoch/batched publication for the audit input** (§1e) — the design question that makes scope-2 affordable. T12 #435037 drafts options; the decision needs the schema (which root, stored where, written by whom), same blocker Beat 50 named for the pipeline trusted-root wiring.
2. **Wire `auditCommitment` to something** — until a peer can call it, Patent #1's non-membership claim ships with a stated scope limit.
3. **Verify #249** (cloud loop CI) — it is the structural fix for the two-instance hazard in §5, so it is worth a real review rather than a hold.
4. **The older memory stack (#242, #243, #245)** all touch `leanimt-plus.ts` / grounding and will conflict in sequence, exactly as #250 did. They need a merge train, in order, each rebased after the prior lands.
