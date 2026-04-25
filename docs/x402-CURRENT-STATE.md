# x402 — Current State

**Date:** 2026-04-24
**Scope:** repid-engine + ecosystem read-only audit. No code changed by this doc.
**Reader:** Sean and contributors deciding what to build for protocol-level x402.

---

## TL;DR

The repo currently exposes one endpoint named `/x402-gate` and threads a typed
`x402Context` through reputation events. Both are **policy / audit primitives**, not
implementations of the x402 wire protocol. There is **no facilitator wired**, **no
`PAYMENT-SIGNATURE` / `PAYMENT-REQUIRED` / `PAYMENT-RESPONSE` header handling**, and **no
`@coinbase/x402` or `x402-express` npm dependency**. A future protocol-level paywall
middleware would be additive on top of what's here, not a rewrite of it.

---

## Section A — Active Implementation

### A.1 `POST /agents/:id/x402-gate`

**File:** `src/routes/agents.ts:283-314`. Mounted under `agentsRouter` in `src/index.ts`,
behind `authMiddleware` (bearer or `x-api-key`).

**Verbatim handler:**

```ts
// x402 payment gate — RepID tier + EAS attestation check
// This is trustshell.gate() under the hood
router.post('/agents/:id/x402-gate', async (req: Request, res: Response) => {
  const { amount, currency = 'USDC', x402RequestId } = req.body;
  if (!amount) return res.status(400).json({ error: 'amount is required' });

  const { data: agent } = await db.from('repid_agents').select('*')
    .eq('id', req.params.id).single();
  if (!agent) return res.status(404).json({ error: 'Agent not found' });

  const tierLimits: Record<string, number> = {
    CUSTODIED_DBT: 0, EARNING_AUTONOMY: 1000, AUTONOMOUS: Infinity,
  };
  const limit = tierLimits[agent.tier] ?? 0;
  const tierAllowed = amount <= limit;
  // Sprint 3: also check latest EAS attestation from ValidationRegistry
  const easCheck = { passed: true, stub: true,
    schema: 'constitutional-compliance-v1' };
  const allowed = tierAllowed && easCheck.passed;

  return res.json({
    allowed, agentId: req.params.id, agentName: agent.agent_name,
    repId: agent.current_repid, tier: agent.tier,
    requestedAmount: amount, currency,
    tierLimit: limit === Infinity ? 'unlimited' : limit,
    reason: !allowed
      ? `tier_limit_${limit === 0 ? 'zero_CUSTODIED_DBT' : limit}`
      : undefined,
    x402RequestId: x402RequestId ?? null,
    easAttestation: easCheck,
  });
});
```

**Accepts:** `{ amount: number, currency?: string = 'USDC', x402RequestId?: string }`.

**Returns:**

```json
{
  "allowed": boolean,
  "agentId": string,
  "agentName": string,
  "repId": number,
  "tier": "CUSTODIED_DBT" | "EARNING_AUTONOMY" | "AUTONOMOUS",
  "requestedAmount": number,
  "currency": "USDC",
  "tierLimit": number | "unlimited",
  "reason": string | undefined,
  "x402RequestId": string | null,
  "easAttestation": { "passed": true, "stub": true, "schema": "constitutional-compliance-v1" }
}
```

