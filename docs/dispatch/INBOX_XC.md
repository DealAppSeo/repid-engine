# INBOX_XC — review CC2's B5 (#1157) and B6 (#1158) before merge

## Task

**Lane:** L6 RED-TEAM, cross-family review. **No write scope.** Deliverable is text. You hold
`reasoning` and `repo_read` on THIS workspace, which contains both PR branches merged
together. No evidence commands were run for you. **Three outcomes: VERIFIED / NOT_CHECKED /
FAILED.** Dispatched by CC1 (Claude) on 2026-10-03, no human paste. Your verdict decides
whether XC3 or Sean merges; Claude does not merge Claude's PRs.

### B5, repid-engine #1157 (`CC2/jev-call`): `src/jev/classify.ts` + `tests/jev-classify.test.ts`
Claimed by its author:
- returns label pass | veto | not-checked plus a score, never `reject`
- the model URL must be loopback (localhost, 127.0.0.1, ::1); anything else, including a hosted
  OpenRouter endpoint, is refused WITHOUT a network call; this is how "no paid model, no
  Anthropic" is enforced
- inert: nothing calls it; with `JEV_CLASSIFY_URL` unset every call is not-checked
- regenerates the env registry (adds `CLASSIFY_RATE_LIMIT`, `CLASSIFY_RATE_WINDOW_MS`)

Attack it: can any input make it return `pass` or `veto` without a loopback model answering
that label? Loopback bypasses (`http://localhost.evil.com`, `http://127.0.0.1@evil.com`,
`http://[::ffff:127.0.0.1]`, `0.0.0.0`, decimal/octal IPs, redirects). A model answer outside the
three labels, a numeric score outside [0,1], NaN, a timeout, a thrown fetch. Does anything get
stored or logged with the text?

### B6, repid-engine #1158 (`CC2/cfo-belt`): `GET /api/v1/belts/cfo` + `tests/belts-cfo.test.ts`
Claimed by its author:
- returns the same rows as trustshell's `public/belts/cfo.html`
- every row, including cap, has `can_spend:false`; unknown row → 404 `NOT_CHECKED`
- no db, writes nothing, every row `evidence:'self'` and score delta 0

Attack it: any path where `can_spend` could read true, a row claiming evidence it does not
have, a db import, a mount order that puts it behind or ahead of auth in a way that matters.
Check `src/index.ts` for where it is mounted. If `./trustshell` exists in this workspace, compare
the rows to `trustshell/public/belts/cfo.html`; otherwise say NOT_CHECKED.

### Deliverable
1. Per PR: **MERGE / HOLD**, with each blocking finding as input, file:line you read, and the
   test that would catch it. Rank fake-pass and can_spend:true above everything else.
2. Non-blocking notes, one line each.

Do not claim a test passed; you ran nothing.


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
