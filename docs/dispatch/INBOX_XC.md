# INBOX_XC: red-team the MVP phone door and the E2E gate (trustshell PR #441)

## Task

**Lane:** RED-TEAM. You have **no write scope**: the deliverable is text. Do not claim to have
created, edited or committed a file. You hold `reasoning` and `repo_read`. The trustshell tree is
placed at `./trustshell` at commit `2571858` (branch `claude/bold-turing-icz50x`, PR #441).
**Three outcomes: VERIFIED / NOT_CHECKED / FAILED.**
Dispatched by CC2 (Claude) on 2026-10-04: this PR is the last piece of NORTH milestone 1
("a stranger gets a real label on the phone"), and it decides what the daily E2E gate certifies.

### What it is (paths under `./trustshell`)

- `app/check/page.tsx` + `app/check/CheckForm.tsx`: **trustshell.dev/check**, the phone door.
  - One sentence goes to `POST /api/v1/classify` through the same `classifyClaim()`
    (`src/lib/claim.ts`) the CLI and MCP use.
  - The page shows pass / veto / not-checked.
  - Merging deploys it publicly on trustshell.dev.
- `tests/e2e/check-walk.mjs`: the phone-door suite at a 390px viewport.
  - Stubbed mode (13 checks) and `--live` mode (real Groq/Cerebras votes).
  - With `HTTPS_PROXY` set, `--live` intercepts the page's classify call and replays the exact
    body to production with curl (`transport: relayed-by-runner`). The browser's own hop through
    the sandbox relay took 7.9 s, against the product's 6 s timeout.
- `tests/e2e/harness-acceptance.mjs`: the cold-install gate.
  - Now defaults to npm `latest`; it was pinned to 1.3.0.
  - Records the installed version.
  - New leg `claim.check`: the published CLI's `check "<sentence>"` must give pass/0 and veto/1.
    A classifier abstention is NOT_CHECKED.
  - Writes a JSON receipt when `RECEIPT_DIR` is set.
- `.github/workflows/e2e-honesty.yml`: runs the phone door stubbed and live daily and uploads
  every receipt as an artifact.

### Deliverable

Rank by failure direction. Worst first: anything that shows **pass** when production did not say
pass. Then a leak (text, a secret, an identifier). Then a test that cannot fail. For each finding
give the input, the file:line you read, and the test that would catch it. At minimum, try:

- **Can the page show pass, or veto, without the endpoint saying so?**
  - The response body: an extra field, a label with odd case or whitespace, a 200 with HTML,
    a redirect.
  - `NEXT_PUBLIC_REPID_ENGINE_URL` set to something odd at build time.
  - A race between two submits; a slow first answer arriving after a fast second one.
- **Does anything private leave the phone?** Read `src/memory/redact.ts`: what does it miss that a
  person might paste (an email, a phone number, an `sk-ant-…` key, a GitHub token)? Is the privacy
  line on the page true about where text goes and whether it is stored?
- **Is the live mode's relay honest?**
  - Could `relayToProduction` turn a failure into a pass?
  - Could it make the suite green while the real browser door is broken in a way only the browser
    hop would show (CORS, CSP, mixed content)?
  - Is the `transport` field enough for a reader of the receipt to know?
- **Can each new or changed check fail?** Which assertion in `check-walk.mjs` or the `claim.check`
  leg would stay green with the product broken? The one known mutation (not-checked shown as pass)
  turns 4 stubbed checks red.
- **`claim.check` exit-code contract:** pass 0, veto 1, not-checked 2. Is an abstention ever scored
  FAILED, or a wrong-way label ever scored NOT_CHECKED?
- **The gate now tests `latest`, not a pin.** What does that change about reproducibility of a past
  receipt, and is the installed version recorded well enough to compensate?

One verdict line: **MERGE / FIX FIRST / HOLD**, with the single most important reason.
