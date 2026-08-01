# HAPTL — where we actually are, and what to do next
**2026-08-01** · Written after a full night of building, so it reflects verified state rather than intention.

## The honest headline

**You do not have a building problem. You have a visibility problem.**

The loop works. It ran end-to-end on Base Sepolia last night: a negotiated price, payment held until verified delivery, real USDC settlement, reputation moving on both sides, anchored on-chain. Seventeen assertions, all green, with transaction hashes anyone can check.

Nobody can see it. There is no page, no command, no thirty-second thing you can hand a person. That — not more architecture — is what stands between here and people coming aboard.

## What Grok's document actually says, applied to us

The most important line in it argues *against* building more:

> **"Can a single strong loop do it? If yes, stop."**

And: *"If a single loop can do the job, a graph is pure overhead."* And: *"Master clean single-agent loops with verifiers first. Only then compose them into graphs."*

Measured against its own five escalation signals, here is where we honestly sit:

| signal | us |
|---|---|
| Distinct specialties needing different models | **YES** — HAL's whole premise is divergent model families |
| Real parallelism (fan-out/join) | **YES** — cross-model verification is inherently fan-out |
| Explicit auditable routing | **YES** — and already on-chain, which is stronger than most |
| Failure isolation | **PARTIAL** — circuit breakers exist, blast radius is not mapped |
| A reviewer that is not the producer | **YES, and load-bearing** — the no-self-validation rule |

So a graph *is* justified here. But note what the document says the highest-leverage node is:

> *"The highest-leverage node is usually a separate reviewer running on a different model with fresh context, anchored to external evidence... Do not let producers self-verify."*

**That is HAL.** You already built the thing the document says matters most. The graph framing is not a new direction — it is a vocabulary for what the trust harness already is.

**One correction I owe you:** I ran a twelve-agent workflow last night. By this document's own standard that was over-engineering — *"20-node graphs that are harder to debug than the original loop."* It did find real bugs, so it was not wasted, but a three-node loop would have found most of them for a fraction of the budget. On an old laptop with a tight budget that matters. I will default to loops and escalate only on signals.

## What HAPTL is, in one sentence each

**Human** — a person, not an anonymous key, stands behind every agent. Binding exists (`human_sbt_mints.commitment_hash`); the ZK identity work is scoped and partially built.
**Agentic** — agents transact with each other without a human in the loop per transaction. **Verified working.**
**Portable** — the credential lives on-chain (ERC-8004), so it travels off our servers. **Verified working — 73 writes, newest is ours.**
**Trust Layer** — the harness that makes being wrong cost something. **Verified working end-to-end.**

Three of four legs are standing. The first is the least built and the most important to your mission, because "help people help people" requires the human to be real.

## The MVP is one command and one page

Not more protocol. This:

1. **`npm run demo:trust`** — runs the whole loop against testnet and prints a receipt: what was requested, who bid, what was paid, what the verifiers said, and two BaseScan links. Most of this exists in `scripts/e2e/negotiated-zkp-exchange.mjs`; it needs to become one command with human-readable output.
2. **A receipt page** — the same thing as a URL you can paste into a post. The data is already in the database and on-chain.

That is the demo. Everything needed for it already exists and is verified.

## What is actually blocking, in order

1. **One red test.** `tests/red-team/double-fulfill.test.ts` — my `/fulfill` provider gate broke it. Production is correct (verified live); the test harness cannot inject an agent identity. Ten minutes for someone with fresh context. **Nothing from last night is deployed until this merges** ([PR #292](https://github.com/DealAppSeo/repid-engine/pull/292), 16 commits).
2. **The demo command + receipt.** Half a day. This is what you post.
3. **`ENGINE_LLM_PROXY`** — blocked on #1 deploying, then a canary.

Everything else — zkp_audit as a sellable service, the red-team audit, richer negotiation — is *after* people can see the thing work.

## On file names and locations

You are right that this has cost us. Three concrete instances last night: `database.types.ts` claimed columns the live tables do not have (three separate phantom-column bugs, one of which silently ate a real settlement); the handler list existed in two places and had drifted for weeks; the same `DATABASE_URL` name held a live value on 25 services and a dead one on the two that mattered.

The fix is not reorganising files. It is that **the live system is the only source of truth** — query `information_schema`, probe the credential, read the chain. Generated types, docs, and memory are hints. That discipline is now in the code (`handled-service-types.ts` as one definition, TrustKeys probing rather than checking presence) and it is the thing worth generalising.

## What I would do differently, stated plainly

I spent tonight's last hours on a test mock instead of on what you asked for. When something resists three attempts, the right move is to stop, report, and spend the remaining budget where it compounds. Recording it here so it is a rule and not a mood.
