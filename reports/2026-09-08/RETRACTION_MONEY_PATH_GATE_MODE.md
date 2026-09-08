# RETRACTION — `MONEY_PATH_GATE_MODE` is not a control on `main`

**Date:** 2026-09-08
**Status:** retraction of a name, not of a measurement
**Grep target:** this file exists so that `grep -rn MONEY_PATH_GATE_MODE` finds the correction.

---

## Why this file exists at all

`MONEY_PATH_GATE_MODE` was removed from the header comment of
`src/services/settlement-score-shadow.ts` in #675, and the guard added in #678
(`scripts/check-named-env-vars.cjs`) now fails the build on any doc or comment that names an
env var absent from the generated registry. Both are correct.

The side effect is the reason for this file. The string is now **absent from the entire
working tree**, so a reader who meets it in an older dated report — or in a PR body, a
transcript, or a sibling repo — has nothing to grep to. They find zero hits and are left with
two readings that look identical from the outside: *"this was retracted"* and *"this is a
control I have not found yet."* A retraction that cannot be found is not a retraction.

`reports/` is deliberately excluded from the guard's walk (`SKIP_DIRS` in
`check-named-env-vars.cjs`, reason: *"append-only historical snapshots; living docs + src
comments are current tense"*). That exclusion is what makes this file possible **and** what
made the problem: the dated report that names the string is unscanned, so the stale name
persists there uncorrected while the correction was scrubbed from everywhere greppable. Naming
the string here is using the design as intended, not evading the guard.

---

## The correction, stated precisely

**`MONEY_PATH_GATE_MODE` has never existed in shipped code on `main`.** It is not in the
generated env registry (`src/config/known-env-vars.generated.ts`), and no code on `main` has
ever read it.

**It is not, however, a name that was never written.** Stating it that flatly would be the
next wrong premise, because a reader who greps *all refs* will find it and conclude this
retraction is itself wrong. What is actually true:

| where | what | on `main`? |
|---|---|---|
| `origin/feat/cc-2026-09-03-policy-gate-money-path` @ `4fc93b7` | `src/kernel/money-path-gate.ts:53` — a real `process.env.MONEY_PATH_GATE_MODE` read, defaulting to `'shadow'` | **No** |
| same commit | `src/scoring/pipeline.ts:864` — a comment describing that gate | **No** |
| `b5bd8f7` (#670), on `main` | the header comment of `settlement-score-shadow.ts` naming the variable **as if it were live** | Yes — this was the defect |
| `019d1e4` (#675), on `main` | that sentence replaced with a retraction | Yes |

Verified: `git merge-base --is-ancestor 4fc93b7 main` → **not an ancestor**;
`git branch -a --contains 4fc93b7` → that feature branch only; `src/kernel/money-path-gate.ts`
does not exist in the working tree.

So the accurate sentence is: **the variable exists only on an unmerged feature branch, and was
described on `main` as an existing safety mechanism before any of it shipped.** A named
`SCREAMING_SNAKE` token in a comment reads as a real control; that sentence invented a gate a
reader would then assume was protecting the money path. That is LESSONS rule 4 — evidence
outranks the label — and rule 3, since a gate documented at one end only is worse than an
absent one.

---

## What the real gate is

**`X402_ENFORCEMENT_ENABLED`**, read in `processCascadeQueue` (`src/index.ts:950`) as
`process.env.X402_ENFORCEMENT_ENABLED === 'true'`. It is present in the generated registry.

Two things about it that the retracted name obscured, and that matter more than the retraction
itself:

- **It gates escrow admission, not the delta.** It decides whether a real `X-PAYMENT` header is
  required at escrow (see `src/routes/v1/contracts.ts`, `src/routes/v1/exchange-next-step.ts`,
  `src/middleware/contract-party-guard.ts`). It does not modulate any RepID score arithmetic.
  Anyone who read the invented name as "the gate on the money-path score" was reading a gate
  that does not do that, on top of a gate that does not exist.
- **It is compared against the literal string `'true'`**, so any other value — including unset —
  is legacy/off (`src/middleware/auth.ts:471`).

---

## Why the name is off the source file, and should stay off

`settlement-score-shadow.ts` now carries the retraction in prose without naming the variable,
because naming it would fail `npm run check` → `check:named-env-vars`, which scans `.md` files
and TypeScript comments and subtracts the registry. That check is doing its job: the whole
reason it was written is that a human reviewer reported "no findings" on the very file that
invented this name, and a grep would not have.

The retraction therefore lives here, where the historical record already is, and the source
file states the correction without re-introducing the token. **Do not add
`MONEY_PATH_GATE_MODE` back to any file outside `reports/`** — it will fail the build, and it
should.

---

## For the next agent

- Do not look for a money-path gate env var on `main`. There is none.
- If you need the money-path gate, it is `X402_ENFORCEMENT_ENABLED` in `processCascadeQueue`,
  and it gates escrow admission.
- If you find `MONEY_PATH_GATE_MODE` in a dated report, a PR body or a transcript, it is this.
- If you find it in `src/kernel/money-path-gate.ts`, you are on
  `feat/cc-2026-09-03-policy-gate-money-path`, which is unmerged. Check your branch before
  concluding anything about production.
