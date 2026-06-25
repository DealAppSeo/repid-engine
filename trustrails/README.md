# TrustRails — an installable governance guardrail

Classify any agent action as **T0** (trivial/reversible), **T1** (consequential/bounded),
or **T2** (critical/irreversible), then gate it: T2 is blocked to human sign-off, T1 goes
through an evidence-gated adversarial review, T0 is allowed. Every decision emits a trace
you can read. The rules live in a config file you can see and tune.

This bundles three pieces from the wired governance layer (spec v0.3 §3+§4):
the **consequence classifier** (CC), the **adversarial chamber** (XC), and the
**gate/trace** packaging here. Runtime is pure — no DB, no server, no secrets.

## Quickstart (from a clean clone)

```bash
cd trustrails
npm install
npm run demo               # built-in T2 example (DROP TABLE) → ⛔ STOPPED, exit code 1
```

Govern the provided examples:

```bash
npx tsx cli.ts examples/t2-db-drop.json      # ⛔ BLOCK  (DDL + migrations/ path → T2)
npx tsx cli.ts examples/t0-local-write.json  # ✅ ALLOW  (local, reversible → T0)
npx tsx cli.ts examples/t1-merge.json        # 🟡 REVIEW (merge to feature branch → T1)
```

Govern your own action (any JSON matching the `Action` shape):

```bash
npx tsx cli.ts path/to/action.json
```

Exit code is **0 when permitted, 1 when stopped** — drop it into a pre-commit hook or CI step.

## Programmatic API

```ts
import { guard, loadTrustRailsConfig, fileTraceSink } from './index';

const cfg = loadTrustRailsConfig();           // reads trustrails.config.yaml
const result = guard(
  { kind: 'git', git: { operation: 'push', targetRef: 'main' }, description: 'deploy' },
  { config: cfg.classifierConfig, humanSignOffTiers: cfg.humanSignOffTiers, sink: fileTraceSink() }
);
// → { tier: 'T2', verdict: 'BLOCK', reason: 'T2 critical/irreversible — human sign-off required (T2_PROTECTED_GIT)', log: {...} }
```

`guard(action, opts) → { tier, verdict, reason, log }`
- `verdict`: `ALLOW` / `PROCEED` (permitted) · `BLOCK` / `ESCALATE` / `REVIEW` (stopped)
- `log`: the full `DecisionTrace` — what was classified, which rules fired, why, and the chamber result.

## Tune the rules — `trustrails.config.yaml`

Everything that decides a tier is in `trustrails.config.yaml`: prod project ids, protected git
refs, critical path patterns, DDL keywords, the cost threshold, and `humanSignOffTiers`.
**Changing the config changes behavior** — e.g. lower `costT2ThresholdUsd` to `0.10` and a
$0.50 spend flips from T1 to a T2 block; add `T1` to `humanSignOffTiers` to force human review
of every consequential action. (Proven in `tests/trustrails-config.test.ts`.)

Unmatched actions **fail safe to T2** — there is no fail-open path.

## Decision traces

Every gated action appends a structured JSON record to `.trustrails-traces/decisions.jsonl`
(local, gitignored). Read them back with `readTraces()` or just `cat` the file — this is the
"read why each decision was gated" capability.

## Notes / honesty

- This is an **in-repo package**: it imports the classifier/chamber from `../src` (single source
  of truth) rather than vendoring copies. To extract it as a standalone npm package, copy
  `src/services/consequence-classifier.ts`, `src/services/adversarial-router.ts`, and
  `src/config/adversarial-templates.ts` alongside `trustrails/` and repoint the imports.
- Enforcement is advisory: `guard()` returns a verdict; wiring it to actually halt an action
  (pre-commit hook, CI gate, agent action loop) is the integrator's call.
