# Progressive-trust signup — the decided ladder

**Status:** DECIDED (2026-08-29). Rung 0 partially built; **preview RepID BUILT** — see below.
**Inputs:** XC red-team dispatch (PR #517), GA data contracts (PR #518), operator direction.

---

## The decision: preview-only, not provisional-and-vesting

An anonymous visitor's RepID is **displayed and never persisted**. Binding an identity
starts from baseline. The alternative — accruing a provisional score that *vests* on
binding — was rejected.

**The argument that settled it, and it reverses this session's earlier recommendation.**
The counterparty gate demotes `VETERAN` and `AUTONOMOUS` without >= 2 unique
counterparties, but **`ESTABLISHED` and `EARNING` have no gate at all**. A farm of
zero-counterparty token-only accounts therefore operates entirely inside the unprotected
band: accrue provisional score, bind a few accounts, and the value vests as earned.

So the two options fail in opposite directions:

| | fails | why |
|---|---|---|
| provisional-and-vesting | **OPEN** | a subtle bug in binding — copying `current_repid` without clearing provisional state — turns the signup into a reputation mint |
| **preview-only** | **CLOSED** | a leaked write is visible in `repid_score_events`, which is append-only |

The cost is real and should not be glossed: the operator's intent was *"their RepID goes
up slightly because they are learning."* Preview-only satisfies the visible half and not
the durable half. **A preview must therefore be labelled as a preview** — showing a number
that looks earned and is not would be the same dishonesty the score exists to prevent.

## The ladder

Each rung states what is **proven**, what it **unlocks**, and what it must **refuse**.
Escalation is keyed to the **risk of the action**, never to the identity of the user.

### Rung 0 — token-only
`builders.session_token` match · `auth_method='token_only'` · `earns_repid_rewards=false`

- **Proven:** possession of a 32-byte token. NOT_CHECKED: email, key, human-vs-Sybil.
- **Unlocks:** preview RepID display · demo rounds · builder profile.
- **Refuses:** any persisted RepID accrual · real stake deposit · bounties, challenges,
  agent operation · binding without further proof.

### Rung 1 — full account
`verifyFullAccountToken()` — a JWT carrying `builder_id` **and** `email`

- **Proven:** control of an email-linked identity (MEASURED by signature + expiry).
- **Unlocks:** simulated stake on its own row · marketplace posts · full dashboard.
- **Refuses:** real on-chain deposits · authority beyond the simulated path.
- 2FA belongs here as a **threshold on action risk**, not a property of the account.

### Rung 2 — wallet signature
EIP-191 recovery over the exact `stakeDepositMessage`, including `tx_hash`

- **Proven:** control of the wallet (MEASURED).
- **Unlocks:** real deposits · full authority · higher-risk exchange.

### Rung 3 — operator / scoped key
`REPID_API_KEYS` or `validateAgentApiKey` — service callers, named accounts.

**Consequence worth stating plainly:** `POST /api/v1/stake/deposit` returning **401** to a
token-only credential is **correct**, not a defect. Simulated stake is Rung 1. An earlier
pass in this session read that 401 as a gap and drafted a bottom rung to close it; under
the decided model that would have opened exactly the path the red team warned about.

## Custody

Anonymous signup derives its address as `'0xT0KEN' + sha256(token)` and holds no key —
the comment in `anonymous-signup.ts` notes the checksum can never validate, deliberately.
**No user wallet is ever custodied.** (`AGENT_KEY_MASTER` custodies *agent* wallets and is
unrelated.) Any future field that would record a proven attribute rather than the *fact of
the proof* is a violation of this and should be rejected in review.

## A correction to the red-team finding, recorded because acting on it as written would have been wrong

XC reported *"no rate limit visible in the router or middleware for this path"* on
`token-signup`. **That is false.** `rateLimitMiddleware` from `src/middleware/rate-limit.ts`
is mounted globally on `/api/v1` (`src/index.ts`), so the route always carried
`IP_DEFAULT`. Building a second limiter beside a working one is the mistake that finding
invites.

The real problem survives the correction: account creation carried the **same allowance as
a cache-friendly GET** — 60/min/IP, roughly 86,000 durable rows per day from one address.
Fixed by a `ROUTE_OVERRIDES` entry at `0.1` → 6/min, chosen so a shared NAT still works.

**It does not stop a Sybil farm.** Rotating IPs defeats per-IP limiting. It raises the cost
of bulk minting from one address; the actual protection is that a Rung 0 account accrues
nothing persistent.

Red-team output is grade `[R]` — reasoning, no execution. Verify before building.

## Preview RepID — built, and the shape of the guarantee

`GET /api/v1/repid/preview/actions` (the full menu) and
`GET /api/v1/repid/preview/project?events=A,B&base=200` (a projection). Both keyless, both
mounted on the pre-auth public router, both covered by the global per-IP limiter.

**The no-write guarantee is structural, not a promise.** The obvious implementation — a
`dryRun` flag threaded through `updateRepId` — was rejected: that function interleaves the
delta computation with a fetch, a decay write, an agent update, an audit insert, a
supply-rate bump and a badge sweep, and one missed write site turns a preview into a
mutation. Instead `FIXED_DELTAS` and the event vocabulary moved to
`src/scoring/repid-deltas.ts`, a file with **no imports at all**, and
`src/engine/repid-preview.ts` imports that and nothing else. It cannot write because there
is nothing there to write with. `tests/repid-preview.test.ts` walks the import graph and
fails if `src/db.ts` becomes reachable — with an **anchor case** that runs the same walker
against `repid-update.ts` and requires it to find the database client, so a broken walker
cannot report a clean graph and read as a pass.

**A preview is never MEASURED.** Every delta is `APPROXIMATE`, and the payload carries what
it omits — decay, the ecosystem-need weight, the redemption modifier (so previewed penalties
are the undampened worst case), and the self-report evidence gate. The projected tier is
stamped `tierIsCounterpartyGateApproximation: true` and says in the response that the
database derives the real tier from a trigger that demotes `AUTONOMOUS` and `VETERAN` below
2 unique counterparties — exactly the position a new visitor is in.

**What it refuses to state matters more than what it states.** An action whose live value
depends on data no pure function has returns `NOT_CHECKED` with `delta: null` — never a
plausible zero. That covers challenge outcomes, predictions, and the eight
defended-deception classes. **STAKE is the case worth naming:** the tariff says +5 and the
live path hard-codes 0 pending a server-side on-chain verifier, so a preview that read the
table would advertise +5 for an action that earns nothing. It is `NOT_CHECKED`, a test pins
that it does not return 5, and a second test pins the engine's override so the two are
revisited together when a real verifier lands.

**Still preview-only.** Nothing on this path is persisted, and the response says
`persisted: false` in the shape. Rung 0 accrues nothing.

## Not built

- **Demo agents (APM / VERITAS) are unseeded**, so `/demo/run-round-anonymous` returns 400
  and Rung 0's demo-round unlock cannot be exercised. The migration exists and is not
  applied; applying it writes agents into production and is the operator's call.
- **Binding / upgrade flow** — the transition out of Rung 0.
- **A consumer surface for the preview.** The endpoints exist and are exercised by tests;
  no page on `trustshell.dev` renders them yet.
