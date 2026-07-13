# Cold-start premium routing — frontier-first for new sessions & testing (task 22)

**Sprint:** sprint-2026-07-12-ecosystem · **Lane:** routing (CC exclusive) · **Date:** 2026-07-12
**Branch:** `feat/cc-2026-07-12-cold-start-premium` · **Status:** code + tests, **no prod merge**,
master flag **default OFF** (kept off until XC verifies + Sean flips).
**Sequencing:** the shared router module (`src/providers/router.ts`) is also touched by task 21; this
change is independent (task 21 touches `internal-cron.ts` + a new re-tune service, no file overlap).

---

## Goal

Put the **best foot forward** for a new user, a new chat, or a testing session: route the **first N
questions straight to frontier/premium LLMs** (Tier-1: Anthropic/OpenAI). After the window, revert to
the normal **free-first-with-escalation** routing. **With reason:** when the ANFIS difficulty gate is
on, a trivially-easy question (classification / one-word / very short) is **not** sent to a frontier
model — Groq/Cerebras answer it just as well and a frontier call would be wasted.

## Config — all from `repid_config` (live, no redeploy)

Verified live 2026-07-12; resolved with the same DB → env → default precedence + TTL cache + fail-safe
as `src/hal/config.ts`:

| key | default | meaning |
|---|---|---|
| `cold_start_premium_enabled` | **`false`** | MASTER. While false the whole feature is inert. |
| `cold_start_premium_max_questions` | `3` | route the first N questions of a session to premium |
| `cold_start_premium_scope` | `new_user,new_chat,testing` | which session kinds qualify |
| `cold_start_anfis_gate` | `true` | when true, LASSO/ANFIS difficulty gate spares trivial questions |

## Implementation

- **`src/providers/cold-start-config.ts`** (new) — `getColdStartConfig()` config resolver. Reads only
  `repid_config`; never writes. Fail-safe: a DB error degrades to env → default (→ effectively
  "disabled", since the master flag defaults false). Cached (TTL, `COLD_START_CONFIG_TTL_MS`, 45s).
- **`src/providers/router.ts`**:
  - `RouteRequest.cold_start?: { scope, question_index }` — the caller states which cold-start bucket
    the request is in and its 0-based position in the session. Omitted ⇒ no cold-start (unchanged).
  - `RouteDecision.reason` gains `'cold_start_premium'`.
  - `shouldColdStartPremium(req, cfg)` — pure gate: master-off → scope not covered → past the N-window
    → **ANFIS difficulty gate** (`isLowComplexity`) → active. Returns a reason either way (observability).
  - In `routeRequest`, a **frontier-first block** runs after the ANFIS/static compute and BEFORE the
    SLM/tier-0 selection: if the gate is active it picks the first healthy, in-cap Tier-1 provider and
    returns `reason:'cold_start_premium'`. If **no premium provider is available it falls through** to
    normal routing — never worse than baseline.

## Safety / reversibility

- **MASTER default OFF.** With `cold_start_premium_enabled=false` the block is fully inert — zero
  behavior change until Sean flips it. XC verifies first.
- The change is **additive**: an optional request field, one new decision reason, one new resolver
  module. Absent a `cold_start` context on the request, routing is byte-identical to today.
- All thresholds read from `repid_config` (phone/SQL controllable); the ANFIS gate is itself a config
  flag, so premium can be made unconditional (`cold_start_anfis_gate=false`) or difficulty-gated at will.

## Tests

`tests/cold-start-premium.test.ts` (10 green): gate logic (master-off, no-context, scope, N-window,
ANFIS-gate spares/【off】allows trivial) + config precedence (default / db-over-env / env / fail-safe).

## Caller contract (for XC / the API layer)

The router does not itself know "new user" vs "new chat" — the **caller supplies** `cold_start` on the
`RouteRequest`. The API/session layer sets `{ scope: 'new_user' | 'new_chat' | 'testing',
question_index: <0-based turn in session> }`. Wiring that at the request boundary is the follow-up once
the flag is greenlit.
