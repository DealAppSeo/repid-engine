# INBOX_XC — strategy: the most ambitious secure build tonight

## Task

**Lane:** L6, cross-family strategy review. **No write scope.** Deliverable is text. You hold
`reasoning` and `repo_read` on this workspace; `./trustshell` is checked out read-only.
Dispatched by CC1 (Claude) on 2026-10-03 at Sean's request: he wants Claude and Grok to ALIGN,
and to see exactly where we diverge and why.

### Sean's question (verbatim intent)
Reverse-engineer from the real pains of engineers AND vibe coders. What is the single most
recognizable gap, one a low-coder and a senior engineer both feel, whose fix:
- has the most potential to go viral on GitHub and TikTok,
- makes people JOIN and CONTRIBUTE to this ecosystem rather than clone it and build their own,
- is a serious, secure, privacy-first entry point into the agentic economy that other systems
  do not provide,
- and is the most ambitious build that is still SECURE to ship tonight (no spend, no token move,
  no REAL_STAKING, no paid model on a public route, no fake score)?

### Answer FIRST, independently, before reading CC1's proposal below
1. Your pick: the pain, the product, the one-line pitch, the 15-second TikTok.
2. Why people contribute instead of cloning (what is NOT clonable).
3. What ships TONIGHT vs this week vs later. Name files you read in `./trustshell` and here.

### CC1's proposal (critique it AFTER your own answer)
**Pain:** AI coding agents (Claude Code, Cursor, Codex, Copilot, Grok) say "done, all tests
pass, verified" when they did not run the tests, or the tests failed. Everyone who has used one
has been burned. This repo's own house defect, "a system reporting success it has not earned",
is the universal vibe-coder pain.

**Product:** a zero-install GitHub Action plus `npx trustshell check`. On every PR it reads the
agent's claims (PR body, commits) and checks them against the evidence GitHub itself holds
(check runs, job conclusions, whether a test job ran at all). It posts one receipt comment:
each claim VERIFIED / NOT CHECKED / FAILED. "Claude said 21 tests pass. No test job ran."

**Already built:** `trustshell/src/lib/check.ts` (verifies a run from api.github.com, no account,
egress to GitHub only), and `scripts/dispatch/run-agent.mjs` `auditClaims` (claim vs evidence).

**Why viral:** the receipt comment shows up on public PRs where others see it. "Caught my AI
lying" is a native TikTok format.

**Why join, not clone:** the checker is free and open source; what you cannot clone is the shared
record. Opt-in receipts across many repos become each agent's and each tool's track record
(RepID), and contributors add claim-checkers (one per claim type) and earn credit for them.

**Security and privacy:** runs in the user's own CI with the default `GITHUB_TOKEN`
(read + one PR comment). No backend, no key, no telemetry, code never leaves their repo. Sharing
a receipt to the network is opt-in and sends a hash, not code.

**Tonight:** the Action plus the claim extractor plus a receipt comment, dogfooded on our own PRs.
Not tonight: the shared ledger write and any RepID score.

### Deliverable
1. Your independent answer (above).
2. AGREE / DIVERGE on each part of CC1's proposal, with the reason.
3. The single build you would ship tonight, with what it must NOT do.


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
