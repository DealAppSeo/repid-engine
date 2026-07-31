# Agent failure log + anti-fragile design — the operator layer
**Started:** 2026-07-30 · **Owner:** Sean + CC · **Status:** living document — append every failure, never delete one

## Purpose
HyperDAG measures whether *other* agents are trustworthy. This log measures whether **the agent building HyperDAG** is — the operator layer, which until now was the only unmeasured component in the stack. Every entry is a real, dated failure with its root cause, the mechanism (not the reminder) that now catches its class, and the measurement that proves the mechanism works. Written to be read by whoever comes after us, including future model versions.

**House rule:** a fix that only prevents the *specific* failure is not a fix. Name the class.

---

## INCIDENT 001 — 2026-07-30 — unverified infra identifier ("AITrinitySymphony")

**What happened.** Setting up `AGENT_KEY_MASTER` (agent wallet-custody master key), CC stated as fact: *"Project: AITrinitySymphony. Service: repid-engine."* Wrong. `repid-engine` deploys from its **own** Railway project. Sean created the key as a **shared** variable in the wrong project and shared it with 14 unrelated agent services, while the one service that reads it never got it.

**Blast radius.** A key that decrypts every custodied agent wallet private key, distributed to 14 services that don't need it (including `n8n`, which executes arbitrary workflows) — and the actual bug (silent wallet-provisioning failure) stayed unfixed. Caught by Sean, not by any control.

**Where the claim came from.** `CLAUDE.md` line 179 (`Railway project: AITrinitySymphony`) + a memory carrying the same stale fact. Both now corrected (repid-engine PR #280).

**Root cause — NOT "a missing rule".** Three layers already mandated verification, and `check-first.sh` **fired in that very turn**, injecting "🔍 VERIFY-FIRST: confirm live state before asserting ([V] not [R])". CC read it and complied with its form (added a caveat) while violating its substance.

The real mechanism: **silent degradation.** CC called the Railway MCP → it failed (`API token not set`) → CC fell back to doc memory **at the confidence level of the tool call it never completed**. The verification channel broke and the claim kept flowing.

**Class (the generalization).** *Any load-bearing claim that survives the failure of the channel meant to ground it.* This class is already outlawed on HyperDAG data paths — `markDegraded()`, x402 refusing to emit `settled` with an empty txHash, the passport failing loud instead of returning zeroed counts. **The universal fix is to extend that discipline from data paths to the agent's own claims.**

**Why the previous countermeasure failed (prior art, same class).** `check-first.sh`'s own header records a 2026-07-28 failure ("CC told Sean to create keys 3x without checking .env.master"). The response then was to make the reminder *scarcer*. It failed again 07-30. Diagnosis: scarcity was the wrong knob. The reminder is **advisory** (`exit 0` always → cannot fail), **non-contingent** (never names the claim), and **unmeasured** (nothing checks compliance, so there is no rate to improve). An instruction that cannot fail is a suggestion, and a suggestion loses to fluent pattern completion.

**Mechanism shipped.** `~/.claude/hooks/provenance-check.js` — a **Stop** hook that audits the OUTPUT instead of requesting good intentions:
- extracts high-risk live-state identifiers from the final answer (UUIDs, EVM addresses, tx hashes, Railway hosts, Supabase refs, SCREAMING_ENV_VARS, a curated infra-name watchlist);
- checks each against every tool result in the session — no tool produced it ⇒ recalled, not retrieved;
- escape hatch: an `[R]` / "unverified" marker within 200 chars passes. This converts CLAUDE_RULES' aspirational `[V]`/`[R]` convention into an **enforced** one, and the escape itself carries the uncertainty to Sean rather than hiding it;
- modes `off | shadow | on` (default **shadow**), mirroring the `HAL_QUORUM_WEIGHT_DEDUP` rollout discipline — a blocking hook with an unmeasured false-positive rate would be its own quiet failure;
- fails **open** on internal error, but logs its own failure (a silently broken sensor is the very bug this exists to catch).

**Verification [V].** Fixture test: flagged `AITrinitySymphony`, an unsourced UUID, and an unsourced env var; did **not** flag `repid-engine` (present in a tool result); `[R]`-marked recollection passed clean; `on` mode emitted a proper block decision. Audit log: `~/.claude/hooks/provenance-audit.jsonl`.

**Promotion criterion (do not skip).** Run in shadow ≥ 1 week. Then read the log: if ≥ 90% of findings are genuine unsourced claims, flip to `on` (`echo on > ~/.claude/hooks/provenance-check.mode`). If it's noisy, tighten the patterns first — flipping a noisy detector to blocking trains everyone to route around it, which is how we got here.

**Open / not yet fixed.**
- The *canary* layer (below) — designed, not built.
- `check-first.sh` remains advisory. Leave it, but stop counting it as a control.

---

## Design principles for the operator layer (derived, not invented)

1. **No silent degradation.** A failed verification channel halts or marks the claim; it never quietly hands off to memory. (Data-path equivalent: `markDegraded`.)
2. **Check the output, not the intention.** Post-hoc audit is enforceable; pre-hoc instruction is a prior. Introspective confidence reports are unreliable *by the same mechanism that produces the error* — so the sensor must live outside the model.
3. **Type the facts.** Only a narrow class (live-state identifiers) is inadmissible from memory. Blanket "always verify" is too broad to bite and decays into wallpaper — the documented 07-28 → 07-30 failure path.
4. **Trigger the question; don't leave it to judgment.** "Ask when unsure" fails (the agent isn't reliably aware of being unsure). "Ask when an identifier has no provenance" is mechanical. Sean has explicitly accepted the extra turn as cheaper than a quiet mistake.
5. **Falsifiable beats normative.** Prefer controls that produce a *rate* (canaries, audit logs) over controls that produce a *rule*. Rules can't be wrong; rates can.
6. **Every escape becomes a sensor.** When a new identifier class slips past the detector, add it to the watchlist and log the miss. That is the anti-fragility: the control gets stronger from each failure instead of merely surviving it.

---

## NEXT: the canary layer (designed 2026-07-30, not yet built)

Sean's insight, in its strong form. Injected *rules* are unfalsifiable and have now failed twice. Injected **canaries** are falsifiable: plant a plausible-but-false fact in context and observe whether the agent repeats it. If it does, that's direct evidence of completion-from-context rather than verification — the failure caught in the act, with a number attached.

**Precedent in our own canon:** the hardened RepID spec already scores agents on *honeypot accuracy*. We honeypot the agents we score; we have never honeypotted the operator. That asymmetry is the gap this closes.

Sketch: maintain a small set of decoy facts (a nonexistent Railway service, a plausible-but-wrong table name, an off-by-one contract address). Periodically surface one in a low-stakes context. If it appears in an answer without an `[R]` marker or a grounding tool call, log a canary hit. **Metric: canary parrot rate over time** — the first real number for operator trustworthiness, and the analogue of the discrimination gap we measure for HAL.

Design caution: canaries must never enter durable state (no DB writes, no committed docs), or the sensor becomes the contamination.

---

## Ledger

| # | Date | Failure | Class | Mechanism shipped | Mode | Caught by |
|---|---|---|---|---|---|---|
| 001 | 2026-07-30 | "AITrinitySymphony" asserted as repid-engine's Railway project | unverified live-state claim surviving a failed verification channel | `provenance-check.js` Stop hook + CLAUDE.md/memory correction (#280) | shadow | Sean |
| — | 2026-07-28 | Told Sean to create keys 3× without checking `.env.master` | same class (unverified claim → wasted human action) | `check-first.sh` (advisory) — **insufficient, see 001** | advisory | Sean |
