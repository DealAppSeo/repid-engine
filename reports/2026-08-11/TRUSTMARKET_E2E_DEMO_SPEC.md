# TrustMarket E2E demo — spec

**Goal:** an outside dev (Marco) runs one command and watches an agent discover a service,
evaluate whether to trust it, get authority to spend, engage it, have the work independently
verified, settle in USDC, and land an on-chain receipt. Nothing staged.

**Positioning:** the user is the CEO; their agent is the chief of staff. TrustMarket.dev is where
agents list and find each other. The demo is the proof that an agent can be *trusted to act*.

Everything below marked `[V]` was verified against live Supabase / HTTP on 2026-08-10/11.

---

## 1. Decisions taken

| question | decision |
|---|---|
| Who funds Marco's run? | **Pre-funded sandbox agent.** He never touches a token. |
| Whose LLM? | **Free OpenRouter model by default**, BYOK override. |
| Dispute path? | **Shown deliberately**, not hidden. |
| Counterparty? | **The T-12 Trinity agents** — ours, and verified responsive. |
| Faucet? | **Build neither.** See §5. |

## 2. What already exists — do NOT rebuild `[V]`

- **Discovery API** — `GET /api/v1/services` over `agent_services`, with filters.
- **Contract lifecycle** — create → escrow → satisfy → settle (`src/routes/v1/contracts.ts`).
- **x402 spending authority** — `src/services/x402-gate.ts`. Sean's "stake an amount and the agent
  transacts without HITL or card details" is *already the implemented policy*:

  | tier | per tx | daily | stake required |
  |---|---:|---:|---|
  | PROBATIONARY | $0 | $0 | — cannot transact at all |
  | EARNING | $10 | $50 | yes |
  | ESTABLISHED | $100 | $1,000 | yes |
  | AUTONOMOUS | $1,000 | $10,000 | no |
  | VETERAN | $5,000 | $50,000 | no |

- **On-chain receipt** — ERC-8004 writes, verified on Base Sepolia.
- **`npx @hyperdag/trust-demo`** — published, but demos *proof verification*, not the economic loop.
- **X402_ENFORCEMENT_ENABLED = ON** `[V behavioral]`: two eligible-but-unpaid contracts sat
  `pending` for 150 and 835 minutes while `processCascadeQueue` runs every 60s. It only escrows
  rows with `x402_payment_id IS NOT NULL`. 835 survived cycles = enforcement on.

## 3. THE CONSTRAINT THAT DEFINES THE DEMO `[V]`

The 38 "active services" are **all internal Trinity plumbing**:

| service | price | total_fulfilled | providers |
|---|---:|---:|---|
| Constitutional Verification | $0.10 | **0** | 14 trinity-* agents |
| PCP+Judge Cross-Validation | $0.50 | **0** | 14 trinity-* agents |

**There are no Solidity-audit or web-design services, and every listing has zero completed jobs.**

So the flagship prompt — *"audit my Solidity contract, under $50, 100+ verified jobs, no serious
failures, ERC-8004 experience"* — returns **zero matches**. Two independent filters kill it: the
domain does not exist, and `total_fulfilled: 0` fails "100 verified jobs" everywhere.

> **THE TEMPTING WRONG FIX — do not take it.** Seeding the market with listings showing
> `total_fulfilled: 147` would be fabricated history in a product whose entire claim is that
> history is verifiable. We would be forging the receipts we sell. Any "demo data" that invents
> a track record is out of bounds, permanently.

**The honest prompt, which runs today, unstaged:**

> *"Find an agent that can independently verify this claim for under $1. It must be ESTABLISHED
> tier or better. Get quotes from the top three, pick the best value, authorize the work, have a
> second independent agent check the result, and pay only after it passes."*

Real agents (RepID 1000–2280), real prices, real escrow, real settlement, real receipt. Same
mechanism as the Solidity version; smaller dollar amount. **Sean's version becomes true the moment
one real auditor lists a service — and this demo is what makes an auditor want to.**

**Bonus, and it is the actual flywheel's first turn:** every service sits at `total_fulfilled: 0`,
so the demo's first successful run *creates the first verified job in the system*. `1` earned
honestly outranks `147` invented.

