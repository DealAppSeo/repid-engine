# MVP Trust Kernel — the four consumer endpoints

One backend (`repid-engine`, `repid-engine-production.up.railway.app`), one consumer SDK/UI
(`@hyperdag/trustshell`, trustshell.dev) — not a second product. This is the reference for the
four endpoints that make up the MVP: what each returns, what it needs, and what's still
`NOT_CHECKED` rather than silently assumed.

## 1. Passport — `GET /api/v1/passport/:agentId`

**Status: live**, consumed today by `trustshell.dev/passport/[agentId]`. Public, no key,
`Cache-Control: public, max-age=30`. The one-call composite: `reputation{repid_score,tier,
activity_30d}`, `identity_erc8004{}`, `payments_x402{}`, `reputation_onchain{}`, `zkp{}`. Source:
`src/routes/v1/agent-passport.ts` / `src/services/agent-passport.ts`.

## 2. Authority — `GET /api/v1/authority/:agentId` (existing) + real collateral

**Status: live**, consumed by `trustshell.dev/stake` (`fetchAuthority`, `fetchStakePositions`).
Reports A_eff and stake posture from `stake_deposits` (real vs. simulated split — see
`x402-gate` / `owner-ceiling-shadow.ts`).

## 3. Grants — `POST /api/v1/grants`, `GET /api/v1/grants`, `POST /api/v1/grants/:id/revoke`, `POST /api/v1/grants/:id/authorize`

**Status: new tonight.** Principal-to-principal authority: one agent (a PAI) granting scoped,
budgeted, time-limited authority to another (a CTO/CFO/CMO worker it spawns), with real
revocation. The gap neither existing delegation primitive covered — see
`src/services/principal-grants.ts`'s header and trinity-ecosystem's
`docs/policy/grants-authority.v0.md` (G1-G8) for the full spec.

### `POST /api/v1/grants` — mint

```json
{
  "grantor_agent_id": "pai-ceo",
  "grantee_agent_id": "agent-cfo",
  "grant_class": "spend",
  "capabilities": ["pay:usdc"],
  "caveats": [{ "type": "maxValue", "asset": "USDC", "amount": 100 }],
  "ttl_seconds": 3600,
  "role": "CFO",
  "parent_grant_id": null
}
```

`grant_class` is one of `spend | hot | warm | cold`, and sets the mint floor (G1):

| class | requires of the grantor | numeric floor |
|---|---|---|
| `spend` | A_eff >= the `maxValue` caveat's amount | none flat — budget-relative |
| `hot` | A_eff >= 2000 | theta_hot |
| `warm` | A_eff >= 500 | theta_warm |
| `cold` | none (auditor use) — but `audit_for` must differ from `grantee_agent_id` | theta_cold = 0 |

A_eff here is computed by `src/services/effective-authority.ts` — the same locked formula
(`min(R_route, 100*sqrt(S_real)) * 1[builder >= 500]`), with one **named, load-bearing
approximation**: `R_route` is `repid_agents.current_repid` (the ledger value), because the true
sigma-adjusted routing value is computed by trinity-ecosystem's decay engine, which repid-engine
has no access to. Every response is stamped `rRouteIsLedgerApproximation: true` so this is never
mistaken for the real figure. `stake_deposits` collateral IS real (non-simulated rows only,
summed by resolved `builder_id`).

Minting a `spend` or routing (`hot`/`warm`) grant when the grantor's A_eff is `NOT_CHECKED`
(no resolvable builder, or collateral unmeasured) is **refused**, not silently approved at 0.

Child grants (`parent_grant_id` set) must attenuate: capabilities ⊆ parent's, caveats only
tighten (dropping one counts as loosening), spend cap ≤ parent's stated cap, `expires_at` ≤
parent's, chain depth ≤ 4.

### `GET /api/v1/grants?principal=<agent_id>`

Every grant where `principal` is grantor or grantee, with `live`/`liveReason` computed against
the FULL ancestor chain on every read — a revoked or expired ancestor denies every descendant
even though the descendant's own row is untouched. (Verified directly against the live table:
revoking a root grant leaves its child's row unchanged but the child is no longer live.)

### `POST /api/v1/grants/:id/revoke`

```json
{ "requested_by": "pai-ceo" }
```

**G6: only the direct grantor of that specific link may revoke it — always, and the grantee
cannot block it.** Idempotent: revoking an already-revoked grant is refused, not a silent no-op.

### `POST /api/v1/grants/:id/authorize` (read-only)

```json
{ "capability": "pay:usdc", "context": { "value": { "asset": "USDC", "amount": 10 } } }
```

**G5: an expired or revoked grant anywhere in the chain returns `FAILED`, never a soft-allow
with a warning.** Response is `MEASURED` (authorized, every caveat verified), `NOT_CHECKED`
(authorized, but a caveat like `maxCalls` couldn't be evaluated from this context), or `FAILED`.

**G8, by omission, not by code:** nothing in this module is wired into `PAY_AUTH_MODE` or the
pay route. A grant existing does not gate a payment today — that stays a separate, explicit,
observe-mode decision for whoever owns the pay path.

## 4. Activity — device-local today, global feed is V1

`trustshell.dev/history` reads a local IndexedDB (`lib/db`) — this device's own interaction
history, not a cross-agent chronological feed of GateRuns/score-events/pay-decisions. Every
grant mutation IS logged server-side tonight (`trinity_agent_logs`, `action` in
`principal_grant_minted | principal_grant_mint_denied | principal_grant_revoked |
principal_grant_revoke_denied`, `agent` = the acting principal) — that log is real and
queryable, but nothing in this pass turns it into a UI feed. That's the named V1 gap, not
tonight's scope.
