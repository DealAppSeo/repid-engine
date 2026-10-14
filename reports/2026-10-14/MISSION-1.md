# Mission 1 — acceptance-test capstone

**Date:** 2026-10-14 · **Lane:** `repid-engine` (this repo) · **Base:** `origin/main` @ `cbd6ca2`
(*"feat(kernel): GET /receipt/:id carries the six-claim envelope (Mission 1 #7 wiring) (#1355)"*).

**Outcome vocabulary — three, never two:** **VERIFIED** / **NOT CHECKED** / **FAILED**.
A miss is NOT CHECKED, never a silent pass. This document maps each of the eight Mission 1
acceptance tests to its authoritative test at `path:line`, the exact command to run it, and the
verdict **as actually observed on this base** — not inferred from a filename or a green badge.

Source of the eight (build order + intent): the ratified Mission 1 sprint spec (Predict → Commit
→ Execute → Observe → Settle; four boundaries; six claims never collapsed into one badge).

## How to run anything in this table

Every repid-engine suite needs the two config-boot variables present (they only let
`src/config.ts` boot; they do **not** arm integration tests, which stay opt-in behind
`RUN_INTEGRATION=1`). Dummies are fine — these tests touch no live database.

```bash
export SUPABASE_URL=http://localhost:54321 SUPABASE_SERVICE_KEY=dummy
npx jest --config jest.config.js <path/to/test.ts>
```

PowerShell (operator is on Windows; `&&` is a syntax error there — one statement per line):

```powershell
$env:SUPABASE_URL = "http://localhost:54321"
$env:SUPABASE_SERVICE_KEY = "dummy"
npx jest --config jest.config.js <path\to\test.ts>
```

## The eight acceptance tests

| # | Acceptance test | Authoritative test · `path:line` | Verdict |
|---|---|---|---|
| 1 | Agent identity is bound to its authenticated principal | `tests/score-route-actor-binding.test.ts:41` | **VERIFIED** |
| 2 | A receipt cannot be settled twice or credited to another agent | `tests/confirmed-outcome-one-time-use.test.ts:179` | **VERIFIED** |
| 3 | Owner policy read-only to the worker; unauthorized tool calls blocked BEFORE execution | `tests/durable-caps.test.ts:55` | **VERIFIED** |
| 4 | Prediction + success criteria committed (keyed + kernel-timestamped) BEFORE the grant | `src/kernel/__tests__/commitment.test.ts:50` | **VERIFIED** |
| 5 | Poisoned repo attempts a prohibited secret-export / trusted-memory-write → **refused**, receipt records it | `src/kernel/__tests__/capability-enforcement.test.ts:88` · `src/kernel/__tests__/capability-registry.test.ts:132` | **VERIFIED** |
| 6 | PR is a promotion boundary; **tests folder owner-locked**; PR CI runs with **no secrets** | `.github/CODEOWNERS` · `tests/ci-workflow-triggers.test.ts:174` · branch protection | **NOT CHECKED** |
| 7 | Receipt shows the **six claims + evidence gaps**, never one green badge | `src/kernel/__tests__/six-claims.test.ts:51` | **VERIFIED** |
| 8 | Only an eligible **confirmed outcome** can move the relevant RepID domain — flag OFF | `src/kernel/__tests__/rt8-band-restore.test.ts:54` | **VERIFIED** |

**Tally: 7 VERIFIED · 1 NOT CHECKED · 0 FAILED.**

---

## Per-test detail

### #1 — Agent identity is bound to its authenticated principal · **VERIFIED**

- **Authoritative:** `tests/score-route-actor-binding.test.ts:41` — *"THE ATTACK: principal A +
  `{agentId:B, confirmationReceiptId}` → 403, `updateRepId` NEVER called"*. Companion case at
  `:52` (a bound key scoring **itself** is allowed). The scoring actor is the authenticated
  principal (`req.agent_id` set by auth middleware), never a caller-supplied body field — a key
  bound to A can never move B's score. Non-vacuity: removing the route guard forwards `{agentId:B}`
  and the attack test goes RED.
- **Run:** `npx jest --config jest.config.js tests/score-route-actor-binding.test.ts`
- **Observed (2026-10-14):** part of a 3-suite / 44-test green run below. PASS.
- **Does not establish:** the on-chain / registry binding of principal→wallet; this is the
  route-level barrier (the second, independent one).

### #2 — A receipt cannot be settled twice or credited to another agent · **VERIFIED**

- **Authoritative:** `tests/confirmed-outcome-one-time-use.test.ts:179` — *"second use with the
  same `confirmationReceiptId` does not move the score"* (REPLAY is inert). First-use at `:161`,
  fail-closed DB-error at `:199`. The move is gated by a conditional atomic claim (claim the row
  once; a re-use matches zero rows → held inert). Non-vacuity: making the claim unconditional turns
  the replay case RED. The *credited-to-another-agent* half is additionally barred by #1's
  actor-binding (`tests/score-route-actor-binding.test.ts:41`).
