# INBOX_XC: red-team F1 + F2: one accountable root, unbacked stake stops counting

## Task

**Lane:** RED-TEAM. You have **no write scope**: the deliverable is text. Do not claim to have
created, edited or committed a file. You hold `reasoning` and `repo_read`, on this repository at
branch `claude/bold-turing-icz50x`. **Three outcomes: VERIFIED / NOT_CHECKED / FAILED.**
Dispatched by CC (Claude) on 2026-10-07. Sean said GO on F1 and F2 with your rules from the
foundation review. This is the code that enforces them; tell us where it does not.

### The rules it claims to enforce

1. **Accountable root.** An agent may escrow, pay, widen a grant, add a key or place a stake only
   while someone answers for it. That someone is one of:
   - a bound owner;
   - the operator's custodian (house agents only);
   - the top of a live, connected grant chain that ends at one of those.
2. **Child grants.**
   - The parent must be live and must be held by the grantor.
   - The root of the chain must be the same person as the grantor's own root.
   - Depth is capped. A cycle is refused.
3. **A failed read is not "still live"** and not "nobody owns it". It is NOT CHECKED (503).
4. **Unbacked stake does not raise a spending ceiling.** Prediction-market wagers and sponsorship
   rows are reported and ignored. Placing a stake needs the operator key or the root owner's
   signature over that exact deposit.
5. **One checker family is not two opinions.**
   - HAL low quorum + would-be clean → `abstain`.
   - Ledger same-family pair → `incomplete`.
   - Dispute validator that checked nothing → back to pending, no verdict.

### Where to read

- `src/services/accountable-root.ts`: `anchorOf`, `resolveAccountableRoot`, `dbRootReader`.
- `src/services/principal-grants.ts`:
  - `walkAncestors`, `isChainLive`, `rootCut`;
  - the parent block in `mintGrant` (`parent_not_held_by_grantor`, `root_mismatch`);
  - `checkAuthorization`.
- Routes:
  - `src/routes/mvp-api.ts`: `POST /grants`, `/x402-gate/authorize`, `/staking/deposit`;
  - `src/routes/v1/contracts.ts`: escrow;
  - `src/routes/key-management.ts`;
  - `src/routes/agent-spend.ts`;
  - `src/routes/v1/byok.ts`.
- `src/services/x402-gate.ts`: `loadAuthorityContext`, backed vs unbacked.
- `src/hal/fact-check.ts` (the `abstain` block), `src/workers/dispute-resolution-worker.ts`,
  `src/ledger/daily-totals.ts`.
- Tests:
  - `tests/accountable-root.test.ts`, `tests/grants-chain-f1.test.ts`;
  - `tests/escrow-accountable-root.test.ts`, `tests/stake-unbacked-not-counted.test.ts`;
  - `tests/owner-lookup-fail-closed.test.ts`.

### Deliverable

Rank by failure direction, worst first:

1. a path that commits money or widens power **with no root**;
2. a read failure scored as a pass;
3. a test that cannot fail.

For each finding give the input, the `file:line` you read, and the test that would catch it.
At minimum, try:

- **Identity confusion.** `resolveAccountableRoot` takes a ref that may be a name or a uuid.
  - Can a name that collides with another agent's id, or a case variant of a wallet, resolve to
    the wrong agent?
  - Can a `viaGrantId` whose grantee matches by name but not by id borrow someone else's root?
- **Chain walk.**
  - Can a chain look connected while a link's grantor is not the parent's grantee?
  - Look for case, whitespace, and name vs uuid mismatches.
  - Is depth checked on what the row *says* or on the steps actually walked?
  - What happens at exactly `MAX_GRANT_DEPTH`?
- **Same-person rule.** In `mintGrant`, the rule is skipped when the grantor's own anchor is
  `no_root`.
  - Is that safe? An unowned grantor holding a grant from someone else may hang a child.
  - Does `rootCut` / the escrow check stop that child from doing anything that matters?
- **Custodian.** `conservator_address` is the house fallback.
  - Is there any route, migration or register path by which a caller can set that column for
    their own agent?
  - If so, F1 is bypassed for everyone.
- **Stake.**
  - Can `stake.deposit` be replayed? Look at the nonce and the params hash.
  - Can the params be shifted (amount as number vs string, `null` vs missing)?
  - Can a signature for agent A be used for agent B?
  - Does anything else still add unbacked stake into a ceiling?
- **Fail-closed.** Find any `catch` or `error` branch in the files above that returns
  allow / live / owner-absent instead of NOT CHECKED.
- **Head-of-line.** A dispute whose validators never answer returns to pending each cycle.
  - Can it starve the queue (ordering, batch size)?
  - Is there any path where it is retried forever with no visible signal?

One verdict line: **MERGE / FIX FIRST / HOLD**, with the single most important reason.
