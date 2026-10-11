# Dependabot wave — triage, decisions, fix PRs (2026-10-11)

Status lives here, not only in a scratchpad, so the next session can pick it up.
Measured, not inferred. Re-verify live PR state against GitHub before acting — a
snapshot goes stale.

## Where this came from

The Tier-A security wave merged a `.github/dependabot.yml` into every repo. Dependabot
then opened PRs across six repos. **Every open PR in this wave is from `dependabot[bot]`
— zero human/feature PRs are open, so no feature progress is at risk.**

## Systemic findings (measured)

1. **repid-engine Dependabot PRs were all red on `test` — not on the bump.** GitHub
   withholds Actions secrets from Dependabot-authored runs, so the Integration step got
   empty `SUPABASE_URL_TEST` / `SUPABASE_SERVICE_KEY_TEST`, and 18 of 26 integration
   suites threw at import (`src/config.ts`) instead of skipping. **Fix: PR #1307**
   (test-harness only; `ci.yml` and production code untouched). After #1307 merges and
   Dependabot rebases, repid #1295–#1298 go green.
2. **TypeScript 5/6 → 7 is a hard NO everywhere** (all red, confirmed): repid #1291,
   trustshell #508, trustkeys #73. TS7 removed the JS compiler API; ts-jest peer pins
   `typescript <7`; AGENTS.md pins TS5. **Closed.**
3. **A few "routine action bumps" are red on a repo test-guard, not the bump.**
   trustshell #502 (checkout 4→7) is red because a test regex-pins `actions/checkout@v4`;
   one-line test relax landed as **PR #512**. repid #1295–#1299 are red only from
   finding #1.
4. **checkout v7 is safe across this wave.** Its one breaking change blocks fork-PR
   checkout under `pull_request_target` / `workflow_run`. Verified by code search: none
   of trustkeys / trinity-symphony-shared / trusttrader / repid-engine use that pattern,
   and trustshell's only hits are docs that forbid it. So green CI genuinely = safe here.

## Sean's decisions (2026-10-11)

- Merge the measured-green set **one at a time per repo** so the rest rebase.
- **Do NOT merge a title that says "minor" if its test is red** (e.g. repid #1290).
- **Close the TS7 trio + the other majors** — they burn CI and are not the proof.
  Reopen one deliberately when chosen. (Done — 22 closed; see below.)
- **After the skip fix lands:** group minor+patch into one PR per repo and `ignore` the
  closed majors in `dependabot.yml`.
- **Auto-merge only after one grouped PR has gone green (incl. the pin tests) on two
  repos.** Until then, Sean clicks every merge. Nobody merges their own.
- **Do NOT bump the gitleaks action** (repid #1299, trustkeys #68) until the two gitleaks
  mechanisms are one. "A license gate that makes someone turn the scan off is a hole."
- Phone rule: one list — green, Sean merges; red, hold and say why. A draft is a fix,
  not a merge.

## Fix PRs (Sean merges)

| PR | repo | what | state |
|---|---|---|---|
| #512 | trustshell | relax `receipts-workflow` test regex to accept checkout tag-or-SHA (unblocks #502) | ready, CI green, Strix-approved |
| #1306 | repid-engine | re-pin ERC-6492 validator bytecode for solc 0.8.37 (metadata-only diff; runtime bytecode byte-identical) | ready, all checks green |
| #1307 | repid-engine | secretless integration runs SKIP the DB suites instead of throwing at import (unblocks #1295–#1298) | ready, all checks green, Strix running (advisory) |

## Open wave state (verified ~22:17Z; re-check before acting)

- **trinity-ecosystem** — clear (#216 merged).
- **trinity-symphony-shared** — green, safe: #59 (npm minor-patch), #68 (actions
  minor-patch), #69 (setup-node 4→7), #70 (checkout 3→7). Majors #60–#67 closed.
- **trusttrader** — green, safe: #11 (checkout 6.1→7.0.1), #12 (setup-node 6.5→7.1),
  #13 (npm minor-patch, 47 updates). Majors #14–#17 closed.
- **trustshell** — #502 (checkout 4→7) red until #512 merges; #500/#501/#503/#504/#505
  merged; majors #506–#509 closed.
- **trustkeys** — #68 (gitleaks-action) HELD; #70 (checkout 4→7) rebasing after #69
  merged. Majors closed.
- **repid-engine** — #1290 (npm minor-patch, 11 updates) red from finding #1 *and* the
  solc bytecode pin — needs **both** #1306 and #1307 merged, then rebase. #1295–#1298
  red only from finding #1 → green after #1307 + rebase (first rebase is the
  confirmation — NOT_CHECKED until then). #1299 (gitleaks-action) HELD. Majors
  #1291–#1294 closed.

## Still on hold (Sean's toggles / follow-ups, not code)

- Enable Strix App on trusttrader + trustmarketing; mark Strix/CI required on public/prod
  via branch rulesets; trustshell also require `check`.
- gitleaks consolidation: remove the action-based `gitleaks.yml`, keep the binary
  `secret-scan.yml` (offered as a 4th fix draft, awaiting the nod). Hold the
  gitleaks-action bumps (repid #1299, trustkeys #68) until then.
- Grouped-dependabot `dependabot.yml` per repo, after #1307 merges.
