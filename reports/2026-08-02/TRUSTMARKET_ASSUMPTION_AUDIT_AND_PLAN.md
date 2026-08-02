# TrustMarket — full assumption audit, Sean's reframe, and the dev plan

**Date:** 2026-08-02
**Author:** CC
**Purpose:** surface every assumption in the analysis so far, assess Sean's economic reframe
against them, and produce a buildable sequence.

---

## Part 1 — Every assumption made, by whom

Marked **[V]** verified, **[T]** testable but untested, **[U]** untestable / belief.

### 1.1 Mine (spec v0 §3)

| # | Assumption | Status |
|---|---|---|
| A1 | A verifiable receipt is *emotionally compelling* to a human | **[T] attacked by both, unresolved** |
| A2 | The receipt is the right shareable unit | **[T] attacked by both** |
| A3 | Sharing is the growth mechanism at all | **[U] never examined — see §2.1** |
| A4 | 7 excellent receipts beat 700 mediocre ones | [U] |
| A5 | Video's job is making a receipt legible | [U] — inherited the video premise uncritically |
| A6 | A leaderboard rewards incumbency and should not be the front door | [T] plausible, untested |
| A7 | Creator motivation is *status* | **[U] — Sean says money. I never argued for status, I assumed it** |
| A8 | Showing "one real receipt" on the home page is honest | **[V] FALSE — Gemini caught it. Choosing which is editorial curation** |

### 1.2 Grok's

| # | Assumption | Status |
|---|---|---|
| G1 | Badges/credentials travel and confer status | [T] |
| G2 | Anti-collusion stats are meaningful at low volume | **[V] FALSE by its own red team — baselines unstable at N=7** |
| G3 | "Emptiness is the brand signal" reads as exclusivity | **[T] Gemini called this a cold-start failure rebranded** |
| G4 | Creators will film for an empty market | **[T] its own red team says no** |
| G5 | Buyers will post high-value RFQs into thin supply | [T] doubtful |

### 1.3 Gemini's

| # | Assumption | Status |
|---|---|---|
| E1 | Early-participant badging drives participation | **[T] Grok classified this as manufactured scarcity** |
| E2 | Seeding "Anchor Agents" + bounties bootstraps liquidity | **[V] REJECTED — irreversible on-chain pollution (D8)** |
| E3 | "Genesis" framing confers prestige | [U] and violates the honesty rule |
| E4 | Domain leaderboards will show signal | **[V] FALSE at 104 agents — ranks noise or our own seeds** |
| E5 | A human video layer belongs on a machine protocol now | **[V] FALSE — flagged as a brief problem, accepted** |

### 1.4 Shared, and mostly invisible — the ones in the brief itself

These are the dangerous ones, because all three of us inherited them without argument.

| # | Assumption | Status |
|---|---|---|
| S1 | TrustMarket is primarily a **marketplace** | **[U] never questioned. Sean's reframe says it's a creator-economics platform with a market underneath** |
| S2 | The A2A machine market is the main product, humans the wrapper | **[U] Sean inverts this** |
| S3 | Growth comes from **sharing** | **[U] Sean: growth comes from creators bringing an audience they already have** |
| S4 | The cold-start problem must be solved *on-platform* | **[V] FALSE if cross-posting works — see §2.2** |
| S5 | Video means "make video for TrustMarket" | **[U] Sean: it's content that already exists elsewhere** |
| S6 | Trust is the thing being sold | **[U] Sean: money is sold; trust is how it's defensible** |
| S7 | Participants are motivated by being *believed* | **[U] Sean: they're motivated by *checking others* — see §2.1** |

### 1.5 Sean's new thesis — stated as assumptions so they can be tested too

| # | Assumption | Status |
|---|---|---|
| N1 | People are motivated primarily by money | [T] strongly supported by creator-platform history |
| N2 | People are optimistic about their own ability, pessimistic about others' | **[T] well-established (overconfidence + fundamental attribution). Design implication in §2.1** |
| N3 | Our cost base is low enough to pay a far better share | **[V] TRUE — 164,522 LLM calls / 30d = $2.44 total, 63% free tier, $0.0000149 per call. Real spend is fixed subscriptions, not marginal** |
| N4 | Creators will move for a better revenue share | [T] — history says share alone doesn't move them; *audience portability* does |
| N5 | Creators will bring their existing audience via cross-posting | **[T] THE critical one. If true it dissolves cold start; if false, nothing else works** |
| N6 | "You own your data/users/content" is a differentiator buyers act on | [T] widely claimed, rarely converts on its own |
| N7 | ZKP demographic matching beats incumbent ad targeting on accuracy-per-dollar | **[U] unproven and a large cryptographic build** |
| N8 | Users will build and monetize ecosystem features (V2) | [U] — plugin-marketplace dynamics, needs governance |
| N9 | The IKEA effect makes self-configured monetization stickier | [T] plausible, cheap to test |
| N10 | "The Binance model" applies | **[U] AMBIGUOUS — my reading below; confirm before it's load-bearing** |

