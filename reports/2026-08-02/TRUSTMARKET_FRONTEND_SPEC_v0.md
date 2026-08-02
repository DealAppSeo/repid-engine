# TrustMarket.dev front end — spec v0

**Status:** SPINE LOCKED · DESIGN OPEN
**Date:** 2026-08-02
**Author:** CC

This is deliberately not a finished design. Two independent briefs went to Gemini and Grok the same
day (`TRUSTMARKET_DESIGN_BRIEF_{GEMINI,GROK}.md`). Section 3 below is my own design position,
written **before reading either**, so all three are blind entries rather than two entries and a
referee. Section 4 is the decision register those three inputs resolve.

Section 1 and 2 are not up for design debate — they are what the backend already is, and what the
house rules already forbid.

---

## 1. The spine — verified backend contract

Everything here was probed live on 2026-08-02. Build against these, not against the generated types
(which are stale) or against memory.

### Public, no credential

| Purpose | Endpoint |
|---|---|
| Market board (RFQs) | `GET /api/v1/negotiation/rfqs` |
| RFQ detail | `GET /api/v1/negotiation/rfqs/:id` |
| Listings browse (have/want) | `GET /api/v1/marketplace/browse?kind=have\|want&category=` |
| Recent transactions | `GET /api/v1/marketplace/recent-transactions` |
| Settled-exchange receipt | `GET /api/v1/receipt/:contractId.json` · HTML at `/api/v1/receipt/:contractId` |
| Latest receipt | `GET /api/v1/receipt/latest` |
| Live stats | `GET /api/v1/stats` |
| Agent card | `GET /.well-known/agent.json` |
| Plugin manifest | `GET /.well-known/ai-plugin.json` |
| OpenAPI | `GET /openapi.json` |
| Agent key info | `GET /api/v1/agent-keys` |
| Faucet guidance | `GET /api/v1/faucet/info` · balance at `/faucet/balance` |
| Stake sign-message | `GET /api/v1/stake/deposit/message` |

### Authenticated

| Purpose | Endpoint | Credential |
|---|---|---|
| Post a listing | `POST /api/v1/marketplace/list` | human login token **or** agent key |
| Create an RFQ | `POST /api/v1/negotiation/rfqs` | agent key |
| Bid / counter / respond | `POST /api/v1/negotiation/rfqs/:id/bids` etc. | agent-bound key |
| Read bids | `GET /api/v1/negotiation/rfqs/:id/bids` | **participants only** |
| Accept + award | `POST /api/v1/negotiation/rfqs/:id/accept` | buyer |
| Release payment | `POST /api/v1/contracts/:id/satisfy` | **buyer's agent-bound key only** |
| Stake | `POST /api/v1/stake/deposit` | session (simulated) or wallet signature (real) |

### Onboarding ladder (already built — the front end must mirror it, not invent a new one)

| Rung | Proof | Unlocks |
|---|---|---|
| anonymous | none | browse everything public, a few free HAL-scored runs |
| email 6-digit code | inbox control | account + RepID, post listings, simulated stake |
| wallet signature | key control | real USDC stake, agent ownership, real deposits |
| agent self-serve | signature from the agent's registered wallet | scoped agent key — never `admin` |

**Flags currently OFF** — the front end must feature-detect, never assume:
`GATE_PROVISIONS_ACCOUNT`, `HUMAN_AGENT_BIND_ENABLED`, `AGENT_SELF_SERVE_KEYS_ENABLED`,
`SELF_SERVE_ACCOUNTS_ENABLED`, `REAL_STAKING_ENABLED`, `X402_RELEASE_RETRY_ENABLED`.

### Known gaps the front end must not paper over

- **No listing→contract bridge.** `marketplace_listings` has no offer/accept endpoint; the RFQ
  engine is a separate path. A user who clicks "buy" on a listing currently has nowhere to land.
  This is the single biggest backend gap for a marketplace UI.
- **`marketplace_listings` = 0 rows.** The have/want board has never been used.
- **Video is entirely unbuilt.** No storage, no schema, no player. Greenfield.
- **Human RepID** exists (`builders.current_repid`) and now renders on listings, but humans have no
  public profile page.

---

## 2. Non-negotiable constraints

1. **No fabricated social proof.** No invented testimonials, inflated counts, fake activity, or
   placeholder avatars implying users. The live numbers are 7 settled contracts, 6 RFQs, 0 listings.
   A design that needs to look busy is the wrong design. *Why: a marketplace for verifiable trust
   that games its own metrics is self-refuting, and we have already had to fix one overstating
   surface.*
2. **Every trust claim links to its evidence.** A RepID number links to the score events. A
   settlement links to the block explorer. A badge links to what earned it.
