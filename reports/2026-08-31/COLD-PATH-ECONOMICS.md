# What a stranger actually gets, and what it costs

**MEASURED 2026-08-31 against production.** Every number below came from running something.
Where a thing could not be run, it says NOT_CHECKED and names what would close it.

The acceptance gate proves the four capabilities work for an agent that already has a stored
proof. It had never tested what happens **cold** — someone with no account, no key, no history.
So one was registered and driven end to end.

---

## 1. The cold path works. Timed.

| t | event | latency |
|---|---|---|
| +0 s | `POST /agents/register`, keyless, HTTP 201 | 1.06 s |
| | → agent id, api key, a real custodied wallet, score 200 PROBATIONARY | |
| | → `erc8004_token_id: null` — honest NOT_MINTED, no fabricated identity | |
| +0 s | `POST /agents/:id/score-event` with the key registration returned | 1.31 s |
| | → HAL ran: **5 providers**, approved, dissonance 0.4288. Returns a proof job id | |
| **+4.96 s** | **zk proof COMPLETE**, row written, publicly retrievable | |
| | → `eas.anchored: false` | |
| **+2 m 09 s** | **EAS attestation MINED on Base Sepolia** | |
| | → receipt `status 0x1`, block 46,184,058, `to` = the canonical EAS contract | |

**Zero to an on-chain attestation for a stranger: 5 min 30 s.**

### The controlled comparison that makes this attributable

The same cold-install gate — `npm i @hyperdag/trustshell` into an empty dir, no keys, no repo
checkout — was run twice in the same minute against two agents. One variable.

| leg | flagship agent | brand-new stranger |
|---|---|---|
| `zkrepid.proof` | MEASURED | MEASURED |
| **`zkrepid.freshness`** | **FAILED — 30 days old** | **MEASURED — 0.0 days old** |
| `zkrepid.tamper_evidence` | MEASURED | MEASURED |
| `hal.verify` | MEASURED, 5 providers | MEASURED, 5 providers |
| `x402.discovery` / `payment_header` | MEASURED | MEASURED |
| `zkrepid.privacy` | FAILED | FAILED |
| `zkrepid.expiry_binding` | FAILED | FAILED |
| `chain.reachable` / `erc8004.registry` | NOT_CHECKED | NOT_CHECKED |
| `erc8004.identity_for_new_user` | FAILED | FAILED |

**The prover is minting.** The flagship's stale proof is a *backlog*, not a broken prover — a
stranger who registered minutes earlier holds a fresher proof than it does. That distinction was
not derivable from either run alone, which is the entire reason both were run.

Client-side proof verification: **12–13 ms**. HAL quorum: 539–2173 ms. x402 header build: 10–11 ms.
All n=1 from single cold runs — enough to establish order of magnitude and liveness, not enough
to tune anything.

---

## 2. On-chain anchoring is not the expensive part. It is nearly free.

Two anchor transactions were read back from chain:

| batch size | gas used |
|---|---|
| 1 proof | 449,000 |
| 100 proofs | 448,976 |

**Flat.** Only the Merkle root goes on chain, so the cost is constant regardless of how many
proofs it covers. That amortisation is already built and already running.

At the live Base mainnet gas price (0.006 gwei) and ETH mid at the time of measurement, one
anchor transaction costs **$0.0066** — L1 data fee included, which is 1% of the total.

| batch | $ per proof | $ per million proofs |
|---|---|---|
| 1 | 0.00655623 | 6,556 |
| 100 *(the running default)* | 0.00006556 | **66** |
| 1000 | 0.00000656 | 7 |

The probe hit the batch-of-1 case only because it was the sole unanchored proof in the queue.
Under load the system already batches to 100.

**Conclusion: cost is not a reason to weaken the on-chain promise.** A million anchored proofs
costs about sixty-six dollars.

---

## 3. The proof is 28x larger than it needs to be

One live proof, measured:

```
base64 on the wire   14,232 chars
raw                  10,673 bytes      (base64 costs +33%)
entropy               3.64 bits/byte   (8.00 = random)
zero bytes            58.5%
zlib -9                 370 bytes      28.8x
zlib -9 + base64        496 bytes      28.7x smaller than what ships today
```