**On N10 — I'm assuming you mean:** near-zero take rate to win share, aggressive referral/rebate
tiers that pay users to recruit users, a launchpad that lets the platform host others' launches, and
an ecosystem fund. If you mean the token/BNB mechanic instead, that's a different plan with
securities exposure and I'd want to say so before it's specced. **Flagging rather than guessing.**

---

## Part 2 — What your reframe actually changes

### 2.1 N2 rescues the receipt — by inverting its job

Both red teams killed A1/A2 in the same form: nobody wants to *share* a receipt as a flex.

Neither attacked the other framing, because nobody proposed it. If people are **pessimistic about
others' ability to deliver**, then the receipt's job was never seller-side bragging. It's
**buyer-side due diligence.**

- Nobody shares their own receipt. Everyone checks *someone else's* before hiring them.
- That works at N=7 — you don't need a liquid market to check the one counterparty in front of you.
- It doesn't need the receipt to be emotionally compelling. It needs it to be *available at the
  moment of doubt.*

This resolves D2 without the test I proposed: the shareable unit isn't the receipt. The receipt is
the **verification surface** you reach for when deciding whether to trust a stranger. My A7 (status)
was wrong and I never argued for it.

### 2.2 N5 is the real answer to cold start, and all three of us missed it

Both red teams concluded every loop is inert because the first mover's reward requires participants
who aren't there. **Correct, given S4** — the assumption that liquidity must be created on-platform.

Cross-posting breaks that. A creator who brings 10,000 existing followers isn't waiting for our
audience; they brought one. The first mover's reward doesn't depend on the second mover.

**This is the single most important idea in your message and it is untested.** Everything downstream
depends on it. It also replaces my proposed test — see §3.

### 2.3 What your reframe does *not* fix

- **The honesty constraint still binds.** "Creators make far more" cannot be said publicly until we
  can show the arithmetic with real numbers. Right now we have a cost base [V] and **zero revenue
  data**. A revenue-share claim without a worked example is exactly the overclaim class we've
  already had to fix twice today.
- **D8 still stands: no seeding.** Money-motivation doesn't make polluted genesis data reversible.
- **Cheap fakery is unchanged.** 1,000 fake receipts for <$5. Money motivation makes this *worse* —
  now there's a financial reason to farm.
- **"You own your users" must be architecturally true**, not a slogan: real export, no lock-in, and
  the creator holding the relationship. Easy to claim, and we don't get to claim it cheaply.

---

## Part 3 — The test, revised

My earlier test (do developers click a receipt?) is now the **wrong** test. It measured A1, which
your reframe says was never the point.

**Test the load-bearing claim instead: N5 + N1.**

Take 20–30 creators who already publish elsewhere. Show one page:
- the take-rate comparison with real arithmetic (ours vs YouTube/Substack/Patreon/TikTok),
- "cross-post what you already make; keep your audience; export any time,"
- one live receipt as the *proof mechanism*, not the pitch.

Measure: how many say they'd cross-post; how many actually connect a channel; how many ask about
the revenue math vs the ownership story vs the privacy story. **That ranking tells you what the
product is.**

Kill criterion set in advance: if fewer than ~20% would cross-post, N5 is false and the cold-start
problem is back — in which case build the A2A venue and drop the creator layer.

This test costs days and gates roughly six months of build.

---

## Part 4 — Dev plan

### The scope problem, stated plainly

What you described — creator channels, monetization models, cross-posting, mobile-first, privacy
controls, ZKP demographic matching, and a feature marketplace — **is not an MVP.** ZKP ad targeting
alone is a multi-month cryptographic build. Attempting it all at once means testing none of it.

The sequencing below puts the *untested belief* first and the *expensive certainty* last.

### MVP — "prove a creator earns more here" (target: weeks)

Only what's needed to test N1/N4/N5.

1. **Creator channel** — mobile-first PWA. A creator claims a handle, gets a page.
2. **Cross-post in** — embed content already published elsewhere (YouTube/X/TikTok links first;
   no hosting, no transcoding, no moderation surface).
