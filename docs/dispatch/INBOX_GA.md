# INBOX_GA — the provisional-RepID contract and the no-wallet flow's predicates

## Task

**Lane:** L7 MEASUREMENT — **no write scope.** Your deliverable is a specification
returned as text. Do not claim to have created, edited or committed a file.

**Dispatch:**
```
node scripts/dispatch/run-agent.mjs --agent ga --inbox docs/dispatch/INBOX_GA.md \
  --requires reasoning,repo_read
```

---

### Why this task exists

The product is growing a **progressive-trust signup**: a visitor arrives with no wallet, no
email and no account, does real things, and sees their RepID move — proving more about
themselves only as the stakes rise. XC is red-teaming the policy in parallel. **Your half
is the data contract**: what is recorded, in what states, and how anyone later tells an
earned score from a provisional one.

The operator's stated intent, verbatim, because it is written nowhere in this repo:

> *"we want to create the signup with the least friction possible … for most users we want
> them to see value before we ask for too much info … without us ever taking seeing or
> having access to their info or wallet, we never take custody. So as they do a few things
> and learn, see the value hopefully, and their RepID goes up slightly because they are
> learning."*

This collides with a fact in the code: anonymous builders are created with
`earns_repid_rewards: false` and the module says *"cannot accrue RepID; mint ERC-7231 to
upgrade."* **Both are right and they cannot both be literally true.** Your contract is what
resolves it without either lying to the user or debasing the score.

Do not design policy logic and do not assume what XC will decide. Write the shape; state
the properties you require of the policy as requirements on XC.

---

### Facts you need, inlined

You have `reasoning` and `repo_read`. **`repo_read` is scoped to this workspace only** —
you cannot open `trinity-ecosystem`, `trustshell` or `hyperdag-protocol`. Do not claim to
have read a file outside this repo, and do not invent its contents.

**The trust vocabulary — four states, and the distinctions ARE the product:**

| State | Means |
|---|---|
| `MEASURED` | A named check ran and passed. Traceable to that check. |
| `APPROXIMATE` | Measured against a documented proxy. Always carries its caveat. |
| `NOT_CHECKED` | Nobody looked. **Not** a warning, **not** a failure — an absence. |
| `FAILED` | A check ran and did not pass. |

**Exit codes:** `0` VERIFIED, `2` NOT_CHECKED, anything else FAILED. A gate that goes red
for environmental reasons gets ignored within a week, at which point it is worse than no
gate — so distinguish "could not look" from "looked and failed" in every field you define.

**Canonical facts (do not re-derive, do not contradict):**
- Tiers: `PROBATIONARY` 0–499 · `EARNING` 500–999 · `ESTABLISHED` 1000–4999 ·
  `AUTONOMOUS` 5000–7999 · `VETERAN` 8000–10000. RepID clamps to [10, 10000].
- `tier` is **database-derived** — a Postgres trigger overwrites it from `current_repid` on
  every write. **Never define a field that writes tier directly.**
- The live tier function demotes on counterparty count: `VETERAN` and `AUTONOMOUS` each
  require **>= 2 unique counterparties**. `ESTABLISHED` and `EARNING` have no such gate.
- `repid_score_events` is the append-only audit log of every score change. Any provisional
  movement must be representable there, or it is invisible to every existing consumer.
- `CONSTITUTIONAL_AUDIT_ENABLED` defaults **FALSE** and is non-load-bearing: a stub that
  always passes must never steer scoring or be reported as a measurement.

**Read these files — they are the actual subject:**
- `src/services/anonymous-signup.ts` — what a no-wallet visitor gets. Note
  `earns_repid_rewards: false`, `auth_method: 'token_only'`, and an address derived from
  the token that is deliberately not a valid checksummed address and holds no key.
- `src/engine/repid-update.ts` — the scoring pipeline every score change flows through.
  Your contract has to fit this, not replace it.
- `src/providers/cost-class.ts` — three states, never two, and why `unpriced` must not
  collapse into `free`. The same discipline applies to provisional vs earned.
- `src/services/effective-authority.ts` — how an honest approximation is labelled in this
  codebase. `A_eff` stamps `rRouteIsLedgerApproximation: true` and is consumed as
  **APPROXIMATE**. Follow that pattern.

---

### Deliverables — three specifications

### 1. `provisional-repid.v0` — the shape of an unearned score

Fields for RepID accrued by an account that has proven nothing but possession of a token.

Must express: the provisional amount, distinctly from earned; what event caused it; the
account's proof level at the time; whether it is eligible to vest and under what
*property* (XC defines the rule, you define the field); and a status distinguishing
**vested** / **provisional** / **forfeited** / **not-applicable**.

**Hard constraints.**
- A consumer that does not know about this contract must not mistake provisional for
  earned. State how the shape makes that mistake structurally difficult, not merely
  discouraged by a comment.
- The existing `earns_repid_rewards: false` flag must remain meaningful. Say precisely how
  your contract relates to it — extends, replaces, or is orthogonal — and do not leave two
  fields that can disagree.
- Vesting must be **representable as not-yet-happened**, never as a default-true.

### 2. `progressive-identity.v0` — proof level as data

The shape recording what an account has actually proven, from "holds a token" through to a
bound wallet and whatever multi-factor steps sit between.

Must express: the current proof level; what evidence backs it and when it was obtained;
and — this is the load-bearing part — **the difference between "this factor was checked and
passed" and "this factor was never required"**. Those must not share a representation.

**Hard constraint:** the operator's guarantee is that the system never takes custody of a
wallet and never holds personal information it does not need. Your shape must make it
possible to record *that a proof happened* without recording *the thing proven*. Say
explicitly which fields would be a violation if added later.

### 3. E2E predicates for the no-wallet flow

The checks that would prove the flow works end to end, written so each returns one of the
four states.

Cover at minimum: signup issues a usable credential; that credential is accepted by the
next call in the flow; a provisional score moves and is labelled provisional; and vesting
on identity binding.

**This one has a live, embarrassing precedent — use it.** The existing e2e suite
(`tests/e2e/reponomics-live-flow.e2e.ts`) minted a credential at step 1 and never sent it
at step 2, so the deposit step could only ever fail — and the suite reported that failure
as *"public endpoint not deployed"*, which is a claim about the server that was not true.
Read that file, including its verification-ledger header. Your predicates must make that
specific class of mistake — a cascade misreported as a deployment gap — impossible to
state.

---

### Acceptance criteria

- Every status field can express all four vocabulary states.
- No field name, comment or example implies a guarantee that is not implemented.
- Each document names its own **open questions** explicitly rather than resolving them by
  assumption. An unresolved question stated plainly is a better deliverable than a
  confident wrong answer.
- Where a field's value can only be an approximation, it carries its caveat in the shape —
  not in prose beside it.
- Where you are uncertain, write **UNVERIFIED** and say what would settle it.

### What will be rejected

- Any claim you read a file outside this workspace.
- Any invented test output, command output, or measurement. On 2026-08-05 a dispatch
  returned a review containing fabricated test results; that is the specific failure this
  lane's constraints exist to prevent. **If you did not run it, you did not run it.**
- A two-state (boolean) status anywhere.
- A field that writes `tier`.
- Filling in a Sprint-3 stub.

### Note on where this lands

`repid-engine` is a **PUBLIC** repository. State findings, not inventories. Do not include
credentials, project identifiers, row counts or service names in your output.
