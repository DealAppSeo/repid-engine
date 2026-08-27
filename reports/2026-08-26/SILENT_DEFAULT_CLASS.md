# The silent-default class: two typos that cost a day

**2026-08-26.** Two production config variables were set correctly, with correct values,
and did nothing at all — because their names were misspelled by one character each:

```
HAL_PBLIC_RATE_LIMIT = 60      the code reads HAL_PUBLIC_RATE_LIMIT   (missing U)
HAL_BYOC_DAILY       = <set>   the code reads HAL_BYOK_DAILY          (C for K)
```

Neither produced an error, a warning, or a log line. The engine read the name it wanted,
found nothing, took its default, and served traffic happily. The public rate limit sat at
**10/hour instead of 60** — a 6× shortfall on the number that gates whether a hackathon
participant can use the product at all — while the dashboard showed `60` in green.

## Why this was hard to catch, and why that is the interesting part

The tell was there and it was subtle. Two variables were set in the same session:

- `HAL_PUBLIC_RATE_WINDOW_SEC = 3600` — **landed**
- `HAL_PBLIC_RATE_LIMIT = 60` — **did not**

They are read by adjacent lines of identical code:

```ts
const halPublicLimit  = Number(process.env.HAL_PUBLIC_RATE_LIMIT)  > 0 ? … : 10;
const halPublicWindow = Number(process.env.HAL_PUBLIC_RATE_WINDOW_SEC) > 0 ? … : 86400;
```

So the diagnosis was reachable by pure reasoning — *same parsing, one line apart, one worked
and one didn't, therefore it is not the code* — and that reasoning was correct. But it stopped
one step short. "It is the variable" is not the same as "the variable is misspelled," and the
gap between those two statements was **several hours and a screenshot**. The name was
invisible from every surface an agent can reach: the API returns behaviour, not configuration,
and Railway's variable list is not readable from a sandbox.

**A human glanced at the list and saw it immediately.** Pattern-matching a misspelling in a
column of similar strings is something eyes do in one pass and reasoning does badly.

## The generalisation

> **A config value that silently defaults is indistinguishable from one that was never set.**

This is the same shape as the two failures that preceded it this week, which is why it is
worth writing down as a class rather than an anecdote:

| what | looked like | actually was |
|---|---|---|
| BYOK bypass | a working escape hatch | wired at one end, unreachable |
| dead HAL models | a healthy quorum | 2 of 5 providers 404ing since a vendor deprecation |
| **these typos** | **a configured limit** | **an unread name, silently defaulted** |

All three are *the system reporting success it has not earned* — the recurring defect this
project already names. The `??` fallback is the mechanism: it is exactly right for "unset means
use the default" and exactly wrong for "misspelt means use the default," and it cannot tell
those apart because from inside the process they are the same event.

## The fix that is actually buildable

Not "be more careful." A boot-time check:

**If an environment variable is set whose name is within edit-distance 1–2 of a name this
process actually reads, and that name is NOT itself set, log it loudly and refuse to stay
quiet about it.**

Both of tonight's typos are edit-distance 1 from a real name. A twenty-line startup check
would have printed:

```
[config] HAL_PBLIC_RATE_LIMIT is set, but nothing reads it.
         Did you mean HAL_PUBLIC_RATE_LIMIT? (that one is UNSET, using default 10)
[config] HAL_BYOC_DAILY is set, but nothing reads it.
         Did you mean HAL_BYOK_DAILY? (that one is UNSET, using default 500)
```

…on the first deploy, hours before anyone measured a rate-limit header. The set of names the
process reads is statically discoverable — every one is a literal `process.env.X` — so the
check needs no registry anyone has to maintain, which is the usual reason this sort of guard
rots.

**Scope note:** warn, never fail. A deploy that refuses to boot over a stray variable is worse
than the bug — plenty of legitimate variables belong to other tools, and the check must not
become a reason to stop reading its own output.

## What made it findable, for the record

A screenshot. The user photographed the Railway variables panel and the misspelling was
obvious on sight. Nothing in the agent's reach — the API, the deployed commit, the logs,
the test suite — could have surfaced a name that no code ever asks for.

That is a real and permanent asymmetry, not a temporary tooling gap: **an agent can only
observe the names it already knows to look for.** Worth remembering the next time a
configuration mystery survives a round of careful reasoning: the next step is not more
reasoning, it is a picture of the configuration.
