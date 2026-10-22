# RepIDStaking: risk finding and minimal access-control design

**Status: design only.** Nothing here is deployed, and no transaction was sent to write it.
Deploying or funding any staking contract is MAJOR and needs Sean, one item at a time.

## 1. Finding (measured 2026-10-22)

`contracts/RepIDStaking.sol` has no caller access control. `tests/repid-staking-access-control.test.ts`
pins each point below from the compiled AST.

| Defect | Where | Effect |
|---|---|---|
| `approve(stakeId)` has no modifier and never reads `msg.sender` | `contracts/RepIDStaking.sol:50` | Any address can release any pending stake. That includes the staker, who can release its own stake before anyone slashes it, so slashing cannot be enforced. |
| `slash(stakeId)` has no modifier and never reads `msg.sender` | `contracts/RepIDStaking.sol:58` | Any address can slash any pending stake. |
| Slashed ETH has no exit | `:61-65`, and `receive()` at `:73` | Only `approve` sends ETH. There is no withdraw function, so a slashed stake, or ETH sent directly to the contract, is locked forever. The comment calls it an "insurance pool", but nothing can spend from it. |
| A stake that does not exist reads as pending | `:52`, `:60` | A missing struct has `status == 0`, so `approve`/`slash` on an unused id succeeds and emits a false `Approved`/`Slashed` event. This happened on chain: `approve(0)` ran in tx `0x6d75ca7e…824f`, and id 0 can never be issued. |
| Nothing is bound | `:35-47`, `:10` | Any address can stake on any `agentId`. `decisionHash` is an unchecked number that can be reused without limit. `identityRegistry` is stored and never read. |

**Deployment, measured read-only** (public RPC `eth_getCode` / `eth_call`, plus Blockscout; no key used, no transaction sent):

- The repo names one address, `0xd35331Bf94b1A4F4CAf595951056C288ce58C4fA` on Base Sepolia (84532). It appears in `src/services/metrics-snapshot.ts:123`, is served at `GET /api/v1/metrics`, and is listed in `docs/USER_GUIDE_FIRST_5_MINUTES.md`.
- Code is present. The deployed dispatcher has exactly this source's eight selectors and no others: no `owner()`, no `withdraw`. Blockscout does not have the source verified.
- Simulating `slash` and `approve` from `0x…dEaD` succeeds. As a control, the same call on a stake that is already approved reverts with "Not pending".
- History: 4 transactions, all on 2026-04-20, all from the Trinity deployer `0xdf6b…271d`. They were a create, `stake` of 0.0001 ETH (id 1), `approve(0)` (the ghost id) and `approve(1)`. `stakeCount` is 1, stake 1 is approved, and the **balance is 0**.
- **Verdict: deployed and unrestricted, but holding no value. Not a P0 today.** It is a blocker for any funded use.
- **RepID impact today: none.** `STAKE` earns delta 0 (`src/engine/repid-update.ts:620-632`), and no code reads `Staked` or `Slashed` events.

## 2. Minimal design: replace it, don't patch it

**Roles**

- **Staker:** must be the agent's owner or registered operator. Checked against the identity registry at stake time.
- **Counterparty:** the party the agreement is with. Named at stake time. Must differ from the staker.
- **Adjudicator:** a contract or multisig set at deploy. It may never be the staker or the counterparty of the stake it rules on, and this is checked inside `resolve`, not just set in config. It can be rotated only by the governor, behind a timelock.
- **Governor:** a multisig. It can rotate the adjudicator and pause new stakes. It **cannot move any stake.**

**One-use agreement binding.** `agreementId = keccak256(chainId, address(this), termsHash, staker, counterparty, nonce)`. A mapping `used[agreementId]` allows one stake per agreement. Every event carries `agreementId`.

**Lifecycle:** PENDING, then DISPUTED (optional), then RELEASED or SLASHED.

- The counterparty alone may call `dispute(stakeId)`, and only within `DISPUTE_WINDOW` of staking. The window is immutable and set at deploy.
- With no dispute, the staker may call `release(stakeId)` only after the window closes. This replaces the old `approve`; no one can release early.
- With a dispute, only the adjudicator may call `resolve(stakeId, agreementId, slash, evidenceHash)`, and only before `ADJUDICATION_DEADLINE`. If the deadline passes, the stake becomes releasable to the staker, so funds can never get stuck.
- A slashed stake is credited to a named recipient (the counterparty, or a pool with a timelocked governor withdrawal) through pull payments. **No ETH path ends inside the contract.**

**Replay and idempotency**

- Every state change requires `stake.staker != address(0)`, so an id that does not exist reverts.
- Each transition happens only from its one legal prior state.
- `resolve` checks the `agreementId` as well as the id.
- `chainId` is part of the agreement hash.
- Payouts follow checks-effects-interactions with a reentrancy guard.

**No self-approval:** the staker cannot release early, cannot dispute its own stake, and cannot adjudicate it. The adjudicator cannot be a party to the stake.

**Off-chain:** a STAKE RepID delta stays at 0 until a server-side verifier exists. That verifier reads the receipt, matches the `Staked` event to `agentId` and `agreementId`, and refuses a reused tx hash. That is the open `TODO(STAKE-VERIFY)` at `repid-update.ts:631`, and it is MAJOR.

## 3. Negative tests required before any testnet use (named, not written)

These need a local EVM (Foundry or Hardhat), and none is a dependency of this repo today.

- `test_RevertWhen_StrangerSlashes`
- `test_RevertWhen_StrangerReleases`
- `test_RevertWhen_StakerReleasesBeforeWindow`
- `test_RevertWhen_StakerDisputesOwnStake`
- `test_RevertWhen_AdjudicatorIsStakerOrCounterparty`
- `test_RevertWhen_ResolveWithoutDispute`
- `test_RevertWhen_NonCounterpartyDisputes`
- `test_RevertWhen_DisputeAfterWindow`
- `test_RevertWhen_ResolveAfterDeadline`
- `test_RevertWhen_StakeIdDoesNotExist`, run on id 0 and on `stakeCount + 1` for every mutator
- `test_RevertWhen_AgreementIdReused`
- `test_RevertWhen_AgreementFromOtherChain`
- `test_RevertWhen_ResolveTwice`
- `test_RevertWhen_ReleaseTwice`
- `test_RevertWhen_ResolveAfterRelease`
- `test_RevertWhen_StakeForAgentNotOwned`
- `test_RevertWhen_CounterpartyIsStaker`
- `test_RevertWhen_GovernorMovesStake`
- `test_RevertWhen_AdjudicatorRotatedBeforeTimelock`
- `test_RevertWhen_ReentrantRelease`
- `test_NoEventForMissingStake`
- `test_SlashedFundsWithdrawableOnlyByRecipient`
- `test_ReleaseAfterAdjudicationTimeout`
- `invariant_BalanceEqualsPendingPlusWithdrawable`