**A hypothesis that was wrong, recorded because the wrong one is the useful part.** The obvious
read of "58% zeros" is BabyBear field elements padded into 64-bit slots — a mechanical 2x. It is
not: only 41.6% of 8-byte slots have a zero high half, and 550 of those 555 are *entirely* zero
slots. A lossless u64→u32 repack buys **1.26x**, not 2x. The redundancy is whole-zero structure,
not padding. Measuring beat inferring by a factor of ~1.6.

The proof is real regardless — it verifies, and the gate confirms falsifying `agent_id`,
`repid_score` or `threshold` each breaks verification. High compressibility here is an encoding
property, not evidence of an empty proof.

**Storage at scale:** 1M proofs = 10.7 GB today → **0.37 GB** compressed.

Encryption is a separate question and the answer is no: these are *public* attestations whose
whole purpose is third-party verification. Encrypting them would defeat the product. The one
thing in this payload that deserves privacy is the score, and encryption is the wrong tool for
that — see §5.

---

## 4. The gap was never the pipeline. It was the word "false".

For the two minutes between proof and anchor, the public surface said `eas.anchored: false` —
identical to what it says about a legacy row that will never be anchored at all. One boolean,
two unrelated truths, and the honest answer during that window is **not yet**.

This is the house defect: **NOT_YET rendered as NO.** Same shape as the identity boolean removed
in #548, same shape as the settlement outage where NOT_CHECKED scored as FAILED and disputed
contracts nobody had checked.

The offchain-receipt-now / on-chain-attestation-later architecture is therefore **already live**.
It was never announced as such, so it read as a failure.

Fixed in this branch: `anchor_status` of `ANCHORED` / `PENDING` / `OVERDUE` / `NOT_ELIGIBLE`,
each with a note written for the person refreshing their own passport. `PENDING` says the proof
is *already verifiable offline right now* — that is the expectation worth managing, and it is
true. `anchored` is kept byte-identical for published consumers.

---

## 5. What is still not honest, in priority order

1. **`zkrepid.privacy` — FAILED, both agents.** The score is a **public circuit input**. Four
   surfaces claimed it "proves a threshold without revealing the score"; the badge was corrected
   earlier, the other three are corrected in this branch. The proof is **tamper-evidence, not
   privacy**. Making it genuinely private is a circuit change, not a copy change.
2. **`zkrepid.expiry_binding` — FAILED.** Nothing binds a validity window, so a proof from any
   date verifies forever. `valid_from` / `valid_until` as circuit inputs is the fix.
3. **A new user's threshold is 0.** The statement proved is `score >= 0`. For a stranger it is
   close to vacuous — the tamper-evidence over `agent_id` is doing all the work.
4. **`erc8004.identity_for_new_user` — FAILED by design.** `register()` never mints; minting is
   key-gated. Documented, not accidental, but it means "create a PAI agent on trustshell.dev"
   does not yet include an on-chain identity without a second gated step.
5. **A new user sees no score movement for 30 days.** The first 500 RepID vests over a cliff, so
   a delta of 19 landed in `vested_repid` and `current_repid` stayed at 200. Correct anti-Sybil
   behaviour, invisible to the user, and it will read as "nothing happened".
6. **The backlog, not the prover.** Established agents hold month-old proofs because nothing
   re-mints on read. A stranger now gets a better artifact than the flagship.

---

## What this does NOT establish

- **Chain reachability from a sandbox.** Six public Base RPCs and both explorers return
  `CONNECT tunnel failed, 403` — the proxy refusing, not a server answering. The receipts above
  were read through a different egress path. `chain.reachable` NOT_CHECKED in the gate is correct.
- **`OVERDUE` has never been observed on a live row.** It is derived from the worker's poll
  interval, not from a measured late anchor.
- **n=1 on every latency figure.** One cold run establishes liveness and order of magnitude. It
  does not support tuning a weight, a quorum size or a budget, and a few real events a day will
  not either.
- **Mainnet gas was read live; the anchor transactions themselves were testnet.** The dollar
  figures are what the same transaction *would* cost on mainnet at that moment, not what was paid.