## 4. Fleet liveness — a live trap `[V]`

`v_fleet_truth` reports **`is_live: false` for all 12 Trinity agents**, last ping 35,098 minutes
(24.4 days) ago. **They are not dead.** Direct probes: `trinity-orch`, `trinity-veritas`,
`trinity-sophia` → **HTTP 200** on `/health`.

Agent-side heartbeat writes were deliberately removed in favour of UptimeRobot + `/health`; the
view was never repointed. **Absence of a signal you turned off is not evidence of absence.**
Trusting the view would have killed the T-12-as-counterparty plan on false evidence.

**Fix before the demo ships:** repoint `v_fleet_truth` at a real probe, or restore the writes.
A monitoring surface that reports 12 healthy services as dead will mislead every future session.

## 5. Faucet — build neither

- **Sandbox:** no faucet. A pre-funded sandbox agent deletes the problem.
- **Conversion (own agent):** link the public Base Sepolia faucets. Running our own means funding
  every bot that finds it — drained in hours, and it is ops burden unrelated to trust.
- **The better answer:** the first rung should not need tokens at all. `PROBATIONARY` is $0 *by
  policy*; the way up is earned, not funded. A new user's opening loop is non-payment trust events
  (verification, attestation, honest disclosure) that build RepID for free. Tokens matter only
  once they want to *spend*. That is "earn autonomous abilities with provenance" made literal, and
  it moves the faucet from onboarding blocker to late-stage detail.

## 6. Build order

1. **Discovery + trust evaluation.** Real query; shows *why* each candidate passed or failed each
   filter. Domain-agnostic, so it survives whatever fills the market later. This is the screenshot
   that sells the product.
2. **Stake → authority.** `[V]` **0 active stakes, 2 gate decisions ever, and nobody is AUTONOMOUS
   (top RepID 2,280).** Every present tier either cannot transact or requires stake that does not
   exist — so **no agent can currently pass the gate.** That is not a blocker, it is Act One, and
   it is the least-tested path in the system. Expect the bugs here.
3. **Engage → independent verify → settle → receipt.** The proven part.
4. **Dispute path**, triggered deliberately.

**Alongside, both cheap:** fix `v_fleet_truth` (§4), and seed **one honest non-Trinity provider** —
a real service we would stand behind — so discovery is not entirely first-party.

## 7. Conversion surface

Two doors from the demo, both earned rather than sold:

- **"Use an agent"** — pick a T-12 agent from a list, give it a job. Zero setup.
- **"Bring your own agent"** — wrap it in TrustShell and get HAL, zk RepID, x402 authority and
  ERC-8004 provenance. The pitch is not "list on our marketplace"; it is **your agent earns the
  right to act, and that record is portable and yours.**

## 8. Growth mechanic

**The shareable artifact is evidence, not an invitation.** A referral link is a solicitation people
hide; a public verifiable receipt with your handle on it is a flex people post. The receipt URL
already needs no API key. The growth loop and the product are the same shape — *trust as evidence,
not claim* — which is why it can compound without paying for signups.

Referral commissions, if added later, must pay on **verified trust events in the referrer's
subgraph**, never on headcount. Paying per signup dilutes the scarce asset, and a reputation
network with fake members is worth zero. Sybils co-fail, so a correlation score devalues fake
subgraphs automatically — the incentive is enforced by the harness, not by policy.

---

## Session state at handoff

- repid-engine `#400`–`#408` merged; **HyperDAG-core #8 open** (1,228 lines, no CI configured).
- `agent_node_registry` + `v_node_truth` live in prod (RLS on, `security_invoker = true`).
- **First real lane lease taken:** `demo` holds `packages/trust-demo/**` + `scripts/demo/**`.
  Caveat: `HYPERDAG_LANE` cannot be set in the harness env from a shell export, so the fence
  *advises* on our own writes while still *denying* another lane that tries these paths.
- Another Claude session is active in this repo — coordinate through the lease, not assumption.
- OpenRouter funded. **Hetzner deferred** — Railway already suffices and #408's cron targets it.

*`[V]` = verified by a tool result in-session. Vendor and third-party claims are `[R]`.*
