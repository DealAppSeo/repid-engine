# verify-offline: audit an agent's receipts with the chain and our servers switched off

`verify-offline.cjs` is one file. It needs Node 18+ and `ethers` 6, nothing from this repo, the trustshell npm package or any HyperDAG server. To audit it without trusting us, copy that file into an empty folder, run `npm i ethers@6`, read it, then run it on a ledger.

```
node verify-offline.cjs fixtures/ledger.jsonl --owner 0x0271fa8d4470907C2a1587A836861528aa31BADD --engine-signer 0x7AdF801D0D187105D99bf0d10336b5bcEC84799B
```

**Input:** the JSONL ledger the kernel writes (`src/kernel/store.ts`): owner policies and `kernel-receipt/1` records, optionally with the engine's detached signature per receipt. **Trust anchors come from you, never from the file:** `--owner` is the wallet you expect signed the policy, `--engine-signer` is the engine's published receipt-signing address. Without them those legs report NOT_CHECKED.

**Each leg reports VERIFIED, FAILED or NOT_CHECKED.** Exit 0 means nothing failed and something verified; 1 means something failed; 2 means nothing could be checked.

## With on-chain off, what security remains?
| Leg | What holds offline |
|---|---|
| `owner_policy_signature` | The owner's wallet signed exactly this EIP-712 policy (agent, actions, payees, per-tx/daily/total caps, expiry, nonce). |
| `within_policy` | Every ALLOW is inside that policy: right agent, permitted action, listed payee, under each cap, not expired, not superseded by a higher nonce. |
| `invariants` | A refusal never ran or paid; an ALLOW rests only on PASS checks; what ran is what was authorized; a spend or post authorization is used once (no replay). |
| `receipt_hashes`, `chain_links` | Any edited, removed or reordered receipt is detected. |
| `engine_signature` | The engine's key signed this exact receipt. |

**What it cannot see (always NOT_CHECKED, by design):**
- Whether a payment transaction exists on chain.
- Smart-wallet (ERC-1271/6492) owner signatures.
- Whether the owner is the agent's registered owner.
- HAL verdict quality, RepID, zkRepID proofs and EAS anchors.
- **Completeness.** A missing receipt never proves that no action happened.

Receipts are hash-chained, not signed (`header.signer` is null). So whoever writes the ledger can drop the tail, or rewrite and re-seal the whole chain. Offline, a rewrite is caught only when it breaks the owner's policy or an engine signature.

## Fixtures
- `fixtures/ledger.jsonl` comes from the real kernel gate: one policy, then 5 calls (2 ALLOW, 3 DENY: over the cap, a replay, an unlisted payee). It must PASS.
- `fixtures/ledger.tampered.jsonl` re-points the allowed spend at another payee and re-seals every hash. Its chain still verifies, and it must FAIL on `within_policy` and `engine_signature`.
- The keys are throwaways derived from public labels: never funded, worth nothing.
- To regenerate, run `npx ts-node scripts/verify-offline/make-fixture.ts`. `tests/verify-offline.test.ts` fails if the fixtures drift from what the kernel writes. It also checks that the verifier agrees with the kernel's own checks and that each leg can fail.
- **Production today:** the deployed route keeps this ledger in container temp storage and writes no engine signatures.
