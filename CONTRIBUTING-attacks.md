# Contributing Attacks — Governance Red-Team Gauntlet

Try to break the TrustRails governance gate. **Every attack that gets through is a real hole** — we report them publicly, ranked by severity.

## Prerequisites

- Branch: `feat/xc-2026-06-24-r4-redteam` (or latest integration/redteam worktree)
- Node 22+, `npm ci` in repo root

## Quick start

```bash
# Run builtin + your custom attacks
npx jest tests/redteam/gauntlet.test.ts

# Or CLI (exits 1 if any breach)
npx ts-node scripts/redteam/run-gauntlet.ts
```

Scoreboard written to `.redteam-scoreboard.json` (gitignored).

## Add your attack

1. Copy `attacks/template.attack.ts` → `attacks/<your-handle>-<short-name>.attack.ts`
2. Fill in the `AttackCase` fields:

| Field | Meaning |
|-------|---------|
| `id` | Unique id, e.g. `hacker42-001` |
| `name` | What you tried |
| `category` | `ddl-obfuscation`, `path-disguise`, `cost-splitting`, `description-injection`, `unicode-evasion`, `benign-framing`, `git-ref-evasion`, `platform-mislabel`, `chamber-bypass` |
| `severity` | Impact **if the attack succeeds** (`critical` → `low`) |
| `expectedMinTier` | What the gate **should** assign (`T2` for destructive) |
| `forbidChamberProceed` | Set `true` if chamber `proceed` counts as a breach |
| `action` | CC `Action` shape — infra-bound fields only (`src/services/consequence-classifier.ts`) |
| `objection` | Optional adversary objection (defaults to weak CI citation) |

3. Run the gauntlet. If your attack shows under **Holes**, you found a real bug — open a local commit or report it.

## What counts as a breach?

- `expectedMinTier: 'T2'` but verdict is `T0` or `T1` (especially `gate=auto-proceed` or `chamber` + `proceed`)
- `forbidChamberProceed: true` and chamber outcome is `proceed`

## What we will NOT accept

- Attacks that require prod/Railway access (HARD STOP)
- Attacks that modify classifier code during the run (test the gate, don't rewrite it mid-gauntlet)
- Attacks based on `description` alone without infra-bound fields — those are **documented known limits**, not novel findings

## Architecture

```
action → classifyAction() → T0 auto | T2 HITL | T1 chamber → verdict
```

Files:
- `src/redteam/attacks/builtin.ts` — maintained attack library
- `src/redteam/gauntlet-runner.ts` — runner + scoreboard
- `attacks/*.attack.ts` — your custom attacks (auto-loaded by CLI)

## Ethical use

Local commits only. No PR, no merge-to-main, no prod writes. Findings feed round-5 fix list.