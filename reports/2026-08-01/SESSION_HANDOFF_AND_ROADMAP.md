# Handoff — 2026-07-30 → 2026-08-01
**Written 2026-08-01 09:10 PDT.** Every number below was queried live at that moment. Where something is unverified it says so.

Audience: a developer, an agent, or an investor picking this up cold.

---

## 1. Status in one paragraph

The trust harness works end to end and is live. An agent posted a request for work, two agents bid against each other at different prices, the cheaper won, the buyer's payment was **held rather than spent** until the work was delivered and independently verified, then $0.10 USDC settled on Base Sepolia, both parties' reputation moved, and the change was written to ERC-8004 on-chain where we cannot edit it. That exchange is readable by anyone, with no API key, at
**https://repid-engine-production.up.railway.app/api/v1/receipt/latest**

## 2. Verified metrics (queried 2026-08-01 09:10 PDT)

| | |
|---|---|
| `main` | `0a3eb10` — deployed and healthy, `supabaseConnected=true` |
| settled contracts | **3** |
| A2A RFQs / bids | 6 / 10 |
| ERC-8004 on-chain writes | 74, of which **28 provably linked to a contract** |
| ZK proofs | 79,062 |
| proof queue pending | 40,300 — 99.3% internal churn, deliberately excluded from the drain |
| LLM routing | 5 divergent families, **zero failures**, **$0.000148/request** |

## 3. What shipped

**Pay-on-verified-delivery.** Escrow used to *settle* immediately, so the buyer had already paid before any work existed and every protection downstream was advisory. It now **verifies and holds** an EIP-3009 authorisation — a signature, not a transfer — and settles only after the deliverable passes. No escrow contract, no extra gas, and a rejected deliverable costs nothing on-chain because nothing was ever broadcast.

**A2A negotiation.** Four tables (`a2a_rfqs`, `a2a_bids`, `a2a_bid_rounds`, `a2a_awards`) plus an atomic award function. The accept request carries **no price field**; the price is read server-side from the winning bid. `agreed_price_usdc_raw` finally means what it says.

**Three security fixes.** A private key committed in source since May controlling a funded wallet. An auth bypass where an OR-chain checked only the first identity, letting a caller act as another agent. A fulfil bypass where any caller could self-declare a `PASS` and release their own payment.

**Proof drain restored.** Two root causes: a `DATABASE_URL` that failed authentication on exactly the two services that needed it, and a worker pointed at a prover holding zero of the queued jobs. Both fixed; the drain now proves **271 economic jobs instead of 40,548**, with the churn guard verified in production.

**TrustKeys.** `scan` finds secrets in code and git history, distinguishing *committed* from *gitignored* — that distinction separated 4 real findings from 340 expected ones. The keymap went from 9 variables to **101 across 1,626 placements**.

**The public receipt.** One command (`npm run demo:trust`) and one URL. Privacy enforced by tests: the contract payload and result are never served, and the field set is a closed allow-list.

## 4. What we learned — the expensive lessons

**The live system is the only source of truth.** Three phantom-column bugs in one night: `x402_settlements.facilitator_response` (silently ate a settlement write for real USDC that had already moved), `x402_settlements.amount_usdc_raw`, and `repid_score_events.new_repid`. All three are in `src/types/database.types.ts` and none exist in the database. **Query `information_schema` before writing any column name.**

**A key can be PRESENT and DEAD.** `HUGGINGFACE_API_TOKEN` was set in the reference file *and* on the deployed service, and HuggingFace answered "not supported by any provider you have enabled" — an entitlement failure, not an auth failure. Every presence check said fine. This is why TrustKeys probes rather than checks, and why the fix was an operator-stated disable list: liveness is not knowable from config.

**A loud failure finds bugs a silent one hides.** Removing an `unref()` so `direct-pg` reported a fatal config error instead of exiting quietly is what surfaced the dead `DATABASE_URL` — a six-week outage that had survived a correct fix because the real blocker was invisible.

**Duplicated knowledge drifts.** The service-handler list lived in two files and `security_audit` was in one and not the other for weeks, so those contracts silently never drained. There is now one definition and a test pinning all three consumers.

