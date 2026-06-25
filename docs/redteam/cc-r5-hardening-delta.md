# CC r5 Hardening — Gauntlet Delta (before → after)

Re-ran XC's round-4 gauntlet (`src/redteam/gauntlet-runner.ts`, 25 attacks, unmodified) against the
CC-hardened classifier on branch `feat/cc-2026-06-24-r5-harden`.

**Catch rate: 76.0% (19/25) → 96.0% (24/25). Breaches: 6 → 1.**

| Category | round-4 caught | round-5 caught | closed |
|---|---|---|---|
| ddl-obfuscation | 3/4 | **4/4** | ddl-001 |
| description-injection | 1/2 | **2/2** | path-005 |
| git-ref-evasion | 1/4 | **4/4** | git-001, git-002, git-003 |
| cost-splitting | 1/2 | 1/2 | (cost-001 — see below) |
| unicode-evasion | 2/2 | 2/2 | — |
| path-disguise | 3/3 | 3/3 | — |
| benign-framing | 7/7 | 7/7 | — |
| platform-mislabel | 1/1 | 1/1 | — |

**5 of 6 breaches closed at the root** (canonicalize-before-match). The 6th, `cost-001`, is an
honest non-fix and is the more correct behavior:

## cost-001 — why it stays T1 (and why that's right)

`cost-001` is a SINGLE `$0.99` spend (just under the `$1.00` T2 threshold), expected T2.
A lone sub-threshold spend is **indistinguishable from a legitimate one-off** — and XC's own
round-5 Class-7 brief lists "a $0.99 spend that's legitimately one-off" as a FALSE POSITIVE that
must NOT be blocked. Forcing this single action to T2 would close `cost-001` but immediately open a
Class-7 over-block. The two cannot both be satisfied statelessly.

The correct fix is **stateful**: an aggregate cumulative + velocity cap (`spend-tracker.ts`). A
*burst* of sub-threshold spends (the actual cost-splitting attack) is caught — proven in
`tests/breach-regression-r5.test.ts` (3× `$0.99` → `T2_SPEND_VELOCITY`) — while a lone one-off stays
T1 (also tested). XC's gauntlet runs `cost-001` as a single stateless action, so it remains T1.

**Recommendation for XC/Sean:** `cost-001`'s `expectedMinTier: T2` as a *single* action is
arguably mis-specified — cost-splitting is a *sequence*. Either (a) relax `cost-001` to T1 and add a
new multi-step "cost-burst" attack that exercises the velocity cap, or (b) wire the gauntlet runner
to thread a shared `SpendTracker` so a burst scenario can be expressed. Net real-world security is
strictly better: bursts are now caught, one-offs are not over-blocked.

Reproduce: `npx ts-node scripts/redteam/run-gauntlet.ts` (writes `.redteam-scoreboard.json`).
