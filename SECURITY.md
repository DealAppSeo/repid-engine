# Security

## Reporting a vulnerability

Please report privately first, via [GitHub Security Advisories](https://github.com/DealAppSeo/repid-engine/security/advisories/new).

If you can't use advisories, open a normal issue describing **what breaks and why**, without a working exploit payload. This repository is public — its README says so at the top, and every issue, PR body and commit message in it is world-readable and permanent. A published exploit can't be withdrawn.

We aim to acknowledge reports within a few days. If a report is valid we will tell you so, tell you what we're doing about it, and credit you.

## What we care most about

Roughly in order. A report against any of these is welcome even if you're not sure it's exploitable:

- **Payout and reward paths** — anything that mints, awards or approves RepID, USDC or a bounty.
- **Authentication and authorization** — especially routes mounted *before* the global auth middleware in `src/index.ts`, which do their own checks. Those are the ones most likely to be wrong.
- **Identity binding** — anywhere a caller's claimed identity could be accepted instead of one derived from a credential.
- **Key custody** — `src/services/agent-key-crypto.ts` and anything that could cause a private key to be logged, returned or persisted in the clear.
- **Fail-open behaviour** — a control that stops controlling when a secret is absent, a dependency is down, or a flag is unset. We'd rather be unavailable than quietly permissive.

## How fixes land on sensitive paths

**Payout, auth, and key-custody paths are maintainer-authored and require review before merge — including when a maintainer wrote the change.** This is a property of the *path*, not a judgement about who is contributing. A solo maintainer shipping unreviewed auth at 2am is the same risk as anyone else, and the rule is written to bind us too. See [`.github/CODEOWNERS`](.github/CODEOWNERS) for the exact paths.

Practically, that means:

- **Please do report** issues on these paths — that's the most valuable thing you can send us.
- **Please don't open an unsolicited PR that changes how one of them authenticates.** We'll almost certainly have to decline it, and we'd rather not waste your weekend. Two specific reasons, both learned the hard way:
  - A patch that introduces a **new secret** creates a deployment-ordering dependency. An environment variable that doesn't exist yet reads as an empty string, so a check gated on it fails *open* unless the secret is deployed strictly before the code that reads it. Whoever holds the deploy credentials has to own that sequence.
  - A fix can look correct and still not close the hole. In [#446](https://github.com/DealAppSeo/repid-engine/issues/446), the natural fix was to require the `admin` scope — but public agent registration hands `admin` to every new agent, so that check would have authorised anyone willing to send a single unauthenticated POST. Catching that needed context about a different file entirely.

When we implement a reported issue in-house, we credit the reporter with a `Reported-by:` trailer on the fix commit and name them in the tracking issue.

## If you want to contribute code

Great — and the fastest path to a merged PR is a path that isn't on the sensitive list. Docs, tests, non-payout bug fixes, and anything labelled `good first issue` all go through normal review. If you've reported something and want to help fix it, say so on the issue and we'll find you an adjacent piece that isn't blocked on deploy credentials.

## Rewards

We credit every valid report publicly. Where a report qualifies under a published bounty program, payment is assessed against that program's rules and is independent of whether any particular PR is merged — we don't want the incentive to be "get my patch merged", we want it to be "tell us the truth about our security".