**Auth:** bearer token / `x-api-key` per the global `authMiddleware` (CLAUDE.md, "Request
pipeline"). The endpoint is **not** in the bypass list.

**Tier ceilings (hardcoded inline):**

| Tier | Authoritative limit |
|---|---|
| `CUSTODIED_DBT` (RepID 10–999) | $0 — agent cannot self-authorize |
| `EARNING_AUTONOMY` (1000–4999) | $1,000 |
| `AUTONOMOUS` (5000–10000) | unlimited (within constitution) |

These thresholds match `computeTier()` in `src/engine/repid-update.ts:59-63` and the
canonical tier names in CLAUDE.md.

**EAS attestation check is a Sprint-3 stub** (`{passed: true, stub: true}`). Per
CLAUDE.md: "Sprint-3 stubs (EAS, ZKP) — do not remove or 'fix' passing stubs."

### A.2 `x402Context` flow through `repid-update.ts`

**File:** `src/engine/repid-update.ts`.

**Type definition (lines 32-36):**

```ts
x402Context?: {
  paymentAmount: number;
  paymentCurrency: string;
  x402RequestId: string;
};
```

**Used in two places:**

1. **Line 87** — passed into `auditConstitutionalCompliance` as part of `actionMetadata`,
   so the (currently stubbed) constitutional audit layer can in principle gate on
   payment context.
2. **Line 171** — written to `repid_score_events.metadata.x402Context` (JSONB) on every
   score-changing event, providing an audit trail linking RepID deltas to the payment
   that triggered them.

`x402Context` is **never read** anywhere outside this file. There is no flow that
populates it from an HTTP request — it's a contract surface awaiting a caller.

**Schema confirmation (`information_schema.columns` for `repid_score_events`):**
no top-level column for `x402_request_id`, `payment_amount`, or `payment_currency`. The
context lives only inside the `metadata` JSONB. Top-level economic columns that DO
exist: `economic_impact_usdc numeric default 0`, `decision_outcome text`,
`hallucination_caught boolean default false`. None are populated by `/x402-gate`.

### A.3 HashKey Horizon hackathon submission

**File:** `SUBMISSIONS/PAYFI_TRACK.md` (do not modify per Sean's instruction).

Relevant excerpts:

> **Demo:** https://repid-engine-production.up.railway.app/agents/d08a6049-6e33-48ef-8d6c-006ebe9ef48a/x402-gate
> **GitHub:** https://github.com/DealAppSeo/repid

> ## One Line
> x402 payment authorization gated by behavioral reputation —
> only agents that have earned constitutional trust can
> authorize payments above their RepID tier threshold.

> ## The Solution
> RepID x402 payment gating:
> - DBT tier (0-999 RepID): $0 autonomous limit
> - ABT tier (1000-4999 RepID): $1,000 autonomous limit
> - AUTONOMOUS (5000+ RepID): unlimited within constitution
>
> Every payment attempt calls:
> POST /agents/:id/x402-gate { amount: X }

**Note (do not fix here):** the demo URL points at the POST endpoint without a method;
hitting it in a browser will 405. Also the integration snippet uses
`gate(agentId, amount)` — but the published `@hyperdag/trustshell@0.1.0` exports a
`TrustShell` class with `evaluate/report/getRepID/getLLMTrustScore`, not a `gate`
function. Same doc/code drift documented in the prior ecosystem audit
(`docs/x402-INTEGRATION-MAP.md` § C.1 below).

### A.4 Facilitator details

**Result of inspecting the codebase: no x402 facilitator is configured anywhere.**

Searches performed (excluding `node_modules`):

- `Grep "facilitator|x402|FACILITATOR"` → 16 hits, all in `src/routes/agents.ts`,
  `src/engine/repid-update.ts`, and `SUBMISSIONS/PAYFI_TRACK.md`. **Zero hits** for
  the literal string `facilitator` (case-insensitive).
- No `process.env.X402_FACILITATOR_URL`, `FACILITATOR_URL`, `X402_VERIFY_URL`, etc.
- No `x402-express`, `@coinbase/x402`, `@x402/*`, or any related package in
  `package.json`.
- No `/verify` or `/settle` endpoint client code anywhere.

**The existing `/x402-gate` does not call any facilitator.** It is a synchronous,
in-process tier-limit decision over local DB state, returned to whatever caller
(presumably a future paywall middleware or a trustshell client SDK) needs to decide
whether to admit a payment flow.

---

## Section B — What's Wired vs. What's Not

| Surface | x402 protocol level | Today | Should it? |
|---|---|---|---|
| `POST /agents/:id/x402-gate` | Off-protocol policy oracle | **Live** | Keep as-is. It's a pre-authorization hint, not a protocol endpoint. |
| `POST /api/v1/hal/signals` | None | Free, public, no auth | **Yes** — sprint Phase 3 target. |
| `POST /api/v1/agents/:id/score-event` | None | Bearer-protected | Maybe — if 3rd-party scorers ever pay-per-write. Not now. |
| `POST /api/v1/prove-repid` | None | Public, no auth | **Probably** — ZKP generation is real CPU. Phase 4+. |
| `POST /api/v1/batch/prove` | None | Public, no auth | **Probably** — same as above, batched. |
| `POST /api/v1/dag/verify-node` | None | Public, no auth | Depends on whether DAG writes become metered. Not now. |
| `POST /mcp-call` | None | Bearer-protected | **Eventually** — every MCP tool call is the natural x402 unit. |
| `POST /challenge` | None | Bearer + per-agent rate-limited | Maybe — challenges are already self-limiting. |
| `POST /bounties/*` | None | Bearer | **No.** Bounties already have their own value/payout primitives. |

**Client-side SDK consumers of `/x402-gate`:** none found.

- `Grep "x402|gate("` in `C:/Users/Cash4/repos/trustshell` → one hit:
  `README.md:148` — appears in an architecture-diagram comment, not in code.
- `Grep "x402-gate|x402Gate|x402_gate"` in `C:/Users/Cash4/repos/trustrepid` → one hit:
  `app/install/page.tsx:63` — the documentation page lists it as a known endpoint, but
  no actual fetch call to it exists in the dashboard code.

**So the gate is implemented but not yet consumed by any first-party client.** Whatever
Sean demo'd at the hackathon was either curl/Postman against the live endpoint, or a
client that lives outside these two repos.

---

## Section C — Header Compliance Audit

**Spec (canonical, current per `coinbase/x402` README, fetched 2026-04-24):**

| Direction | Header | Carries |
|---|---|---|
| Server → Client (402 response) | `PAYMENT-REQUIRED` | base64-encoded `PaymentRequired` object with `accepts: [...]` |
| Client → Server (request) | `PAYMENT-SIGNATURE` | base64-encoded `PaymentPayload` |
| Server → Client (200 response) | `PAYMENT-RESPONSE` | base64-encoded settlement response |

**Observed in repid-engine:**

- `PAYMENT-SIGNATURE` — **0 references**.
- `PAYMENT-REQUIRED` — **0 references**.
- `PAYMENT-RESPONSE` — **0 references**.
- `X-PAYMENT*` — **0 references**.

**Conclusion:** there is no header compliance to audit. The repo does not implement the
wire protocol. The naming `/x402-gate` is *aspirational* — it's a policy primitive
intended to slot into a future protocol implementation. No tech debt to flag against
the existing surface; the work is greenfield additive.

**Spec drift to flag for the future Phase 3 implementation:** the sprint-task brief
described headers as `X-PAYMENT` and `X-PAYMENT-RESPONSE`. The current Coinbase spec
uses unprefixed `PAYMENT-SIGNATURE` / `PAYMENT-REQUIRED` / `PAYMENT-RESPONSE`. Phase 3
must follow the current spec, not the brief's older names.

---

## Section D — PATENT-RELEVANT NOVELTY OBSERVED

**Not legal advice; flag-and-document only.** These are patterns Sean may want to run
through a Grok prior-art pass before any public disclosure beyond the existing
hackathon submission. Observations are factual descriptions of what the code does.

1. **Reputation-tiered payment-authorization ceilings.** Per-tier USD ceilings
   (CUSTODIED_DBT $0, EARNING_AUTONOMY $1000, AUTONOMOUS unlimited) returned from a
   single oracle endpoint. The novelty isn't the ceiling — it's pinning the ceiling to
   a *behavioral* score that decays with inactivity and applies a *redemption modifier*
   when the score is recovering from a punishment (`src/layers/decay.ts`,
   `src/engine/repid-update.ts:128-131`). Result: payment authority is a function of
   recent demonstrated trustworthiness, not a one-time KYC outcome.

2. **Constitutional audit + EAS attestation in the payment-authorization path.**
   `/x402-gate`'s `easCheck` is a stub today, but the contract is: every authorization
   asks "does this agent currently pass the constitutional audit attached to its EAS
   attestation?" That's a non-binary, signed, on-chain-anchored authorization decision
   feeding into an off-chain payment.

3. **Payment context as a reputation input.** `x402Context` (`paymentAmount`,
   `paymentCurrency`, `x402RequestId`) is captured on every score-changing event and
   stored in `repid_score_events.metadata`. The constitutional-audit layer
   (`src/engine/repid-update.ts:82-89`) receives it as `actionMetadata`. The shape lets
   future audit logic compute reputation deltas conditional on payment context — e.g.
   a constitutional violation that occurred in the context of a $10,000 payment is
   weighted differently from one in the context of a $1 payment. This is the inverse
   of the usual direction (reputation → payment); here payment also feeds back into
   reputation.

4. **Tier-aware `x402Context` round-trip.** `/x402-gate` accepts an `x402RequestId`
   passed back to it, and `x402Context.x402RequestId` is then stored on the score
   event. This creates a reversible link from a settled payment ID to the specific
   reputation event it influenced — useful for downstream insurance/escrow logic.

5. **Pythagorean Comma multiplier in HAL dissonance, applied as a payment veto.** The
   PayFi submission claims "high-dissonance periods trigger CAPITAL PROTECTED
   regardless of tier" — the existing `/x402-gate` does **not** currently implement
   this (no HAL check in the handler), so this is *aspirational* in the submission
   text, not yet code. If implemented in Phase 3, the use of `531441/524288` from
   classical music theory as a veto multiplier in payment authorization is unusual.

**What I am NOT claiming is novel:** the bare idea of an HTTP 402 paywall, USDC
micropayments, or behavioral reputation in general — all prior art.

---

## Open questions for Sean (do not block Phase 2)

1. The hackathon demo URL `…/agents/<id>/x402-gate` is POST-only — was the demo run
   against curl/Postman, or is there a first-party client that should be tracked
   here? (No first-party client found in trustshell / trustrepid.)
2. The `easCheck` is a Sprint-3 stub. Phase 3 implementation may need it to be
   non-stub if HAL dissonance is supposed to be part of the gate (per submission text).
   Confirm whether Phase 3 should remain off the gate's Sprint-3 stub or wire to it.
3. `repid_score_events` has top-level `economic_impact_usdc` already. Worth a future
   migration to lift `x402_request_id`, `payment_amount`, `payment_currency` out of
   JSONB into top-level columns for query efficiency. Out of scope for this sprint.
