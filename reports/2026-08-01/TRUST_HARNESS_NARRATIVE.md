# The Trust Harness — what it is, for two audiences

## For anyone

**The problem.** AI agents are starting to buy things from each other. When your agent hires another agent, you have no way to know whether the work was any good — and you've already paid.

That's the whole gap. Not "AI might be wrong." Everyone knows AI might be wrong. The gap is that **being wrong costs the agent nothing**, so nothing pushes it to be right.

**What we built.** A harness that makes being wrong expensive.

Four things happen around every job, automatically:

1. **The price is negotiated, not announced.** The buyer posts what it needs. Providers bid against each other. The buyer picks one. The winning price is recorded along with every bid it beat — so if a suspiciously cosy deal happens, the record shows it.

2. **The money is promised, not paid.** The buyer signs a payment authorization up front. Nothing moves. The provider can see the money is real and committed; the buyer still has it.

3. **The work gets checked before anyone is paid.** Several independent AI models look at the deliverable — deliberately different models, because two copies of the same model make the same mistakes. If they don't agree it's sound, **the payment is never released.** The signature simply expires and the buyer keeps their money.

4. **The outcome is written where nobody can quietly edit it.** Both parties' reputation scores move — up for good work, down for bad — and that change is recorded on a public blockchain. Not on our server. Not in a database we control. Somewhere we cannot go back and change it.

**Why that last part matters.** A reputation score you can edit is marketing. A reputation score anyone can independently check is a credential. Ours is the second kind — you can look up the transaction yourself and see the score change, without asking us.

**The honest version.** None of this makes AI truthful. It makes dishonesty and sloppiness *cost something*, and it makes the cost visible to the next buyer. That's a weaker claim than "trustworthy AI," and it's one we can actually back with receipts.

---

## For developers

### The primitive

`RepID` is a behavioural reputation score that gates real money. The harness is the loop that makes the score mean something.

```
RFQ ──► competing bids ──► atomic award ──► escrow (AUTHORIZE, don't settle)
                                                      │
                                     work ◄───────────┘
                                       │
                        HAL cross-model verdict + independent peer verify
                                       │
                    ┌──────────────────┴──────────────────┐
                 PASS                                   FAIL
                    │                                     │
          x402 settle (real USDC)              authorization voided
                    │                          buyer keeps the funds
          RepID Δ both parties                          │
                    │                          provider RepID penalty
          ERC-8004 write (on-chain)
```

### The four protocol pieces

**HyperDAG / HAL** — cross-model hallucination detection. Multiple *independent model families* judge an output; agreement between two instances of the same model is not evidence, so family diversity is a hard requirement, not a nice-to-have.

**x402** — payment. The key insight is that EIP-3009 `transferWithAuthorization` is a **signature, not a transfer**. `/verify` and `/settle` are separate facilitator calls, so you can prove a payment is funded and valid *without broadcasting it*. That gives you real escrow with **no escrow contract, no deployment, and no extra gas** — and a rejected deliverable costs zero on-chain, because nothing was ever broadcast.

**ERC-8004** — the reputation registry on Base. RepID deltas from settled work are written on-chain, so a counterparty's history is verifiable by anyone without trusting our API.

**ZKP (Plonky3 / Poseidon2)** — range proofs over RepID, e.g. *"this agent's score exceeds N"* without revealing the score. Proofs are now linked to the contract that earned them.

### Honest boundaries — read before quoting any of this

- **Verification is not a lock.** Between authorize and settle, a buyer could spend the same USDC elsewhere and the settle fails. A real on-chain escrow wouldn't have that; it's the price of not deploying one. It is detectable (nobody gets paid), not silent. **Do not describe it as "funds held."**
- **The ZK proof attests a RepID *range*, not the delivered work.** Linking it to a contract gives traceable provenance, not proof the work was done.
- **Collusion is made countable, not impossible.** Two agents under one operator can transact at any price they both accept. Every losing bid and a frozen decision snapshot are retained so a suspicious award is *inspectable*. Uncontested awards must carry a written justification, enforced by a database constraint rather than a code path someone can route around.
- **RepID reward is currently price-decoupled.** A $0.01 contract pays the same reputation as a $10 one. There is a price floor to stop the degenerate case; the reward is not yet value-weighted.
- **"Ungameable" is not claimable.** The target is making manipulation strictly less profitable than honest work, and increasingly detectable at scale.

### What's actually verified

Every leg of the loop above ran for real on Base Sepolia on 2026-07-31 — negotiated price, authorization held with the provider's balance unchanged, delivery, verification, settlement, RepID movement both sides, and an on-chain ERC-8004 write. Transaction hashes and the full audit are in `reports/2026-07-31/E2E_NEGOTIATED_EXCHANGE_AUDITED.md`, including the defects the run exposed and how each was closed.

The design rule throughout: **a check that can't fail isn't a check.** Several protections were found to be inert — a constraint that never fired on the one case that mattered, a settlement that reported success on a write that never landed, a verdict a provider could declare about its own work. Those are documented alongside the fixes, because a harness whose failures are hidden is worse than no harness.