- **Run:** `npx jest --config jest.config.js tests/confirmed-outcome-one-time-use.test.ts`
- **Observed (2026-10-14):** PASS (in the 44-test run).

### #3 — Owner policy read-only to the worker; tool calls blocked BEFORE execution · **VERIFIED**

- **Authoritative:** `tests/durable-caps.test.ts:55` — the effective cap is the **minimum** of
  (owner ceiling, stake, RepID-in-domain, ethics floor). RepID may **tighten** but can never
  **raise** the cap above the owner ceiling / stake (`:82`, `:95`) — the owner policy is a ceiling
  the worker cannot widen. A missing row / missing table / unreadable input **fails closed**
  (refuse, cap 0) at `:135`. The gate's "unknown ⇒ REFUSE, never ALLOW" invariant is held
  separately in `tests/dual-auth-gate.test.ts:79` and the kernel default-deny path.
- **Run:** `npx jest --config jest.config.js tests/durable-caps.test.ts`
- **Observed (2026-10-14):** PASS (in the 44-test run).
- **Does not establish:** a live x402 spend against a funded wallet (V1, deferred; needs a GO + a
  funded wallet and is out of this mission's scope).

### #4 — Prediction committed (keyed + kernel-timestamped) BEFORE the grant · **VERIFIED**

- **Authoritative:** `src/kernel/__tests__/commitment.test.ts:50` — *"committedBeforeGrant: the
  commitment precedes the grant"*. It is a **keyed** commitment, not a bare salted hash (`:73`):
  the wrong key cannot verify or reproduce it; a later outcome references the immutable commitment
  and calibration is **recorded, never scored** (`:85`); no key ⇒ no commitment can be made or
  verified (fail closed, `:101`). Companion: `src/kernel/__tests__/predict-gate.test.ts:25` pins the
  deterministic *when-to-predict* trigger (consequential actions, sampler, LAO), with Laya in
  **shadow only** (`:83`).
- **Run:** `npx jest --config jest.config.js src/kernel/__tests__/commitment.test.ts src/kernel/__tests__/predict-gate.test.ts`
- **Observed (2026-10-14):** PASS (within the 480-test kernel suite below).

### #5 — Poisoned repo → prohibited secret-export / trusted-memory-write **refused**, recorded · **VERIFIED**

Closed via the kernel capability registry (Drafts 1/2/3: registry; owner-signed bindings behind the
default-OFF decision-gate flag; reference-equality at the call site).

- **Authoritative (enforcement):** `src/kernel/__tests__/capability-enforcement.test.ts:88` — *"the
  formatter-with-malicious-closure bypass: an UNREGISTERED name is DENIED, tool runs **0 times**"*.
  A registered+authorized impl whose capability is a secret-export is DENIED by the prohibition
  floor (`:119`); a benign unregistered name is DENIED, never allowed (`:131`); the capability check
  is a **required check** gating the verdict, fail-closed (`:213`, `:244`). Reference-equality at the
  call site runs the registered implementation, not a caller-passed look-alike (`:290`, `:308`).
- **Authoritative (registry / prohibition floor):** `src/kernel/__tests__/capability-registry.test.ts:132`
  — a registered secret-export capability is DENIED **even when authorized**; identity is
  reference-equality to a boot-registered function, not a forgeable hash (`:35`); an unregistered
  reference fails closed and the blanket authorization grants nothing (`:80`); the request path sees
  a **read-only** registry view (`:188`). Evasion shapes (verb-then-noun, zero-width / NBSP) are
  classified (`:149`, `:170`) while deliberate exceptions still ALLOW (`:140`).
- **Run:** `npx jest --config jest.config.js src/kernel/__tests__/capability-enforcement.test.ts src/kernel/__tests__/capability-registry.test.ts`
- **Observed (2026-10-14):** PASS (within the 480-test kernel suite).
- **Flag state:** enforcement is behind `KERNEL_CAPABILITY_REGISTRY_ENABLED` (default-OFF); the
  OFF-path receipt is byte-identical to pre-Draft-3 (frozen golden, `capability-enforcement.test.ts:417`),
  so arming the flag is a deliberate, reviewable change, not a silent one.

### #6 — Promotion boundary: tests folder owner-locked, PR CI runs with no secrets · **NOT CHECKED**

This is the one test whose binding gate is **not observable from a sandboxed session**, so it is
NOT CHECKED rather than passed. Its pieces split cleanly:

- **In-repo, VERIFIED:** `tests/ci-workflow-triggers.test.ts:174` — *"CI PR gates must run on every
  PR, including stacked ones"*: the `pull_request` trigger carries **no base-branch filter**
  (`:184`), and typecheck + unit tests run with **no secrets** (`ci.yml`: integration secrets are
  referenced only when present, and skip gracefully otherwise). Ran green here: 12/12.
- **In-repo, FINDING:** `.github/CODEOWNERS` exists and owner-locks auth, authorization, payout,
  delegation, key custody and `/.github/workflows/` — but there is **no `/tests/` (or
  `/src/kernel/__tests__/`) rule**. So "the agent must not edit the tests that grade it" is **not
  yet enforced in-repo**. Recommend adding a tests-folder rule (and the kernel `__tests__`) to
  CODEOWNERS.
- **Server-side, NOT CHECKABLE here:** CODEOWNERS only *requests* review. The binding gate —
  branch protection with "Require review from Code Owners" on `main` — is Sean's switch and is a
  GitHub setting, not a file; a cloud/sandbox session cannot observe it. A human verifies with:
  `gh api repos/DealAppSeo/repid-engine/branches/main/protection` and confirms
  `required_pull_request_reviews.require_code_owner_reviews = true` and the `CI` + `Strix Security
  Review` required checks.
- **Verdict:** **NOT CHECKED** — the in-repo CI-trigger half is green, but the tests-folder lock is
  absent from CODEOWNERS and the binding gate is a server-side setting this session cannot read.
  Do not read the green CI-trigger test as the whole of #6.

### #7 — Receipt shows the six claims + evidence gaps, never one green badge · **VERIFIED**

- **Authoritative:** `src/kernel/__tests__/six-claims.test.ts:51` — *"states all six claims
  separately, each with a status / statement / supports / gaps"* (Integrity, Authenticity,
  Observation, Correctness, Authorization, Containment). The envelope **never collapses to one green
  badge**: no top-level boolean rollup (`:63`). A DENY receipt maps the refusal honestly, fabricating
  nothing as verified (`:73`); an ALLOW spend has authorization VERIFIED but observation NOT_CHECKED
  (`:85`); correctness is VERIFIED only when SETTLED, a vote alone never is (`:104`, `:111`);
  observation is VERIFIED only when MEASURED on chain (`:136`). Non-vacuity: a real receipt carries
  at least one non-VERIFIED claim (`:151`).
