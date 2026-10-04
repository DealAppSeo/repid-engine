# FINDING 2026-10-04 — does the production postcard prover trust a caller-supplied score?

**Verdict: NOT CHECKED.** Code reading and git history in this repo cannot settle it, and the
two pieces of evidence the repo does hold point in opposite directions. No forged score was
sent anywhere; no database or log read was made (CC1, sprint "zkRepID proof freshness", Loop 2).

## The question

Every score path (`src/routes/agents-external.ts` register + score event, `src/scoring/pipeline.ts`,
`src/services/proof-drain-service.ts`, and the new `src/workers/proof-refresh-worker.ts`) POSTs
`{agent_id, score, ...}` to `${ZKP_SERVICE_URL}/zkp/repid-proof` with **no auth header**. The
default host is a public Railway URL. If the prover proves whatever `score` it is handed, anyone
can obtain a real Plonky3 proof that "agent X has RepID > N" for any X and N.

## Evidence in the repo

| # | Source | What it shows | Weight |
|---|---|---|---|
| 1 | No caller sends any credential; no prover key/token variable is read anywhere under `src/` | The prover cannot tell our engine from a stranger. Whatever it does with `score`, it does for everyone. | VERIFIED (code) |
| 2 | `reports/2026-07-27/BEAT29_PROOF_GENERATION_RESTART_RUNBOOK.md` §3, live probe with a real agent id | Response carries `repid_score_supplied: null`, `repid_score_actual`, `score_source: "server_side_lookup"`. The report concludes the prover "ignores the client-supplied score". | **Does not support that conclusion.** `supplied: null` means no score was in play, so the probe never tested the case. It does show a server-side lookup path EXISTS, and a `score_source` field implies more than one source. |
| 3 | `scripts/zkp/live-prover-crosscheck.ts` | Sends a NIL-variant agent id no real agent holds, with a made-up score, and expects the returned proof to verify against `repid_score: <that made-up score>`. | The script's design ASSUMES the prover proves a caller-supplied score at least when the lookup misses. Its own header says it has never run green; it is an assumption, not a measurement. |
| 4 | Consumers: `proof-drain-service.ts` and `zkp-audit-service.ts` prefer `repid_score_actual` over what they sent; the audit service self-verifies the assembled statement | Our consumers are defensive either way. This protects rows WE write; it says nothing about proofs a third party obtains directly. | VERIFIED (code) |
| 5 | Prover source | Not in this repo. CLAUDE.md records the live source as not in any repo; `trinity-ecosystem/services/zkp-postcard` is an older demo and was not read for this finding (not in this session's scope). | NOT CHECKED |

So #2 and #3 disagree, and neither is a test of the actual question.

## What would settle it (read-only, no forged score to production)

1. **Read the deployed prover's source** — the image Railway runs for the zkp-postcard service
   (Railway project `AITrinitySymphony`, not `repid-engine`). Look for how `score` from the
   request body is used vs. the server-side lookup, and what happens when the lookup misses.
2. **Read the prover's recent deploy logs** (read-only) for any `score_source` value other than
   `server_side_lookup`.
3. **Read-only SQL** — real proofs whose statement score disagrees with the score the agent
   actually had at that moment would be direct evidence of the prover proving a supplied score:

```sql
-- proofs whose proven score differs from the score event the drain bound them to
select count(*) as mismatched, count(*) filter (where z.created_at > now() - interval '30 days') as recent
  from repid_zkp_proofs z
  join repid_proof_queue q on q.job_id::text = z.job_id::text
  join repid_score_events e on e.id = q.event_id
 where z.is_real is true
   and z.scheme = 'plonky3_range_check'
   and (z.statement->>'repid_score')::numeric is distinct from round(e.repid_after);
```

   A zero here is only meaningful if the same query returns non-zero on a deliberately
   mismatched sample — and it cannot see proofs a third party requested directly, since those
   never land in our tables. It is supporting evidence, not the answer; (1) is the answer.

4. **The safe live probe**, if ever wanted: request a proof for the NIL-variant synthetic agent
   (as `live-prover-crosscheck.ts` does) — never a real agent with a forged score. If the
   prover returns a real proof for an agent that does not exist, at a score nobody holds, it
   trusts the caller. That is an outward act against production and is Sean's call, not this
   sprint's.

## Why it matters even if the answer is "it ignores the score"

The prover is unauthenticated. Even with a correct server-side lookup, any caller can make it
spend proving time on demand, and any caller can obtain a genuine proof about any real agent's
real score. That is consistent with the public `GET /repid/:agentId/proof` surface, so it may be
intended — but it should be a decision, not a default.

## Correction made in the same change

`src/services/proof-drain-service.ts` said the prover "ignores client score". That comment was
built on evidence #2 and is now marked NOT CHECKED with a pointer here (LESSONS rule 10).
