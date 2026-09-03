# Proof currency measured, and a trap left by an unused column

**2026-09-03.** Two results, one of which retires a listed concern and one of which
is a warning. Both came from measuring before building, and the first stopped a
feature that would have optimised a problem with zero live instances.

---

## 1. "Established agents hold stale proofs" — the age is real, the staleness is not

`reports/2026-08-31/COLD-PATH-ECONOMICS.md` item 6 reads: *"Established agents hold
month-old proofs because nothing re-mints on read. A stranger now gets a better
artifact than the flagship."*

The first half is confirmed. Roughly a third of agents holding a real proof have one
older than 30 days, the oldest close to three months, and nothing re-mints on read.

**The implied harm is not there.** A proof's `statement` records the exact
`repid_score` it attests, so "does this proof still describe this agent" is an exact
comparison, not a time heuristic. Measured across every agent holding a real proof:

| | result |
|---|---|
| latest proof's proven score == live `current_repid` | **all of them** |
| latest proof describing a different score | **none** |
| largest divergence | **0** |
| proofs whose proven claim (`score >= threshold`) is no longer true | **none** |

An old proof here is still exactly right, because the scores under them have not
moved. **Age is not staleness**, and on this data they are uncorrelated.

A currency/freshness ladder was designed and then NOT built on this evidence. It
would have been the `PRIOR-WORK-INDEX` lesson repeating: *"Suspect the target before
the measurement... compute the ceiling before optimising toward it."* Two agents had
score events after their last proof and even those produced no divergence.

**What this does NOT establish.** Only that divergence is zero *today*. Nothing binds
a validity window (see §2), so nothing prevents divergence tomorrow and nothing would
surface it. The right trigger for building the ladder is a non-zero reading here, and
re-running the comparison is cheap: it needs no extra query on the passport path,
since `statement->>'repid_score'` and `current_repid` are both already fetched.

---

## 2. `repid_zkp_proofs.expires_at` is written by nothing, read by nothing — and populating it would MANUFACTURE a verdict

The column exists on every row and is **NULL on every real proof**. No code writes it
and no code reads it. (`src/cache/proof-cache.ts` has an `expires_at`, but that is a
different table — a cache TTL, unrelated.)

That is the third "built and never wired" column found this week, and this one has a
sharp edge the others did not:

> The acceptance gate leg `zkrepid.expiry_binding` is FAILED because **the circuit
> binds no validity window** — a proof from any date verifies forever. A reader who
> finds a NULL `expires_at` beside that failing leg will reasonably conclude the fix
> is to populate the column.
>
> **It is not.** Writing a timestamp into a database column the proof does not commit
> to creates something that *reads* as expiry and *enforces* nothing. The proof
> bytes are unchanged; anyone verifying the proof directly — which is the entire
> point of handing someone a proof — sees no expiry at all and gets the same
> `valid`. The column would move the leg's appearance without moving the property.

That is the same shape as the borrowed attestation UIDs neutralised in
`migrations/2026-06-03-*.DO-NOT-RUN`: raising the number without raising the evidence.

**If a validity window is wanted, it is `valid_from` / `valid_until` as circuit
inputs.** That is a circuit change, it is item 2 on the COLD-PATH honest-limits list,
and it is the only thing that closes the leg. A DB column may accompany it as an
index or a convenience — never as the binding.

---

## Method note

Neither of these was found by reading. The first came from asking the database a
question whose answer could have gone either way, and the answer killed a planned
feature. The second came from listing the table's columns rather than assuming the
schema matched the code — `expires_at` is not referenced anywhere in the proof path,
so no amount of reading that path would have surfaced it.