3. **One monetization model, not five** — pick the simplest that produces a real payout. Given
   x402 is live and proven, direct micropayment/tip is the least new machinery.
4. **The earnings ledger** — the creator sees exactly what came in, what we took, what they keep.
   This *is* the product in MVP. Show the comparison arithmetic against other platforms with real
   numbers.
5. **Receipt as verification surface** — reachable from any creator/agent, not the front door.
6. **Export** — one button, their content and audience list out. Makes "you own it" true on day one,
   cheaply, and it's the claim that's hardest to retrofit.

**Explicitly NOT in MVP:** ZKP targeting, ads, video hosting, freemium gating, feature marketplace,
agent-creator hybrid flows, leaderboards, badges.

### V1 — "the monetization model is theirs" (target: months)

Turn on the rest once MVP proves someone wants it.

1. Full monetization menu — views, ads, freemium, gated — with **easy, legible defaults**. This is
   where the IKEA effect (N9) lives: they configure it, so they own it.
2. Privacy controls with the same default-legible treatment; disclosure copy written to the honesty
   rule.
3. Creator-decides / audience-decides toggle on what viewers see.
4. Cross-post **out** — publish from here to elsewhere. Completes portability.
5. The listing→contract bridge (D10) — needed regardless, unblocks human↔agent trade.
6. Agent creators as first-class: an agent has a channel and earns exactly like a human.

### V2 — the hard, differentiated crypto (target: quarters)

1. **ZKP demographic matching.** Sponsors prove budget and criteria; audiences prove attributes
   without revealing them; matching is verifiable. This is the genuine moat and it must honor
   `ZKP_ARCHITECTURE_INVARIANTS` — one hash/field (Poseidon2), **scoped nullifiers** (scope =
   campaign, not hardcoded), a **domain-parameterized** verifier, one Plonky3 pin. Treat it as a
   third vertical on the shared substrate, not a bespoke build.
   *Prior art to read before designing: Brave's private ad matching and Apple's Private Click
   Measurement. Both shipped; both have known limits worth not rediscovering.*
2. Verifiable audience attestation — the "provably accurate demographic" claim needs a proof, not a
   dashboard.

### V3 — user-built ecosystem features (your V2 idea, moved)

Users developing and monetizing platform capabilities is an app store: sandboxing, review,
revenue-share, and a governance surface. Correct ambition, wrong order — it needs a population
first, and its security surface is larger than everything above it combined.

---

## Part 5 — Getting real signal from Grok and Gemini

The failure mode: hand them this whole vision and ask "is it good." You'll get two enthusiastic
essays and learn nothing. Models are agreeable to a plan presented as a plan.

**What worked today** was blind independence plus adversarial cross-review, and the value came from
*narrow, falsifiable* questions. Repeat that shape.

**Ask each, independently, only this:**

1. **N5 is the whole bet.** "Creators bring their existing audience via cross-posting, which
   dissolves the cold-start problem." Argue the strongest case that this is FALSE. What has to be
   true for a creator to cross-post to a platform with no audience, and where has this failed
   before? *(This is the load-bearing claim; test it hardest.)*
2. **N3→N4.** Our marginal cost is measured: 164,522 LLM calls for $2.44/30d. Does a materially
   better revenue share actually move creators, or is share a stated preference that loses to
   distribution every time? Cite what happened to platforms that competed on share alone.
3. **N2 inversion.** Does "optimistic about self, pessimistic about others" mean the verification
   artifact is a *buyer-side due-diligence tool* rather than a seller-side credential? If so, what
   does that change about where it lives in the product?
4. **N7 reality check.** Price the ZKP demographic-matching build honestly, and say whether the
   accuracy-per-dollar claim survives contact with how ad buying actually works.
5. **Sequencing.** Given the MVP/V1/V2/V3 split above, what's in the wrong phase?

Then **cross-red-team the answers again** — same as today. That's the step that produced everything
useful.

**Do not ask them to validate the vision.** Ask them to kill the one claim everything rests on. If
N5 survives two hostile attempts, build it.

---

## Part 6 — What I'd do Monday

1. Run the §3 creator test. Days, not weeks. It gates everything.
2. In parallel, send the five questions above — blind, then cross-red-team.
3. Build the read-only shell regardless. It's unblocked, it's the verification surface V1 needs, and
   it's the instrument the test points at.
4. Hold the revenue-share claim until we can show the arithmetic. Cost side is [V]; revenue side is
   empty.

---

*Three designs, two red teams, one reframe. The reframe moved the crux from "is a receipt
compelling" to "will a creator bring their own audience" — a better question, and still unanswered.*
