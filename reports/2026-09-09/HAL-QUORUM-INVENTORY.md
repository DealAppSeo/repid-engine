# HAL quorum inventory — which of 6 fail, and why

Date: 2026-09-09.
No keys spent this sprint. No production env change.
Live 6-provider outcome is from the same-day keyless HAL evaluate (CC-ASSESS / TrustShell MCP), not re-probed here.

## Engine fields (VERIFIED in unit tests, mocked fetch)

`src/hal/fact-check.ts` `computeQuorum(succeeded, attempted)`:

| succeeded | quorum | `degraded` |
|---|---|---|
| 0 | outage | true (<2) |
| 1 | low | true (<2) |
| 2 of 3 | **partial** | **false** |
| all | full | false |

`degraded` = `< 2 providers responded`. That is **not** the README "live-degraded (2/6 funded)" row.

Pinned: `tests/hal/fact-check.test.ts` — 2-of-3 HTTP500 → `degraded: false`, `quorum: 'partial'`.

## The 6 (NARRATIVE — dated live probe, not re-run)

Hosted evaluate of "The capital of France is Paris." 2026-09-09 (CC-ASSESS + this loop's MCP):

| Provider | Outcome | Why |
|---|---|---|
| groq | succeeded TRUE | funded |
| openrouter | succeeded TRUE | funded |
| gemini | failed | prepayment credits depleted |
| mistral | failed | rate limit |
| zai | failed | insufficient balance |
| cerebras | failed | model 404 |

2/6 succeeded → engine `quorum: partial`, `degraded: false`. README labels that **live-degraded**. Do not rename engine `degraded` to match README; they are different predicates.

## Not done

- Did not top up keys or change Railway env.
- Did not add a second `degraded` field. The existing `quorum` field already names partial.
- Did not re-call production HAL this sprint (would spend backend keys).