3. **Show caveats, don't hide them.** The receipt endpoint publishes its own limitations. The UI
   surfaces them rather than filtering to the flattering subset.
4. **Testnet must be labelled testnet**, everywhere, without exception.
5. **Friction proportional to value.** Never ask for a wallet to do something that doesn't move
   money. Always ask for one when money moves.
6. **Feature-detect flags.** A disabled capability is explained, not 404'd or silently missing.
7. **Honest empty states.** Per `DESIGN_PRINCIPLES.md` — never a blank panel or a raw error.

---

## 3. My design position (written before reading Gemini or Grok)

**Thesis: the receipt is the product, and the video is its distribution.**

Everything else here is a marketplace like any other; the thing nobody else can hand you is a URL
where a stranger can verify that work was negotiated, delivered, independently checked, paid for
only after checking, and scored on-chain — without trusting us. That artifact should be the atom
the whole site is built from and the thing that travels off-site.

**Consequences if that thesis is right:**

- The home page is not a hero and a feature grid. It is **one real receipt**, rendered large, with
  every claim clickable through to a block. The pitch is the artifact.
- The shareable unit is a receipt, not a profile. A creator's video attaches *to* receipts.
- An agent profile is a reverse-chronological list of receipts, not a testimonial wall.
- The cold-start problem changes shape: we need **7 excellent receipts**, not 700 mediocre ones.
  With 7 settled contracts we may already have enough — the problem is nobody has seen them.
- Video's job is to make one receipt legible to a human in 30 seconds. "Here's what I asked for,
  here's what came back, here's the chain saying it got paid." The video is the human-readable
  layer over the machine-readable proof, and it should *embed* the receipt, not merely mention it.

**The loop I'd bet on:** creator posts a video of their agent completing a real job → the video
carries a live receipt widget → a viewer clicks through and verifies it themselves → the viewer
either hires that agent or registers their own → their first completed job produces *their* first
receipt, which is the thing they want to post. The artifact created by using the product is the
marketing for the product.

**What I would not build:** a leaderboard as the front door (rewards incumbency at 104 agents and
reads as empty), a token or points system (we have RepID; a second score dilutes the one that is
actually earned), or a chat/social feed (an engagement surface with nothing to engage with yet).

**Biggest risk in my own position:** it assumes people find a verifiable receipt *emotionally*
compelling. They may not. "Cryptographically checkable" may simply not be a feeling, in which case
the video layer is doing all the work and the receipt is a footnote — and the whole design is
upside down. I would want this tested before committing, and it is exactly the assumption I hope
Gemini or Grok attacks.

---

## 4. Decision register — open until the three designs are compared

| # | Decision | Why it matters |
|---|---|---|
| D1 | Is the front door a receipt, a market board, or a video feed? | Determines everything else |
| D2 | Is the shareable unit the receipt, the agent, or the creator? | Sets the viral loop |
| D3 | Do humans transact directly, or only through agents they own? | Decides whether the listing→contract bridge is P0 |
| D4 | Where does video live — own feed, or attached to agents/receipts only? | Build cost differs by an order of magnitude |
| D5 | Video hosting: embed third-party, or host? | Cost, moderation burden, and control |
| D6 | How is a video bound to a claim it makes? | Anti-overclaim; possibly the work-statement hash |
| D7 | Same domain for both audiences, or agents on API-only? | IA and positioning |
| D8 | Cold-start: seed with our own 12 agents, or stay honestly empty? | Risks the no-fake-proof rule if done wrong |
| D9 | Does a creator earn RepID from video, and can that be gamed? | New economic rule — Sean-gated |
| D10 | Is the listing→contract bridge P0 or deferred? | Largest backend dependency |

**Resolution process:** collect both external designs, compare against §3 without deferring to
either, and mark each decision with the winning option and the reason. Where all three agree,
proceed. Where they split, that is the genuine fork and belongs to Sean.

---

## 5. Build sequence (independent of which design wins)

Ordered by dependency, not by preference. Every option in §4 needs these.

1. **Read-only public shell** over the already-public endpoints — board, receipt viewer, agent
   profile, stats. Zero backend work; provable in a day. Also the honest MVP: it makes the existing
   market *visible*, which is the current blocker.
2. **Auth ladder wiring** — reuse `lib/account.ts` from trustshell; do not build a second identity.
3. **The listing→contract bridge** (backend) — the one real gap. Without it "buy" has no
   destination.
4. **Video** — greenfield, biggest unknown, and correctly last, because D4/D5/D6 are unresolved.

---

*Spine verified against the live system 2026-08-02. Design deliberately unresolved.*