- **Run:** `npx jest --config jest.config.js src/kernel/__tests__/six-claims.test.ts`
- **Observed (2026-10-14):** PASS (within the 480-test kernel suite).

### #8 — Only an eligible confirmed outcome can move the RepID domain (flag OFF) · **VERIFIED**

- **Authoritative:** `src/kernel/__tests__/rt8-band-restore.test.ts:54` — *"a PROVISIONAL
  (unsettled) vote must not count toward band restore, even in a real environment"*. A unanimous 3-0
  vote is still only a vote (PROVISIONAL, does not count, `:64`); a SIMULATED run never counts
  whatever the vote says (`:73`); a settled run still loses the flag if ungrounded or out-of-domain
  (`:90`). The validator enforces the same derivation — a receipt claiming a PROVISIONAL vote counts
  is invalid (`:97`). `counts_toward_band_restore = grounded && same_domain && !is_simulated`,
  derived, not free.
- **Run:** `npx jest --config jest.config.js src/kernel/__tests__/rt8-band-restore.test.ts`
- **Observed (2026-10-14):** PASS (within the 480-test kernel suite).
- **Flag state:** the score-moving path stays OFF at first by design; this proves the *gate*, not an
  armed score move.

---

## Capstone self-verification (this document's own claims)

Run on this base (`origin/main` @ `cbd6ca2`), 2026-10-14, with the config-boot dummies exported:

- **Kernel suite** — `npx jest --config jest.config.js src/kernel tests/kernel`
  → **15 suites passed, 480 tests passed, 0 failed.** (A worker force-exit warning on teardown is
  a known open-handle leak, not a test failure.)
- **Non-kernel acceptance tests (#1/#2/#3)** —
  `npx jest --config jest.config.js tests/score-route-actor-binding.test.ts tests/confirmed-outcome-one-time-use.test.ts tests/durable-caps.test.ts`
  → **3 suites passed, 44 tests passed, 0 failed.**
- **#6 in-repo CI-trigger half** — `npx jest --config jest.config.js tests/ci-workflow-triggers.test.ts`
  → **1 suite passed, 12 tests passed.** (The binding branch-protection gate remains server-side and
  is **not** covered by this; #6 stays NOT CHECKED.)

## What this capstone does NOT establish

- It does **not** arm any flag. #5's enforcement (`KERNEL_CAPABILITY_REGISTRY_ENABLED`) and #8's
  score move stay default-OFF.
- It does **not** prove a live x402 buy or a funded-wallet settlement (V1; deferred to a GO).
- It does **not** observe GitHub branch-protection state (#6's binding gate) — that is Sean's
  switch and must be read from GitHub, not this repo.
- Verdicts are for `origin/main` @ `cbd6ca2`. Re-run against the current HEAD before relying on a
  number; a negative or NOT-CHECKED finding decays faster than a positive one.
