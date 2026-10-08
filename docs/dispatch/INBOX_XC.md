# INBOX_XC: review + red-team the Jev/Laya Chrome extension path and its Chrome Web Store readiness

## Task

**Lane:** REVIEW + RED-TEAM. You have **no write scope**: the deliverable is text. Do not claim to
have created, edited, run, built or committed anything. You hold `reasoning` and `repo_read`, on this
repository (`repid-engine`, branch `claude/bold-turing-icz50x`) and on **`DealAppSeo/trustshell`
read-only at `./trustshell`**. **Three outcomes: VERIFIED / NOT_CHECKED / FAILED** — and since you
cannot run anything, "the code reads as if it works" is NOT_CHECKED, never VERIFIED. Dispatched by CC
(Claude) on 2026-10-08.

## Why this matters

We are about to invite outside users. The headline flow is: a person on their **normal** LLM site
(ChatGPT, Claude.ai, Grok, Gemini) uses our **Chrome extension** to run the trust harness inline, with
**Jev and Laya** — fast single-pass classifiers ("LLMs without the language", good at multiple-choice)
— doing the cheap first-pass check. Sean needs to know, from a second model family that only reads:
does this actually hang together, what leaks, and what is left before it can go in the Chrome Web Store.

## Part 1 — Trace the extension path (read it; name every break)

In `trustshell/extension/` read `manifest.json`, `content.js`, `select.js`, `scrub.js`, `classify.js`,
`laya.js`, `grok-host.js`, `background.js`, `badge.js`, `toast.js`, `settings.js`. Follow one claim from
the user selecting text on an LLM page to a stamp appearing:
`content/select -> scrub -> classify -> (Laya / the engine) -> badge/toast`. For each hop state
VERIFIED / NOT_CHECKED / FAILED and the `file:line`. Call out any hop that is wired to nothing, a
`TODO`, a stub, or a function that is defined but never called.

## Part 2 — What ARE Jev and Laya, in code (no guessing)

Read `repid-engine/src/jev/classify.ts`, `src/routes/laya-classify.ts`, `src/classify/free-votes.ts`,
`src/routes/classify.ts`, and the eval harness `scripts/eval/jev-shadow.ts` + corpus. Answer:
1. Is Jev/Laya a local heuristic, a small model, or a remote call? Quote the code that decides.
2. Is the "fast, single-pass, no heavy LLM" claim TRUE as implemented, or does it fall back to a full
   provider call? Name the fallback path if any.
3. Does the extension's `laya.js` call the engine's Laya route, or a local copy? Do they agree?

## Part 3 — RED-TEAM the privacy/security surface (this is the important part)

A content script that reads a user's LLM conversation is a serious trust surface. Rank worst-first:
1. **What leaves the browser, and to where?** Trace every `fetch`/`sendMessage` out of the extension.
   Does `scrub.js` actually remove PII/secrets BEFORE anything leaves the page, or can raw selected
   text (which may contain the user's private prompt, an API key, a wallet address) reach our server
   or a third party? Give the `file:line` where scrubbed vs raw text crosses the boundary.
2. `manifest.json` host permissions — are they minimal, or broad (`<all_urls>`)? Any `content_security_policy`
   weakness, remote-code (`eval`, remote script) that Chrome Web Store review will reject?
3. Can a malicious page spoof a "verified" stamp, or suppress a "veto" stamp, by controlling the DOM the
   content script reads/writes?
4. Does the extension hold or touch any key, token, or secret? (It must not — keys are TrustKeys.)

## Part 4 — Chrome Web Store readiness

Read `trustshell/store/LISTING.md` and `.github/workflows/extension-e2e.yml`. What is present and what is
MISSING for a submission (listing copy, screenshots, privacy-policy URL, permissions justification,
single-purpose description, data-use disclosures)? List the gaps as a checklist. Do NOT claim it is
submitted or live — you cannot check that; say NOT_CHECKED.

## Deliverable

A ranked report, worst failure-direction first. For every claim: `file:line` and one of VERIFIED /
NOT_CHECKED / FAILED. Where a category is clean, say NOT FOUND and list what you read, so a reader can
tell "none" from "did not look". End with the single most important thing to fix before inviting users.
