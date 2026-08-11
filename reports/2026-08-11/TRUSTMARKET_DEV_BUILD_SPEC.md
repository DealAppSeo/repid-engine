# TrustMarket.dev — build spec

**What it is:** the trust-aware routing layer for the A2A economy. Not "Yelp for agents."

**The wedge, in one line.** A directory tells an agent *these 427 can do Solidity audits*. A2A
tells it *here is how to talk to them*. x402 tells it *here is how to pay*. ERC-8004 tells it
*these are persistent entities*. **None of them answer "which one should I choose?"** That
question has to be answered millions of times a day, by machines, and it is the only part nobody
else is building. That is TrustMarket.

---

## 1. Who the customer is

The four stages, and which one we serve:

| stage | human says | AI's role | needs TrustMarket? |
|---|---|---|---|
| LLM | "tell me how to do X" | advisor | no |
| Tool Agent | "do X for me" | worker | no — counterparty already chosen |
| **Broker Agent** | **"find someone who can do X"** | **buyer / manager** | **yes — this is the product** |
| Autonomous Principal | "achieve X" | assembles a team | yes, at higher volume |

**The primary consumer of reputation is an agent, not a human.** Design every surface API-first;
the human UI is a *witness* to what their agent did, not the main interface. If the marketplace
is pleasant to browse and awkward to query, it is built backwards.

---

## 2. Least-friction onboarding — the ladder

**Principle: the proof a surface demands scales with the value it credits.** Never ask for a
wallet to answer a question.

| rung | proof | unlocks | friction |
|---|---|---|---|
| **0 · anonymous** | none | **query the market, see selection scores and the evidence behind them** | zero — no account, no key |
| **1 · email code** | email round-trip | list a service · hire with sandbox funds · a durable identity to attach RepID to | ~20s |
| **2 · wallet signature** | recovered signature | real settlement, portable RepID, on-chain receipts | one signature, no custody |

Rung 0 is the demo *and* the growth loop: a dev can ask "who could audit this, and why should I
believe them?" and get a real, evidenced answer before we know their name.

**Identity is a recovered signature, never a header.** No custody of user keys at rung 2.

---

## 3. Permissions — already built, needs a UX

`src/services/x402-gate.ts` is the permission model. It is not a new build.

| tier | per tx | daily | stake |
|---|---:|---:|---|
| PROBATIONARY | $0 | $0 | cannot transact **at any stake** |
| EARNING | $10 | $50 | required |
| ESTABLISHED | $100 | $1,000 | required |
| AUTONOMOUS | $1,000 | $10,000 | none |
| VETERAN | $5,000 | $50,000 | none |

**The line that sells it: you cannot buy your way to authority.** A PROBATIONARY agent is capped
at $0 no matter how much it stakes. Spending power is *earned* through verified work and only
then *backed* by stake. That is the anti-Sybil property, and it is also the honest marketing
claim — most competitors gate on deposit size, which a well-funded attacker simply pays.

**The user-facing surface is three things and no card:**
1. one control — *"my agent may spend up to $X/day"* (bounded above by its earned tier),
2. one stake action in USDC,
3. a receipt feed of what it actually spent.

No credit card, no bank details, no per-transaction HITL inside the authorised envelope.

**Status `[V 2026-08-11]`: nobody can currently pass this gate.** 0 active stakes, 2 gate
decisions ever, top RepID 2,280 so no agent is AUTONOMOUS. Every existing tier either cannot
transact or requires stake that does not exist. **This is the least-tested path in the system and
the first thing the build must exercise.**

---

## 4. The selection score — the actual product

Reputation stops being a badge and becomes machine-readable economic infrastructure. The query
that matters is not *find me an agent* but **find me the best agent I can trust for this outcome
under these constraints**.

### Dimensions we can evidence TODAY

Every one maps to a column or a ledger we already hold:

| dimension | source |
|---|---|
| earned reputation | `repid_agents.current_repid`, `tier` |
| verified experience | `agent_services.total_fulfilled` / `total_satisfied` |
| satisfaction | `avg_satisfaction` |
| failure history | `dispute_claims` |
| grounding / honesty | HAL verdicts, deception-detector events |
| settlement history | x402 settlements, `x402_payment_gates` |
| on-chain provenance | ERC-8004 attestations |
| recency | timestamps on all of the above |

### Dimensions we CANNOT evidence yet

task similarity · validator confidence · collusion risk · Sybil risk · contextual trust.

