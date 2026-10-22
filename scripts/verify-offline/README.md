# verify-offline: check TrustShell evidence with the chain and our servers switched off

`verify-offline.cjs` is one file. It needs Node 18+ and `ethers` 6, nothing from this repo, the trustshell npm package or any HyperDAG server. To audit it without trusting us: copy it to an empty folder, run `npm i ethers@6`, read it, then run:

```
node verify-offline.cjs fixtures/ledger.jsonl --owner 0x0271fa8d4470907C2a1587A836861528aa31BADD --engine-signer 0x7AdF801D0D187105D99bf0d10336b5bcEC84799B
node verify-offline.cjs fixtures/evidence-card.json
```

## The record: `trustshell-evidence/1` (one per line, or one JSON object per file)
```
{ "format": "trustshell-evidence/1",
  "kind": "owner-policy" | "kernel-receipt" | "action-evidence" | "guard-decision" | "bundle-manifest",
  "record": { ...the kind's own record, unchanged... },
  "digest": { "algorithm": "sha-256", "canonicalization": "RFC 8785", "value": "<hex>" },   // optional
  "engine_signature": { "scheme": "eip191-personal-sign", ... } }                               // optional
```
- **Verified today:** `owner-policy` (`{policy, signature}`), `kernel-receipt` (`kernel-receipt/1`), `action-evidence` (`dev.trustshell.action-evidence/0.1-draft`, from `trustshell check --claims --json`).
- **Reserved:** `guard-decision` and `bundle-manifest` report NOT_CHECKED, never a pass. So does an unknown `format`.
- **Unwrapped forms are also accepted:** the kernel ledger's own lines, and `check --json`'s `{record, digest}`.
- **The scope lives inside each record:** a receipt's `does_not_attest`, a card's `assurance` and `does_not_prove`. A record that drops or inflates its scope FAILS.
- **Trust anchors come from you, never from the file:** `--owner` is the wallet that should have signed the policy; `--engine-signer` is the engine's published receipt key.
- **Outcomes:** each leg is VERIFIED, FAILED or NOT_CHECKED. Exit 0 = nothing failed and something verified; 1 = something failed; 2 = nothing verified.

## With on-chain off, what security remains?
| Leg | What holds offline |
|---|---|
| `owner_policy_signature`, `within_policy` | The owner signed this EIP-712 policy, and every ALLOW is inside it: agent, action, listed payee, per-tx, daily and total caps, expiry, newest nonce. |
| `invariants` | A refusal never ran or paid; an ALLOW rests only on PASS checks; what ran is what was authorized; each spend or post authorization is used once. |
| `receipt_hashes`, `chain_links`, `record_digest` | An edited, removed or reordered record is detected. |
| `engine_signature` | The engine's key signed this exact receipt. |
| `card_scope`, `card_verdicts` | A card's verdicts point at fields it holds. Its commit, run-id and run-success verdicts must agree with its own observation. |

**Cannot see, always NOT_CHECKED:** on-chain payments, smart-wallet owners, registry ownership, HAL quality, RepID, zkRepID and EAS, and whether GitHub really reported what a card says.
**Completeness:** a missing record never proves that no action happened.
**Signatures:** receipts are hash-chained and cards are digested, but neither is signed by default. Whoever holds the file can re-seal it. Such a rewrite is caught only when it breaks the owner's policy, an engine signature, or the card's own observation.

**Fixtures:** `make-fixture.ts` writes the ledgers using the real kernel gate, with throwaway keys and a fixed clock. The card was captured from `trustshell check` on public run 39610093655. Each `*.tampered.*` must FAIL. `tests/verify-offline.test.ts` pins all of this. **Production today:** the deployed kernel keeps its ledger in container temp storage and signs no receipts.
