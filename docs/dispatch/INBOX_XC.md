# INBOX_XC — the evidence envelope, and what must be true before the panel is switched on

## Task

**Lane:** L6 RED-TEAM — **no write scope.** Deliverable is text. Do not claim to have
created, edited or committed a file. You hold `reasoning` and `repo_read`, scoped to THIS
workspace. No evidence commands were run for you. **Three outcomes: VERIFIED /
NOT_CHECKED / FAILED.**

**Your previous report was read and independently checked.** Three of your findings —
atomic self-verification block, the blind 2-of-3 panel with `computeConsensus`, and the
HMAC not binding `verifier_agent_id` — were CONFIRMED against the source by a reader
holding a shell. One thing to correct going forward: you attributed to your brief an
example of "a suite that reported 11 passed on both enabled and disabled runs." **That
example was not in your brief.** It may be true of this repo, but you did not get it from
the material you were given. Do not carry it forward as given.

---

### What changed since your last run

You reported the panel path exists and is flag-gated. That was verified. It reframes the
work: the verification triad is **already built and switched off**, so the next change is
*turn on what exists plus add the one missing input*, not *write a verifier*.

The missing input is the thing your own closing lesson named:

> the fact-gate must consume attached evidence — artifact hash, transcript hash,
> deterministic probe — rather than free-form `claim_text`, otherwise the producer
> controls the entire input to the verifier.

That is now the design constraint. Two MEASURED facts make it sharp:

    peer_verification_queue   has NO artifact column and NO task reference at all.
                              A verifier sees claim_text prose and nothing else.
    trinity_tasks             143,219 rows are 'done'. artifact_url is set on 120.
                              external_artifact_url on 0. verified_output on 1.

So today a fact gate has nothing to bite on, on either table.

---

### What to return

**1. The evidence envelope.** The minimum set of fields a completing agent must attach so
a verifier holding NO LLM can reach a verdict. For each: name, type, what it proves, and
**what it does not prove**. Keep it small — a schema nobody fills fails exactly like no
schema. Say explicitly which fields the producer can forge and which it cannot, and why.

**2. Where it goes.** `peer_verification_queue` has no column for it; `trinity_tasks` has
`artifact_url`, `external_artifact_url`, `proof_of_work`, `verified_output`,
`requires_external_artifact`, `verification_method`, `expected_output`, `success_criteria`
— nearly all unused. Recommend: extend an existing column set, or add one new column, and
say which and why. **Do not design a parallel enum if an existing column already carries
the meaning.** Name the specific columns you would use.

**3. Attack the panel you found.** Blind 2-of-3 over a FIXED pool
(`trinity-mel`, `trinity-shofet`, `trinity-gcm`), deterministic round-robin selection,
`computeConsensus` over votes. Assume it is switched on tomorrow. Enumerate how it fails:
a fixed pool of three, one pool member wedged or dead, two members sharing a model and
failing identically, votes that are all abstentions, a producer that is itself in the
pool, ties. For each, say whether it fails toward *fabricated work verified* or *honest
work failed*. Rank the first kind first.

**4. Preconditions for the switch.** Short, checkable list of what must be true before
`PEER_VERIFY_PANEL_ENABLED=true`. Each precondition names the file or mechanism that
satisfies it and how someone would check it. Mark each VERIFIED / NOT_CHECKED from what
you can actually read here.

**5. The unbound HMAC.** You found `dataToSign` is `queue_id:verifier_response_id:verdict`
with `verifier_agent_id` NOT bound, frozen for back-compat. State concretely what that
permits given the rest of the code, and whether the atomic self-verification guard already
neutralises it. If it does, say so — a finding that turns out to be defended is a real
result, not a failed one.

**6. Separate what you re-found from what is new.** Do not pad the second list.