**Verification must not be self-verification.** The adversarial review returned BROKEN on two of three designs and found an auth bypass the design had *depended on*. The verify pass then refuted claims the builders made about their own work, including a settlement leg selecting a column that does not exist.

**Mistakes I made and what changed.** I merged nothing on a red check, but I broke a passing test with a security fix and spent hours guessing at it before measuring — the rule now is: when something resists three attempts, stop, measure, or change approach. I also ran a 12-agent workflow where 3 would have done; by the graph-engineering standard we adopted, that was over-engineering. Default to loops, escalate on signals. And I twice reported a fingerprint from a hand-rolled hash instead of the tool's — conclusions held, but the numbers were not comparable. Use the tool's own output.

## 5. Biggest challenges, honestly

1. **No frozen ground-truth corpus for HAL.** F1 has been quoted at 0.34, 0.74, 0.886 and 0.890 — those are different rulers, not improvements. Until a fixed, provenance-checked labelled set exists, any loop that "improves HAL" is hill-climbing noise. It cannot be synthesised.
2. **ANFIS is starved.** One canary agent now routes through the engine; the other 11 still call providers directly, so the router sees almost none of the fleet's real decisions.
3. **Visibility, not capability.** The system does more than anyone can see. The receipt is the first crack in that.
4. **RepID reward is price-decoupled.** A $0.01 contract pays the same reputation as a $10 one. A floor stops the degenerate case; the reward is not yet value-weighted.
5. **Collusion is countable, not prevented.** Two agents under one operator can transact at any price. Every losing bid and a frozen decision snapshot are retained so a suspicious award is inspectable — that is the honest claim.

## 6. Roadmap

**Now (days)**
- Point a domain at the receipt — `trustshell.dev/receipt/latest` reads better than a Railway URL. DNS + proxy rule, no code.
- Watch the canary (`trinity-mel`); if clean, roll `ENGINE_LLM_PROXY` to the remaining 11.
- Decide the HAL ground-truth corpus. This gates everything measurable.

**Next (weeks)**
- Value-weight RepID so price and reputation are coupled.
- Wire `zkp_audit` as a sellable service (built, unwired, open defects documented).
- Anonymous red-team audit (built, unwired, verification REFUTED two claims).
- Link a ZK proof to the *delivered work*, not just a RepID delta.

**Later**
- Human binding — the "H" in HAPTL and the least built leg.
- Rotate the exposed credentials once `scan` runs in CI on every commit.

## 7. What Sean needs to do

| # | Action | Why |
|---|---|---|
| 1 | Decide the HAL ground-truth corpus | Only you can define what counts as truth here; it cannot be synthesised, and everything measurable is blocked on it |
| 2 | Point a domain at `/api/v1/receipt/latest` | Makes the proof postable |
| 3 | Rotate 4 committed credentials | `DEPLOYER_PRIVATE_KEY` ×2 files, `SUPABASE_SERVICE_ROLE_KEY` ×2 files — see `KEY_AUDIT_VERIFIED.md`. Not urgent (private repo, testnet) but real |
| 4 | Rotate 3 dead keys | ElevenLabs, SiliconFlow, Telegram — none is in the LLM path |
| 5 | Decide merge authority | 20+ PRs merged by hand this week; the loop produces faster than merges land |
| 6 | Decide on 13 RLS-off tables | Two are `peer_verify_*` with anon INSERT — anyone with the anon key could poison verification metrics |

**Do NOT rotate `FIREWORKS_API_KEY` or `PERPLEXITY_API_KEY`** — their probes were INCONCLUSIVE, which is not the same as dead.

## 8. For an investor, in four sentences

AI agents are beginning to transact with each other, and there is no way to know whether the work was any good — you have already paid. We built the harness that makes being wrong cost something: the price is competed, the money is held until the work is independently verified by models that fail differently, and the outcome is written to a public blockchain we cannot edit. It runs today at a fraction of a cent per verification, on free model tiers, on a five-year-old laptop. The receipt is public: anyone can check the claim without trusting us.
