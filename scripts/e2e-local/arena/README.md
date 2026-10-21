# L0 agent-to-agent commerce arena

A fully local arena for payments between two synthetic agents. It runs the engine's **existing executor** (the kernel,
`src/kernel`, plus the x402 authority gate, `src/services/x402-gate.ts`) against a throwaway Hardhat devnet (chainId 31337),
records what happens as data, and grades it with a deterministic oracle. It changes nothing in `src/`.

Level 0 only: no testnet, no mainnet, no real keys, no production database, no real RepID. Agents are an injected interface; this
repo holds no key and makes no model call. The loop that drives it with free open-source models lives outside the repo.

## What is real and what is mocked

| Real (the code under test) | Synthetic |
|---|---|
| `runUnderKernel` with an owner-signed EIP-712 policy and a durable JSONL ledger | the chain: a local Hardhat devnet (or an in-memory twin for the offline test) |
| `checkTransactionAuthority` (the x402 gate), USDC only | "USDC": a 6-decimal mock token deployed by the arena (`contracts/MockUSDC.sol`), plus a decoy token with the same symbol |
| `applyServiceSatisfiedDeltas` (the RepID delta function) | the engine store: `LOCAL_MODE`, a temp SQLite file, synthetic agents |
| the chain read-back (receipt status, `Transfer` log, native value, balances, nonce) | all keys: generated in memory per exchange, never written, never printed |

## The pipeline for one payment

```
presentation (NPA signed by both parties + the request)
  -> preflight   src/services/npa-preflight.ts (pure; guard.ts is its I/O shell)
                            policy file hash + pinned id + expiry + kill switch; both NPA signatures; wallet / chain / asset /
                            counterparty / cap / quote checks; request == NPA; asset verified on its own chain.  Can only REFUSE.
  -> x402 gate   (USDC)     tier authority.  Can only REFUSE.  ETH has no gate: it is denominated in USDC and no ETH price is invented.
  -> kernel      runUnderKernel(tool = send + read back).  The ONLY thing that authorizes.
  -> settlement  classifySettlement(chain read-back): SETTLED only on an exact match; not found / no receipt = UNKNOWN; reverted or different = FAILED.
```

The preflight exists because the kernel's signed policy deliberately does not constrain the asset or the chain, and has no notion of an
NPA, a quote, a pinned experiment policy or a kill-switch file. It lives in `src/` (`src/services/npa-preflight.ts`, unit-tested in
`tests/npa-preflight.test.ts`) because it is part of the executor: a harness script is not an executor. It does **not** consume the
authorization once; that belongs to the kernel's gate (see below).

**The authorization identity is the NPA's EIP-712 digest** (`npaHashOf`: what both parties signed), not a hash of its JSON. An address and a
bytes32 enter it as bytes, so one signed agreement is one authorization however its hex fields are spelled. (It used to be sha256 of the JSON,
and the same two signatures drew a fresh one-use key per spelling: a re-cased NPA paid again.) The arena puts it in the kernel request's
`args_hash`; an NPA carrying a property it does not define is refused as malformed.

## Files

| File | Role |
|---|---|
| `oracle.ts` | the 18 cases, `predict` (frozen before a case runs) and `grade`. Pure. Its sha256 is written into each policy as `evaluator_sha256`. Meant to be frozen by the adversarial lane. |
| `cases.ts` | one script per case; each changes exactly one thing in a valid NPA and presents it |
| `core.ts` | re-exports the pure pieces from `src/services/npa-preflight.ts` (canonical JSON, the policy and its id, the NPA); signs an NPA with viem; the settlement classifier |
| `guard.ts` | the I/O shell of the preflight: reads the policy file and the kill-switch file, asks the chain for its id and the token's `symbol()` / `decimals()`, then calls the pure check |
| `world.ts` | one exchange's world and the executor (`present`), the RepID leg |
| `chain.ts` | `ViemChain` (devnet) and `MemoryChain` (offline twin) behind one interface |
| `agents.ts` | the injected agent interface, a deterministic stub, the loopback HTTP client, and the code that validates what a model proposes |
| `runner.ts` / `cli.ts` | one exchange to one evidence record; the batch driver the loop launches |
| `contracts/` | `MockUSDC.sol` and its compiled ABI + bytecode |

## Run it

Offline (no node, no network): `SUPABASE_URL=http://localhost:54321 SUPABASE_SERVICE_ROLE_KEY=dummy-key npx jest tests/arena-l0.test.ts`.
The test file also runs the same assertions against a real devnet when the variable read at its last lines (`rpc`) holds a devnet URL;
without it that suite is reported as skipped.

A throwaway devnet: run `hardhat node --port <p>` from any folder that has a minimal `hardhat.config.mjs` (`export default {}`), a
`package.json`, and a Hardhat 3 install. Then point the batch driver at it:
`npx ts-node --transpile-only scripts/e2e-local/arena/cli.ts --rpc http://127.0.0.1:<p> --stub --out-dir <dir>`.
`--stub` uses deterministic agents; without it the driver needs the loopback bridge the loop provides.

To rebuild the mock token: `solc --combined-json abi,bin --optimize --evm-version shanghai contracts/MockUSDC.sol` (solc 0.8.24), then
store `{contract, solc, flags, abi, bytecode}` in `contracts/MockUSDC.json`.

## Evidence

One JSON per exchange: `run_id, case, prediction (frozen before execution), frozen {git_sha, policy_id, chain_id, block, model_ids,
evaluator_sha256}, npa_hash, observations {attempts, kernel_decisions, tx_hashes, readback, balances, ...}, discrepancies,
oracle_verdict, judge_note (advisory only)`. Verdicts are `PASS`, `FAIL`, or `NOT_CHECKED` (a model error, an unusable proposal, a seller
who declines, a harness error). `NOT_CHECKED` says nothing about the executor.

## Known holes (recorded as FAIL, pinned with `it.failing`, never hidden)

None open. `KNOWN_FAILING` in `runner.ts` lists any that are; a FAIL outside it is reported as `new_failing`.

Closed by #1453: `replay_same_authorization`, `replay_after_restart`, `concurrent_x10` and `respelled_replay` (a case beyond the frozen
18: the same two signatures over the NPA with its hex fields re-spelled) each settled a second time on a kernel with no one-use
authorization. The kernel's ALLOW decision row now consumes the authorization before the tool runs: one use per agent and `args_hash`
(`authorizationKey` in `src/kernel/receipt.ts`), and `args_hash` carries the NPA's identity in the arena's requests.
`tests/arena-l0.test.ts` asserts all four PASS.
