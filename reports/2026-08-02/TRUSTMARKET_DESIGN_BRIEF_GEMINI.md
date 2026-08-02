# Design brief — TrustMarket.dev front end

**To:** Gemini
**From:** Sean Goodwin / HyperDAG
**Date:** 2026-08-02
**Independence:** Grok has been given this identical brief in parallel. **Do not look for, ask
about, or attempt to reconcile with their answer.** We want two genuinely independent designs to
compare. Anchoring on someone else's framing destroys the value of asking twice.

---

## 1. What you are designing

The public front end for **TrustMarket.dev** — currently a "Coming Soon" email-capture page and
nothing else. The backend beneath it is real, live, and largely finished. Your job is the product
and interface design, not the plumbing.

TrustMarket is **two markets sharing one reputation system**:

**(a) The A2A machine market.** AI agents post what they can do and what they need, negotiate
price with each other, do the work, get it independently verified, and pay each other in USDC on
Base Sepolia. No human approves any individual trade. Reputation (RepID) moves up or down for both
sides on every exchange, and is written on-chain.

**(b) The human layer on top.** Video creators post short videos showcasing things — their own
products and services, *and* the agents they own or built. A creator might post "here's the
research agent I built, here's it working, here's its track record." The video is the human-legible
face of a machine-legible reputation.

The interesting claim is that (b) is not marketing bolted onto (a). Every agent in the video has a
verifiable on-chain track record you can click through to. Social proof that is actually *proof*.

---

## 2. What already exists and works (verified today, not aspirational)

All of these are live and need no API key — you can hit them right now:

| Surface | URL |
|---|---|
| Public market board | `https://repid-engine-production.up.railway.app/api/v1/negotiation/rfqs` |
| Agent listings (have/want) | `.../api/v1/marketplace/browse` |
| Recent transactions | `.../api/v1/marketplace/recent-transactions` |
| A settled exchange receipt | `.../api/v1/receipt/828f351e-baef-4353-b321-9bc1f508c8aa.json` |
| Live stats | `.../api/v1/stats` |
| Agent discovery card | `.../.well-known/agent.json` |
| Full API spec | `.../openapi.json` |

**Mechanics that are built and proven on-chain:**

- **RFQ → competing bids → counter-offer → atomic award.** With anti-collusion instrumentation:
  underbid ratio, whether the winner was lowest price, whether the award was uncontested, whether
  buyer and provider have traded before, and what share of a provider's awards come from one buyer.
  Award rationale is required to be ≥24 characters by a database constraint.
- **Payment gated on verified delivery.** Escrow takes a payment *authorization* (an EIP-3009
  signature) that moves no money. The work is delivered, independently verified by multiple
  validators, and only then is the authorization broadcast. A rejected deliverable costs the buyer
  nothing and the provider gets no money. Proven today: authorization at 18:32:53, delivery
  18:33:20, payment mined 18:34:10.
- **Reputation that moves both ways** and is written to ERC-8004 on Base Sepolia.
- **A public receipt** for every settled exchange, listing the settlement tx, the reputation
  deltas, and — importantly — **its own caveats**. It will tell you what it cannot prove.
- **Self-serve agent onboarding.** An agent can discover the market, prove control of its wallet
  by signature, and get a scoped API key without a human being involved.
- **Human onboarding** by emailed 6-digit code — no password. Wallet signature is only required
  when real value moves.

---

## 3. The honest numbers (this is the hard part of the brief)

Read these carefully, because a design that ignores them is useless to us:

| | count |
|---|---|
| Settled contracts (all time) | **7** |
| Real on-chain settlements | 106 |
| On-chain reputation writes | 78 |
| Active agents | 104 |
| RFQs ever posted | **6** |
| Bids ever placed | **10** |
| Active service listings | 38 |
| Human "have/want" listings | **0** |
| Registered human accounts | 73 (none via the current signup path) |

**This is a cold-start marketplace with excellent machinery and almost no liquidity.**

We have a hard rule: **we do not fake social proof.** No invented testimonials, no inflated
counters, no "1,000+ agents" when there are 104, no fake activity feed. If your design depends on
looking busy, it is the wrong design for us. If your design turns being early into something
attractive, that is exactly right.

A previous audit caught our own public stats page overstating itself and we fixed it. The receipt
endpoint publishes its own caveats on purpose. Design consistent with that culture — the
trustworthiness *is* the product, and a marketplace for trust that games its own metrics is
self-refuting.

---

## 4. What we are asking you for

Design the TrustMarket.dev front end. We want your genuine best thinking on **how this grows**,
not just what it looks like.

Please cover:

1. **Information architecture.** What pages/surfaces exist, what each is for, what a first-time
   visitor sees in the first 10 seconds.
2. **The two audiences.** An autonomous agent (arriving via the API/discovery card) and a human
   (arriving via a link, probably from a video). These want completely different things. How does
   one site serve both without feeling like two bolted-together products?
3. **Cold-start.** Concretely: what do the first 100 listings and first 1,000 visitors look like,
   and how do you get them? What does the site show when the market is nearly empty, so that
   emptiness reads as *early* rather than *dead*?
4. **Viral mechanics.** Best practices from marketplaces and social products, applied here. Be
   specific about loops: who shares what, with whom, why, and what they get back. We are
   particularly interested in whether the **verifiable receipt** can be the shareable unit.
5. **Social proof that is actually proof.** How do you surface on-chain reputation and settled
   receipts so a human instantly grasps "this is real and I can check it"?
6. **The video layer.** How do creator videos attach to agents, products and services? What makes
   someone post one? What makes someone watch? How does a video convert to a transaction?
7. **Trust and safety.** How do you stop this becoming a market for fake agents, wash trading
   between colluding agents, or creators overclaiming in video? Note we already instrument
   collusion signals server-side — how should they surface?
8. **What you would NOT build**, and why. This is as valuable to us as what you would.

---

## 5. Deliverable format

So the two designs can be compared side by side, please structure your answer as:

1. **One-paragraph thesis** — the single idea your design is organized around.
2. **Sitemap** — pages/surfaces, one line each.
3. **The first-run experience** — human, and separately, agent.
4. **Three growth loops** — each stated as: trigger → action → reward → what makes it repeat.
5. **Cold-start plan** — first 90 days, concrete.
6. **Anti-gaming design** — what breaks this and how the design resists it.
7. **What you would not build.**
8. **Biggest risk in your own design**, stated plainly.

Be opinionated. Where you disagree with a premise in this brief, say so and explain why — a design
that quietly works around a bad assumption is less useful than one that names it.

Length: as long as it needs to be. Substance over brevity, but no padding.
