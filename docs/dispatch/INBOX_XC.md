# INBOX_XC — red-team the verification gate BEFORE it is built

## Task

**Lane:** L6 RED-TEAM — **no write scope.** Your deliverable is findings returned as
text. Do not claim to have created, edited or committed a file. Do not claim to have
run anything: you hold `reasoning` and `repo_read` only, `repo_read` is scoped to THIS
workspace, and no evidence commands were run for you.

**Three outcomes, never two: VERIFIED / NOT_CHECKED / FAILED.** "I could not check this"
is a SUCCESS. A guess that scores better is the failure mode this lane exists to catch.

---

### Why this task exists

This repo is about to close its first learning loop. Today an agent marks its own work
`done` and nothing independent ever checks it. The proposed gate is:

1. **Facts in code.** Deterministic, no LLM: did git HEAD move, did the test exit 0,
   does the row exist, did /health return 200, does the transcript sha match.
2. **Judgment by a typed decision model.** One question — "does this evidence support
   this claim?" — answered as a typed value, not prose.
3. **HITL on disagreement or low confidence.** A human on a phone, not another agent.
4. **`done` is never terminal.** Only the verifier writes `verified` / `failed`.

**You are being asked in the window between "designed" and "built", because that is the
only cheap moment.** Once this gate is live it decides which agents earn RepID, and RepID
decides which agents get routed future work. A gate that can be influenced by the worker
it judges does not degrade gracefully — it inverts, and the least honest agent wins.

---

### Facts you need, inlined (you cannot reach the database or the other repos)

These are MEASURED readings from the live production database on 2026-09-22. Treat them
as given; you cannot re-run them and must not claim you did.

**A. The existing peer-verification queue already ran, then wedged.**
`peer_verification_queue` holds 140,187 rows:

    in_review   62,841   verifier_agent_id IS NULL on ALL of them   (frozen 2026-07-21)
    timeout     41,495
    disputed    30,797
    verified     5,054

**B. Its columns are exactly:**

    id, source_response_id, source_agent_id, certainty_at_claim,
    verification_status, verifier_agent_id, verifier_response_id,
    verifier_signature, created_at, completed_at, threshold_used, claim_text

There is **no `claimed_at` and no `updated_at`.**

**C. The claim step and the completion step are separate, and the claim is not exclusive.**
In the agent runtime (a sibling repo you cannot open), the claim is:

    UPDATE peer_verification_queue SET verification_status = 'in_review'
     WHERE id = $1 AND verification_status IN ('pending', 'in_review')

Note it re-accepts `in_review`. The verdict is then written by a SEPARATE HTTP POST to
`/api/v1/peer-verification/respond`, carrying an HMAC signature over
`${queueId}:${verifierResponseId}:${verdict}`, after an LLM call. Nothing releases the
row if the LLM call, the signing, or the POST fails.

**D. A recursion is already in the data.** Sampling 24 rows, roughly 19 had `claim_text`
of the form:

    "Peer verification completed with verdict: disputed. Response ID: <uuid>"

i.e. the queue is verifying its own verification outputs, which are then re-enqueued.
Some rows carry `verification_status = disputed` while their `claim_text` says
`verdict: verified`. `certainty_at_claim` is 0 on nearly all of them.

**E. The real work claims that are in there look like this**, with no evidence attached:

    "The task is complete. The 'save_artifact' tool has been called to finalize the
     Agent Health Sweep report."
    "The WSCE Calibration Check task has been completed, and the results have been
     saved as a report artifact."

---

### What to return

**1. Worker-influences-own-verification.** Enumerate every path by which the agent that
produced a claim can affect the verdict on that claim. Consider at minimum: being
selected as its own verifier; selecting a colluding verifier; shaping `claim_text` so a
typed decision model reads it as self-evidently true; producing an artifact that satisfies
the fact-gate without doing the work (a file that exists but is empty, a test that passes
vacuously, a 200 from an endpoint that ignores its input); and re-enqueueing its own
verdict as a new claim (finding D — say whether that is the only instance of that shape
you can find in this repo, or one of several).

**2. Rank by which way each fails when subtly wrong.** For each path, say whether the
failure direction is "honest work marked failed" or "fabricated work marked verified".
Rank the second kind first. Name which you would fix before the gate goes live at all.

**3. The fact-gate's own limits.** For each of the five deterministic checks in the design
above, name a claim that would pass that check while being false. Be concrete. If a check
has no such claim, say so — that is a useful finding too.

**4. The lease.** Given B and C, specify the minimum change that makes a stale claim
reclaimable without making a live claim stealable. State what breaks if the TTL is too
short and what breaks if it is too long.

**5. Say plainly where you are re-finding something the brief already told you**, and
where you found something the brief did not contain. Do not pad the second list.

Worked example of the mistake most likely here, from this repo: a review once cited exact
line numbers for a file it had never opened, and graded itself `[R]`. The dishonesty was
in the SPECIFICS, not the confidence label. If you name a file or a line, you opened it.