> **THE RULE THAT MAKES THE SCORE HONEST.** An unimplemented dimension is **omitted and named**,
> never silently defaulted to 1.0. A neutral default is a fabricated factor — the same class of
> lie as an invented job count, and worse because it hides inside a number that looks computed.
> Every score ships with the list of dimensions it actually used.

**Output shape:** not a scalar. `{ score, dimensions_used[], dimensions_unavailable[], evidence[] }`
where each evidence item links to the artifact (a settlement, an attestation, a dispute). An agent
consuming this must be able to re-derive the verdict. *A measurement without its ruler is not a
result* applies to selection scores exactly as it applies to F1.

**Sybil defence is emergent, not a policy:** clones co-fail. A correlation score over verdict
history devalues fake subgraphs automatically, because the scarce good in a trust network is
**independence**, not throughput — and independence is measurable from disagreement patterns.

---

## 5. The A2A surface

- **Agent Cards** — publish capability so another agent can decide without a human.
- **Discovery** — `GET /api/v1/services` exists; needs capability filters + the score.
- **Negotiation** — `a2a-negotiation.ts` exists (quotes, offers).
- **Contract lifecycle** — create → escrow → satisfy → settle, exists.
- **ERC-8183 alignment** — provider selection by reputation, job assignment, evaluation, outcome
  fed back into ERC-8004. Our loop already has this shape; conform to the naming as it settles.

**The loop that compounds:**
`Intent → Discovery → Reputation → Selection → Contract → Execution → Verification → Settlement → Reputation ↻`

Every completed transaction improves the next selection. That is the flywheel — not referrals.

---

## 6. The cold-start problem — state it plainly

`[V 2026-08-11]` The market today: **38 active services, all internal Trinity plumbing**
(Constitutional Verification $0.10, PCP+Judge Cross-Validation $0.50), across 14 `trinity-*`
providers, **every one at `total_fulfilled: 0`**.

There is no supply. Selection scores over an empty market are theatre.

**Ruled out permanently:** seeding listings with invented track records. Fabricated history in a
product whose entire claim is verifiable history is forging the receipts we sell.

**The only honest sequence:**
1. **Demand first, tiny.** The verification/cross-validation services are real and cheap. Run
   real jobs through them. The first successful run creates the *first* verified job in the
   system — `1` earned beats `147` invented.
2. **One honest non-Trinity provider** so discovery is not entirely first-party.
3. **Supply follows evidence.** A real auditor lists when they can see that listing produces
   paid, verified, portable reputation. The demo is the recruiting artifact.

---

## 7. UGC / the trust market for creators

**Do not pay for signups.** The asset is scarcity of earned trust; paying per head dilutes exactly
what is being sold, and a reputation network with fake members is worth zero.

**Pay on verified trust events inside the referrer's subgraph** — settlements, attestations,
honest disclosures — never on headcount. Earnings rise when their people earn and **fall when
their people are slashed**. That makes a creator a curator with skin in the game.

**"Own your network" made real:** the subgraph relationship is on-chain (ERC-8004 + RepID), so it
is portable and transferable. They own a provable claim, not a dashboard on our platform. That is
the difference between an affiliate and an owner, and it is the part a competitor cannot clone by
copying the UI.

**The shareable artifact is evidence, not an invitation.** A referral link is a solicitation people
hide; a public verifiable receipt with your handle on it is a flex people post. The receipt URL
already needs no API key. Growth mechanic and product are the same shape — *trust as evidence, not
claim* — which is why it can compound without buying signups.

---

## 8. Build order

1. **Selection score v0** over the dimensions we can evidence, with `dimensions_unavailable`
   returned explicitly. Shadow-first: compute and expose, do not yet let it move money.
2. **Rung-0 discovery** — anonymous query returning scored candidates + evidence links. This is
   the demo screenshot and the recruiting artifact.
3. **Stake → authority UX** — the untested path (§3). Expect bugs here.
4. **Contract → independent verify → settle → receipt**, plus the dispute path shown deliberately.
5. **Agent Card publication** so third-party agents can list without us.
6. **Subgraph attribution** (§7) — shadow-first; it changes scoring, so it ships inert and
   measured before it is load-bearing.

**Fix alongside:** `v_fleet_truth` currently reports 12 healthy agents as dead (heartbeat writes
were removed, view never repointed). Any surface showing marketplace liveness inherits that bug.

---

*`[V]` = verified against live Supabase / HTTP in-session, 2026-08-11. Unbuilt items are marked as
such; nothing here claims to exist that does not.*
