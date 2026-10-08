# INBOX_XC: red-team F-13: find every keyless write that mints, settles or writes reputation

## Task

**Lane:** RED-TEAM. You have **no write scope**: the deliverable is text. Do not claim to have
created, edited or committed a file. You hold `reasoning` and `repo_read`, on this repository at
branch `claude/bold-turing-icz50x`. **Three outcomes: VERIFIED / NOT_CHECKED / FAILED.**
Dispatched by CC (Claude) on 2026-10-07.

### Sean's rule (verbatim, 2026-10-07)

"F-13: no keyless on-chain write. A daily cap still lets a stranger write. The demo route may check.
It may not mint, settle, or write reputation. If a demo write must exist, it takes the operator key
and a cap, and it is not keyless."
"F-14: ... A service that writes with no key is the same hole as F-13."

### What this branch changes (verify it, do not trust it)

1. `POST /api/v1/demo/run-round-anonymous` is no longer bypassed in `src/middleware/auth.ts`; the route
   (`src/routes/v1.ts`) now needs the operator key and has a daily cap (`DEMO_ROUND_DAILY_CAP`).
2. `POST /api/v1/bet/place` is no longer bypassed.
3. `SEAN_SIG_SECRET` (`src/routes/v1.ts`) and `ORACLE_HMAC_SECRET` (`src/services/linked-bet-resolver.ts`,
   `src/services/onchain-oracle.ts`) no longer fall back to strings published in this repo. Unset
   means refuse.
4. `tests/no-default-secrets.test.ts` lists the remaining secret fallbacks; the list may only shrink.

### Your job: find what this branch MISSED

Start from `src/middleware/auth.ts`: every early `return next()` is a door that skips the API key.
Also read every router mounted BEFORE `authMiddleware` in `src/index.ts`. For each door that accepts
a POST, PUT, PATCH or DELETE (or a GET with side effects), follow the handler to the database and the
chain and answer: can a caller with NO key, or with only a value printed in this public repo, cause
any of these?

- a mint (ERC-8004 identity, token, NFT);
- a settlement (escrow release, bet resolution, contract settle, x402 settle);
- a reputation write (anything that changes `repid_agents.current_repid`, `repid_score_events`,
  wisdom/character scores, or an on-chain ReputationRegistry write);
- money moving (stake, payment, allowance, spend).

A route that authorizes itself with a real per-request credential (a wallet signature checked against
the right address, a server-held HMAC secret with NO public default) counts as keyed. A route that
takes only a body field, a session token anyone can mint, or a secret with a public default does not.

### Deliverable

Rank by failure direction, worst first:

1. a keyless path that writes on-chain or settles money;
2. a keyless path that writes reputation in the database;
3. a self-authorizing route whose credential is weaker than it looks (a default, a guessable value,
   a token anyone can obtain);
4. a test in `tests/f13-no-keyless-writes.test.ts` or `tests/no-default-secrets.test.ts` that cannot fail.

For each finding give the HTTP request (method, path, body shape), the `file:line` you read, what it
writes, and the test that would catch it. If you find nothing in a category, say NOT FOUND and list
which doors you read, so a reader can tell "none" from "not looked".
