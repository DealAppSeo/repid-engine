# INBOX_XC — red-team the least-friction signup ladder before it is built

## Task

**Lane:** L6 RED-TEAM — **no write scope.** Your deliverable is findings and a
specification returned as text. Do not claim to have created, edited or committed a file.

**Dispatch:**
```
node scripts/dispatch/run-agent.mjs --agent xc --inbox docs/dispatch/INBOX_XC.md \
  --requires reasoning,repo_read
```

---

### Why this task exists

The product is about to grow a **progressive-trust signup**: a visitor can arrive with no
wallet, no email and no account, do real things, and see their RepID move — proving more
about themselves only as the stakes rise. That is the MVP's front door and it is not built
yet. **You are being asked BEFORE it is built, not after**, because the failure direction
here is "anyone can mint reputation", and that is far cheaper to prevent than to unwind.

The operator's stated intent, verbatim, because it is not written anywhere in this repo:

> *"we want to create the signup with the least friction possible … for most users we want
> them to see value before we ask for too much info … without us ever taking seeing or
> having access to their info or wallet, we never take custody. So as they do a few things
> and learn, see the value hopefully, and their RepID goes up slightly because they are
> learning … even though at a certain point they obviously will have to 2FA and I see
> value in 4FA before they start exchanging high risk data."*

Your job is to find where that intent, implemented naively, breaks the guarantee that a
RepID is **earned**.

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

**Exit codes:** `0` VERIFIED, `2` NOT_CHECKED, anything else FAILED.

**Canonical facts (do not re-derive, do not contradict):**
- Tiers: `PROBATIONARY` 0–499 · `EARNING` 500–999 · `ESTABLISHED` 1000–4999 ·
  `AUTONOMOUS` 5000–7999 · `VETERAN` 8000–10000. RepID clamps to [10, 10000].
- `tier` is **database-derived**. A Postgres trigger overwrites it on every write to
  `current_repid`. Never design a policy that writes tier directly.
- **There is already an anti-Sybil gate, and it is load-bearing to this task.** The live
  `compute_tier(integer, uuid)` overload demotes on counterparty count: `VETERAN` and
  `AUTONOMOUS` each require **>= 2 unique counterparties**, else they fall one tier.
  `ESTABLISHED` and `EARNING` have **no such gate today**. That asymmetry is the single
  most important input to your analysis — reason about what it does and does not protect
  when the population gains a large number of zero-counterparty accounts.
- `PAY_AUTH_MODE` is **observe**: the ControlProof gate records what it would decide and
  does not decide it.
- `CONSTITUTIONAL_AUDIT_ENABLED` defaults **FALSE** and the layer is non-load-bearing.

**Read these files — they are the actual subject:**
- `src/services/stake-authorization.ts` — the existing authorization ladder
  (`session` / `wallet_signature` / `operator` / `unenforced`). Note that it already
  escalates on the **risk of the action** (a real on-chain deposit demands a wallet
  signature; a simulated one accepts a session). Read the module header first.
- `src/services/anonymous-signup.ts` — what a no-wallet visitor actually gets: a 32-byte
  random token stored on the builder row, `auth_method: 'token_only'`,
  `earns_repid_rewards: false`, and an address derived from the token that is
  **deliberately not a valid checksummed address** and holds no key.
- `src/services/auth-token.ts` — `verifyFullAccountToken()`: a JWT requiring `builder_id`
  **and** `email`. An anonymous visitor has neither.
- `src/services/bounty-authorization.ts` — read the header. It is the clearest worked
  example in this repo of a fix that *looks* correct and closes nothing: requiring the
  `admin` scope would have authorised everyone, because public registration grants
  `admin` to every new agent. **Assume the same shape of mistake is available here.**
- `src/routes/agents-external-score.ts` — a route that until recently required no
  credential at all, and the reasoning that closed it.

**The measured gap this task is about:** `/builder/token-signup` mints a credential into
`builders.session_token`, and four routes in `src/routes/v1.ts` resolve a builder by that
column — so it is a real, used credential. But `/stake/deposit`'s session tier accepts
**only** full-account JWTs. So the product issues a credential its own ladder will not
accept. Confirmed against production 2026-08-28: sign up, present the token you were
handed one call earlier, receive `invalid_session`.

---

### Deliverables — four sets of findings

### 1. Attack the anonymous rung

Assume the bottom rung is added: a `builders.session_token` match authorises **simulated**
stake on its own row only, with real deposits still requiring a wallet signature.

Find what that buys an attacker. At minimum reason about: unbounded free account creation;
what a token-only account can reach that it should not; whether "its own row only" is
actually enforceable given how the builder is resolved; and whether any downstream consumer
treats a token-only account as equivalent to a full one.

**Name the single highest-severity path you find, and say plainly if you find none.**

### 2. Rank the two RepID options by failure direction

The operator must choose between:

- **(A) Provisional-and-vesting** — an anonymous user's RepID moves as they act, is
  recorded against the token-only row, and becomes *earned* only when they bind an
  identity. A Sybil farm accumulates nothing that vests.
- **(B) Preview-only** — the number shown is not persisted as earned at all.

For each: what does an attacker gain, what does an honest user lose, and **which way does
it fail when the implementation is subtly wrong** — because that, not the happy path, is
what should decide it. Note explicitly whether the existing counterparty gate covers (A),
and at which tier it stops helping.

### 3. The escalation ladder itself

Specify the ladder as predicates: for each rung, what is proven, what it unlocks, and what
the system must refuse. Cover the operator's 2FA/4FA intent as *thresholds on action risk*,
not on user identity. State where each rung's decision is MEASURED vs NOT_CHECKED.

**Design for observe first.** Say explicitly what would have to be true to enforce.

### 4. What must never be reachable

The short list of capabilities that must remain closed to a token-only account no matter
how the ladder evolves, each with the reason it is on the list. This is the list a future
change gets checked against, so it is worth more than a long one.

---

### Acceptance criteria

- Every finding names the file and the mechanism, not just the symptom.
- Every status distinguishes all four vocabulary states. No two-state booleans.
- Each finding carries **what it does NOT establish**. A boundary stated is worth more
  than a claim overreached.
- Where you are uncertain, write **UNVERIFIED** and say what would settle it.
- Severity is ranked by **which way the control fails**, not by how alarming the component
  sounds. A gate that fails closed and a gate that fails open are not comparable.

### What will be rejected

- Any claim you read a file outside this workspace.
- Any invented test output, command output, or measurement. On 2026-08-05 a dispatch
  returned a review containing fabricated test results; that is the specific failure this
  lane's constraints exist to prevent. **If you did not run it, you did not run it.**
- A recommendation to loosen an authorization path without stating its failure direction.
- Filling in a Sprint-3 stub.

### Note on where this lands

`repid-engine` is a **PUBLIC** repository. State findings, not inventories. Do not include
credentials, project identifiers, row counts or service names in your output.
