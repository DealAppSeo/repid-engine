# INBOX_XC — red-team Receipts (trustshell #433) before merge

## Task

**Lane:** L6 RED-TEAM, cross-family. **No write scope.** Text only. `./trustshell` is checked
out read-only AT THE PR BRANCH `CC1/receipts`. Three outcomes: VERIFIED / NOT_CHECKED / FAILED.
Dispatched by CC1 (Claude) on 2026-10-03; Sean approved Receipts as tonight's build.

### Read
- `trustshell/receipts/core.js` (pure: extractClaims, groupClaims, judge, render)
- `trustshell/receipts/index.js` (GitHub I/O), `trustshell/receipts/action.yml`
- `trustshell/.github/workflows/receipts.yml`, `trustshell/tests/receipts-core.test.ts`

### Attack, ranked by harm
1. **False accusation / false FAILED or false VERIFIED.** Find PR text that makes a receipt say
   VERIFIED or FAILED when the evidence does not support it: check-run names that match the
   wrong kind (e.g. a run named `contest` or `attestation` matching /test/), a status context
   spoofing a name, a claim matched in a sentence that is not a claim.
2. **Injection.** PR text is attacker-controlled. Can it break the markdown table, inject a
   link or an @mention that pings people, forge the `<!-- trustshell-receipt -->` marker so a
   different comment gets overwritten, or exceed size and crash?
3. **Token / Actions security.** Any path that runs PR code, leaks the token, or needs more
   permission than declared. Is `persist-credentials: false` + `sparse-checkout` right?
4. **Comment hijack.** `upsertComment` finds the first comment starting with the marker. Could
   another user post a comment starting with the marker so the action PATCHes it (and would
   that PATCH even be allowed)? Should it also check the comment author?
5. **Missed claims** (lower harm: a miss is silence, not a false verdict).

### Deliverable
Per finding: input, file:line you read, harm, and the test that would catch it. Then
MERGE / HOLD with blocking findings only. Do not claim you ran anything.


---

## Previous entry (kept for reference)


**Lane:** L6 RED-TEAM — **no write scope.** Deliverable is text. Do not claim to have
created, edited or committed a file. You hold `reasoning` and `repo_read`, scoped to THIS
workspace. No evidence commands were run for you. **Three outcomes: VERIFIED /
NOT_CHECKED / FAILED.** Dispatched by CC1 (Claude) on 2026-10-02, without a human paste:
this is the first run of the cross-family loop Sean asked for.

### What is being built (by CC2, in parallel, on a branch you cannot see yet)

`POST /api/v1/classify`, the one check that every TrustShell door calls (browser extension,
Telegram bot, terminal). Contract, decided 2026-10-02 by Sean, CC1 and Grok:

    in:   { text: string, labels: ["pass","veto","not-checked"] }
    out:  { label }   label is exactly pass | veto | not-checked
    - a missing/empty text, a timeout, an error, or any unsure result is "not-checked",
      never 0 and never pass
    - a reply ending in the word "veto" is not a veto unless the classifier decides so
    - PUBLIC: mounted BEFORE authMiddleware (the extension holds no key), own per-IP
      rate limit
    - calls NO paid model, not HAL, not the quorum
    - stores nothing: no claim text, no user id, no insert

### What to read in this workspace

- `src/index.ts`: how routes are mounted relative to `authMiddleware` and
  `rateLimitMiddleware`, and the SQL-keyword body sanitizer that runs before auth.
- `src/routes/laya-classify.ts` and `src/laya/classify.ts`: the existing public pre-auth
  route this one will sit beside (a different contract: cheap|escalate|ask).
- the auth and rate-limit middleware, wherever `src/index.ts` imports them from.

### Deliverable

1. **Attack list**, ranked by failure direction. Rank first anything that can make the
   route answer `pass` (or `veto`) for text it did not honestly classify. Rank lower
   anything that only produces a wrong `not-checked`. For each: the input, the code path
   (file:line you actually read), and the test that would catch it.
2. **The sanitizer interaction.** The pre-auth body sanitizer rejects POST bodies that
   contain `SELECT `, `DROP `, `--`, `;` and similar. Most real chat replies contain `;` or
   `--`. Say exactly what that does to this route (status code? label?), whether the
   extension would then paint not-checked, and whether that is acceptable or a defect.
3. **Cost and abuse.** With no key and no paid call, what is left to abuse? Name the
   cheapest denial-of-service and whether a per-IP limit stops it behind a proxy (Railway
   edge: is `req.ip` the client or the proxy here?).
4. **Five tests CC2 must have** before XC3 merges it. Each test is one line: input → expected.
5. One closing lesson, if you have one.

Mark every claim VERIFIED (you read the line), NOT_CHECKED (you could not see it), or
FAILED.
