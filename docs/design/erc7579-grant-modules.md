# ERC-7579 as `principal_grants`' deferred on-chain projection (design-only)

**Status: design, not implementation.** No Solidity, no modular smart account (MSA)
deployment, no claim that a live 7579 account exists anywhere in this stack. XC's
`docs/policy/grants-authority.v0.md` (PR #117, trinity-ecosystem) already specifies the
policy-level mapping (`installModule = mint`, `uninstallModule = revoke`) for
trinity-ecosystem's own `delegation.ts` machinery. This doc is the companion piece for
**this repo's** implementation — `principal_grants` — and, more usefully, why staying
off-chain is the correct MVP choice rather than a shortcut being paid down later.

## The mapping, concretely

[ERC-7579](https://eips.ethereum.org/EIPS/eip-7579) defines a modular account standard:
an account installs/uninstalls typed modules (validators, executors, hooks, fallback
handlers) rather than granting raw key access. That is, structurally, exactly what
`principal_grants` already does off-chain:

| 7579 concept | `principal_grants` today | Source |
|---|---|---|
| `installModule(moduleType, module, initData)` | `mintGrant()` | `src/services/principal-grants.ts` |
| `uninstallModule(moduleType, module, deInitData)` | `revokeGrant()` | same |
| module `initData` | `capabilities` + `caveats` (jsonb) | `principal_grants` table |
| validator module | `permits()` capability check | `principal-capability.ts` |
| executor module | the spend/routing action a grant's `capabilities` allow | — |
| hook module | `evaluateCaveats()` — `maxValue` / `maxCalls` / tool allowlist | `principal-caveat.ts` |
| fallback handler | an unclassified tool — treated as a write, same posture as
  trinity-ecosystem's `auditor-grant.ts` | `decideMint()`'s cold-grant read-only check |
| account owner revoking a module | the direct grantor calling `revokeGrant()` | `decideRevoke()` — G6 |

Every column this mapping needs already exists. **Nothing about today's schema would
need to change to describe a future on-chain module the same way** — `capabilities` and
`caveats` are already the shape a module's `initData` would encode.

## Why off-chain-only is the right call today, not a shortcut

XC's own framing: *"In-memory 7579-shaped registry is enough to measure G6; not an
on-chain MSA."* Concretely, three costs an on-chain MSA would add for zero benefit at
MVP stage:

1. **A real smart account per user.** Every principal (PAI, spawned CTO/CFO/CMO worker)
   would need its own deployed 7579-compatible account before it could hold a module —
   directly contradicting the "least friction" onboarding goal (see below). Today's
   grants need no on-chain identity at all; `grantor_agent_id` / `grantee_agent_id` are
   plain strings.
2. **Gas on every mint/revoke.** `principal_grants` mints and revokes are Supabase
   writes today — free, instant, and (per PR #442's own live verification) already
   fail-closed and auditable via `trinity_agent_logs`. An `installModule` /
   `uninstallModule` call is an on-chain transaction with real cost and real latency,
   for a decision (a PAI spawning a scoped sub-agent) that may happen many times per
   session.
3. **A module registry and audit surface that doesn't exist yet.** ERC-7579 expects
   modules to come from an audited registry. Standing that up is real infrastructure
   work with its own security surface — not something to bolt on opportunistically
   alongside a grants MVP.

None of this is a reason to never build the on-chain path — it's a reason the **default**
stays off-chain, with on-chain treated as an explicit upgrade a principal opts into once
it actually needs on-chain-verifiable authority (a counterparty who won't trust an
API-backed attestation, e.g.), not the default every grant pays for.

## Where this plugs into progressive onboarding

This is the concrete mechanism behind "defer Web3 until its value is already shown,"
directly answering the onboarding research from earlier tonight, and matching
trinity-ecosystem PR #117's own new `docs/policy/progressive-onboarding.v0.md` (O1-O3:
no root key to the PAI, first spend needs an explicit grant, constitution Q&A writes
rules not keys):

- **Phase 0-2 (today, live):** a PAI mints/revokes `principal_grants` rows for its
  spawned workers. Zero wallets, zero gas, zero on-chain footprint. The PAI never holds
  a root key — `mintGrant()` doesn't create one; it writes a scoped row.
  Progressive-onboarding's O1 ("PAI runtime has no root/owner secret") is true here by
  construction, not by policy alone.
- **The signed-mint-intent follow-up already shipped tonight (PR #442) is the seam.**
  A grant CAN optionally carry an EIP-712-signed intent once a principal has a
  `repid_agents.wallet_address` on record (`signature_status: VERIFIED`) — but doesn't
  require one (`NOT_CHECKED`, the common case: 18 of 176 agents today). That's exactly
  "deferred, requested only when actually needed" — the wallet only has to exist the
  moment cryptographic consent is actually wanted, never at onboarding time.
- **If/when a principal wants on-chain-verifiable authority**, the SAME `capabilities`
  + `caveats` a grant already carries become a real module's `initData` on a 7579
  account, using the mapping table above. The PAI's mental model (mint = grant scoped
  authority, revoke = take it away) never changes; only the settlement layer underneath
  it gains an on-chain option. That is the "IKEA principle" applied to infrastructure,
  not just UX copy: the user (and the PAI) already understand grants before they ever
  see a gas prompt.

## What this doc does not authorize

- Deploying, or claiming the existence of, any 7579-compatible account or module.
- Treating today's off-chain `principal_grants` row as equivalent to an on-chain
  install — it is the off-chain analog XC's doc names, not a stand-in that can be
  marketed as on-chain authority.
- Changing `principal_grants`' schema to add on-chain fields (`module_address`, etc.)
  before an actual on-chain consumer exists to use them — that's exactly the kind of
  speculative surface this repo's stubs convention (`CLAUDE.md`) warns against building
  ahead of a real caller.
- A UI surface for any of this. Design only, per Sean's explicit scope for tonight.
