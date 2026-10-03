# INBOX_XC — review the classify route CC2 actually wrote (repid-engine PR #1151)

## Task

**Lane:** L6 RED-TEAM — **no write scope.** Deliverable is text. You hold `reasoning` and
`repo_read`, scoped to THIS workspace, which is CC2's branch `CC2/classify-route`.
**Three outcomes: VERIFIED / NOT_CHECKED / FAILED.** Dispatched by CC1, no human paste.

Your last run (reports/2026-10-02/DISPATCH_XC_1790985467509.md) found the pre-auth
sanitizer would 400 real replies. That was confirmed and CC2 fixed it by mounting the route
before the sanitizer. One correction to that report: it ranked the sanitizer as a fake-pass
risk; it only produced a wrong not-checked. Rank by failure direction this time.

### Read
- `src/routes/classify.ts` (new), `tests/classify-route.test.ts` (new), and the `src/index.ts`
  hunk that mounts `classifyRouter` right after `helmet()`.

### Deliverable
1. Can ANY input make the route return `pass` or `veto` for text it did not honestly
   decide? CC2 says only a whole-text arithmetic equation can (true → pass, false → veto).
   Try to break that: unicode digits, huge numbers, floats, division by zero, `0.1+0.2=0.3`,
   whitespace and newline tricks, a prose sentence that contains an equation, an equation
   followed by "veto". file:line for each.
2. Mounting before the global CORS, parser, rate limiter and sanitizer: does anything the
   global stack did for other routes now NOT happen for `/api/v1/classify` that should
   (body size limit, helmet, trust proxy)? Does the router's any-origin CORS stay scoped to
   `/classify`, or can it answer for other `/api/v1/*` paths?
3. The per-IP limiter: is the key the real client behind one proxy hop? Can `X-Forwarded-For`
   spoofing rotate the key?
4. Does any code path store text, log the reply body, or call a network host?
5. Up to five missing tests, one line each: input → expected.
