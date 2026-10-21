# L1 arming kit (Base Sepolia, test value). Nothing here is armed.

L1 runs a payment loop on Base Sepolia only after the owner signs ONE EIP-712 message in their own wallet: the
kernel's signed owner policy, v2 (`src/kernel/policy.ts`, "HyperDAG Kernel Owner Policy", version 2, chain 84532).
Its one binding, `l1.experiment.sha256:<id>`, is the sha256 of the experiment policy (AUTONOMY_LOOPS_SPEC §2:
asset, chain, wallets, payment count, gas cap, kill switch), so the one signature covers both files.
The pure logic is `src/kernel/l1.ts`; these scripts are its I/O.

**Signing moves no funds and needs no gas, but the signature authorizes later spending up to its caps.**

| Limit (spec §8) | In the policy |
|---|---|
| per payment | at most 1 USDC (`1000000` raw). ETH payments are not allowed at all; ETH is gas only |
| per rolling 24 h | at most 10 USDC and at most 20 payments |
| in total | at most 20 USDC (the most a wallet is funded with) |
| gas per payment | at most 0.0001 ETH |
| lifetime | at most 7 days; `make-policy.ts` defaults to 48 h |
| actions / payees | `spend` only; the seller wallet only |

## Files

| File | What it does |
|---|---|
| `make-policy.ts` | writes `l1-experiment-policy.json`, `l1-typed-data.json` (the exact bytes to sign) and `l1-review-sheet.md`. Signs nothing |
| `review-sheet.ts` | re-renders the sheet from the two JSON files; `--check <sheet>` says MATCH or MISMATCH |
| `sign-server.ts` + `sign.html` | a page on 127.0.0.1 for one `eth_signTypedData_v4` signature from your wallet; verifies it and writes `l1-signed-policy.json` |
| `init-ledger.ts` | creates the durable kernel ledger ONCE with the signed policy. The executor never creates it, so a missing ledger refuses |
| `executor.ts` | the dry-run payment path: L1 checks + NPA preflight, kernel, send, read back |
| `scenarios.ts` / `dry-run.ts` | the offline dry run (Hardhat at chain 84532, throwaway keys). CI runs the same list on the in-memory chain: `tests/l1-dryrun.test.ts` |

## Run (PowerShell, from the repo root, after `npm ci --legacy-peer-deps`)

Dry run, offline (needs a folder with its own `hardhat@3.12.0` install and an `export default {}` config; default `E:\dev\ops\loop\l1\devnet`):

```powershell
npx ts-node --transpile-only scripts/l1/dry-run.ts
```

The real sequence, LATER, one step at a time (the report `E:\dev\reports\2026-10-21\LANE_E_L1_DRYRUN.md` has the order and the stop conditions):

```powershell
npx ts-node --transpile-only scripts/l1/make-policy.ts --owner 0xYOUR_OWNER --buyer 0xBUYER --seller 0xSELLER --hours 48
npx ts-node --transpile-only scripts/l1/review-sheet.ts --payload E:\dev\ops\loop\l1\l1-typed-data.json --experiment E:\dev\ops\loop\l1\l1-experiment-policy.json --check E:\dev\ops\loop\l1\l1-review-sheet.md
npx ts-node --transpile-only scripts/l1/sign-server.ts --payload E:\dev\ops\loop\l1\l1-typed-data.json --experiment E:\dev\ops\loop\l1\l1-experiment-policy.json
npx ts-node --transpile-only scripts/l1/init-ledger.ts --ledger E:\dev\ops\loop\l1\kernel-ledger.jsonl --signed E:\dev\ops\loop\l1\l1-signed-policy.json --experiment E:\dev\ops\loop\l1\l1-experiment-policy.json --owner 0xYOUR_OWNER
```

Stop it at any time: `New-Item E:\dev\ops\loop\l1\KILL` (every payment is refused before any effect while the file exists).

## The capability registry flag

`KERNEL_CAPABILITY_REGISTRY_ENABLED` stays unset for L1. The executor sets `class: 'spend'` itself (never from model
output) and the policy lists only `spend`, so a call filed as read, other or post is DENIED (`action_not_permitted`).
The registry runs a boot-registered function with no arguments, which cannot carry a per-payment amount and recipient.
Reasoning in the header of `src/kernel/l1.ts`.

## Not built yet (needed before arming)

The unattended runner: generating the two disposable wallets on the operator's machine (keys never printed), the x402
tier gate in the path, the schedule line. `executor.ts` is the dry-run path, not that runner.
