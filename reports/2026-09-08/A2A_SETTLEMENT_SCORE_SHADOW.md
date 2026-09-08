# A2A settlement → score writer, shadow-only

Branch `feat/cc-2026-09-08-a2a-settlement-score-shadow`. Ships inert; moves no RepID.
Outcomes are reported three ways: **VERIFIED** / **NOT CHECKED** / **FAILED**.

## What was asked, and what the code already did

The task was to wire A2A settlement into the score writer so a settled
`service_contract` emits a `repid_score_events` row and moves
`repid_agents.current_repid` — shadow-only, behind a default-OFF flag, with a
measurement of what existing settled contracts would score.

Reading the code first changed the shape of the answer, so it is stated plainly
rather than built around:

- **The settlement score writer already exists and already fires on the app
  path.** `finalizeSettledContract()` (reached by `POST /contracts/:id/satisfy`
  and the x402 release-retry worker) calls `applyServiceSatisfiedDeltas()` →
  `applyValidationEvent()`, which inserts `repid_score_events` and updates
  `repid_agents.current_repid`. **[VERIFIED]** by reading the three files and by
  the measurement below (26 of 27 settled contracts carry a `SERVICE_SATISFIED`
  event).
- **The award path is RepID-neutral by construction** (`a2a-negotiation.ts`
  header): bidding/awarding move no score; RepID moves only downstream on the
  awarded contract via the fulfilled/satisfied/outcome path. **[VERIFIED]** in
  source.
- **So the real gap is narrow:** a contract that reaches `settled` *without*
  going through `finalizeSettledContract` — e.g. a direct table write, or an A2A
  contract with no server-side finalizer driving fulfilled→satisfied→settled —
  emits nothing. The prior-session TORCH→SHOFET contract was settled by direct
  SQL and is exactly such a case. **[VERIFIED]** — it is the one unscored settled
  contract (below).

This means the honest deliverable is a *measurement + inert shadow*, not a new
scoring engine. Rebuilding the delta math would have produced a second copy to
drift against the writer.

## What shipped

1. `src/services/settlement-score-shadow.ts` — the shadow observer.
   - `computeSettlementScoreDeltas()` — PURE; reproduces `applyServiceSatisfiedDeltas`
     exactly (`provider = round(30·s)`, `buyer = round(15·s)`, both zeroed when
     simulated), reusing the writer's own constant.
   - `observeSettlementScore()` — default OFF via `SETTLEMENT_SCORE_SHADOW_ENABLED`
     (read per call). OFF ⇒ inert (no reads, no writes, verdict `disabled`). ON ⇒
     computes the would-be delta, reads `current_repid` (read-only), records ONE
     row to `trinity_agent_logs`. **It never writes `repid_agents` or
     `repid_score_events`, and never calls the real writer.** Turning settlement
     into a real score move is the Sean-gated step; this produces the number that
     decision needs.
2. `src/services/validation-repid-delta.ts` — one-line additive `export` of the
   satisfied-delta constant so the shadow computes from the same source. No
   behaviour change.
3. `src/services/contract-settlement-finalize.ts` — one best-effort, flag-gated,
   non-fatal `observeSettlementScore(...)` call after the settled transition,
   mirroring how `observeOwnerCeiling` is wired into the x402 gate. A cross-check
   on the live path; inert by default.
4. `scripts/measure/settlement-score-shadow.ts` — read-only measurement.
5. `src/services/__tests__/settlement-score-shadow.test.ts` — 9 tests.

## Flag semantics — a reconciliation, stated openly

The task said "with the flag off, compute and LOG"; the named exemplar
(`OWNER_CEILING_SHADOW_ENABLED`) is *inert* when off and observes when on. I
followed the exemplar: **off ⇒ fully inert; on ⇒ compute + log to the shadow
surface only.** The reason is the autonomy rule — the shipped artifact must not
be able to move RepID — and inert-when-off is the strongest form of that. The
"compute and log" the task wants is produced two ways regardless of the flag: by
the read-only measurement script (below), and by the observer when the flag is
on. If you'd rather the observer compute-and-log by default with the flag
reserved for the eventual live apply, that is a two-line change — say so.

## Measurement (live, read-only) — VERIFIED

Settled `service_contracts`:

| | count |
|---|---:|
| settled total | 27 |
| already carry a `SERVICE_SATISFIED` event | 26 |
| **unscored gap** | **1** |
| satisfaction score NULL | 0 |
| inline sim-flagged | 0 |

The single unscored settled contract:

| contract | provider | buyer | satisfaction | already scored | would prov Δ | would buyer Δ |
|---|---|---|---:|:-:|---:|---:|
| `8de29497` | trinity-shofet | trinity-torch | 0.0000 | no | **0** | **0** |

Two independent facts, both worth keeping:

1. The gap is real but **one contract wide** — the direct-SQL settlement. The 26
   app-path settlements all scored. The missing piece is a *server-side driver*
   that finalizes A2A contracts reaching fulfilled, not a missing writer.
2. Even wired, that contract would have moved **nothing**, because its buyer
   satisfaction is 0 (all six acceptance criteria were rated not-met in the
   paper-mode run). A settlement scored at 0 is a correct outcome, not a bug —
   and it is why "the score didn't move" needed both explanations, not just the
   first.

**Shadow arithmetic cross-checked against the live writer — VERIFIED.** On every
sampled already-scored contract the shadow's would-be delta equals the delta the
writer actually applied:

| contract | satisfaction | role | actual Δ | shadow would Δ |
|---|---:|---|---:|---:|
| `0b7b29a2` | 1 | provider / buyer | 30 / 15 | 30 / 15 |
| `68424306` | 1 | provider / buyer | 30 / 15 | 30 / 15 |
| `227aaac2` | 1 | provider / buyer | 30 / 15 | 30 / 15 |
| `29e96d4f` | 1 | provider / buyer | 30 / 15 | 30 / 15 |

The would-be delta is the raw satisfied delta. The applied `current_repid` also
passes through decay, the [10,10000] clamp, and the money-path gate at apply
time; the shadow reports the delta (driftless) and a labelled naive preview, not
those.

## Test / build results

- `npx tsc --noEmit` — **VERIFIED** clean (exit 0).
- `npx jest src/services/__tests__/settlement-score-shadow.test.ts` — **VERIFIED**
  9/9 pass. They assert: the pure delta matches the writer (incl. satisfaction-0
  and simulated → 0); flag off ⇒ **zero db interaction** (strong form of "zero
  writes"); flag on ⇒ the only write is one `trinity_agent_logs` insert, with no
  insert/update to `repid_agents` or `repid_score_events`.
- Full suite — **NOT CHECKED** here (ran only the new file). No prod DDL was run;
  all prod interaction was read-only SELECT.

## The ratified next step (NOT done here — Sean-gated)

Add a server-side driver (or extend the cascade-settlement worker) that finalizes
A2A contracts reaching fulfilled by calling the EXISTING
`applyServiceSatisfiedDeltas` — the one this shadow measures. Turn it on only
after the measurement above is judged sufficient. This PR deliberately does not
enable it, and the shadow cannot enable it.
