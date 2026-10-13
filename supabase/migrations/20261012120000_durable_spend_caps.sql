-- DURABLE SPEND CAPS (Lane 1, DRAFT — NOT applied to prod; applies at merge time).
--
-- WHY. An agent's spend authority must be the MINIMUM of four independent limits, so that no single
-- input can ever widen it:
--   1. the OWNER'S SIGNED CEILING          — a signed grant value (this table)
--   2. the POSTED STAKE                     — the agent's staked amount (read live)
--   3. the RepID TIER LIMIT IN THE DOMAIN   — domain-scoped: a coding score never buys a trade (read live)
--   4. a hard ETHICS FLOOR                  — a constant in code (src/services/durable-caps.ts,
--                                             ETHICS_FLOOR_USDC) that NO env var and NO DB row can
--                                             raise or disable.
--
-- This table holds ONLY the durable input — the owner's signed per-(agent,domain) ceiling. Stake and
-- domain-RepID are read live at decision time; the ethics floor is a code constant and is
-- deliberately NOT stored here. A limit nobody can switch off must not be a row anyone can edit: if
-- the floor lived in a table, a write to that table would be the off switch.
--
-- RepID may only ever TIGHTEN the effective cap (it is one term of a MIN); it can never raise the cap
-- above the owner ceiling or the stake. That is enforced in code by the MIN itself, not by prose.
--
-- FAIL CLOSED. The reader (src/services/durable-caps.ts#resolveEffectiveCap) treats an absent row, an
-- absent table, or ANY unreadable input as a REFUSAL (effective cap 0), never a permissive default.
-- Three outcomes, never two: a resolved cap, or a refusal — never a silent high default. This is why
-- the migration is safe to ship before it is applied: with the table absent, the feature (gated by
-- DURABLE_CAPS_ENABLED, default OFF) refuses rather than falling open.
--
-- ACCESS. RLS on with no policies; every privilege revoked from anon and authenticated, so only the
-- engine's secret key (service_role, which bypasses RLS) reads or writes. A spend ceiling is not public.
--
-- KEY ON THE UNIQUE UUID, NOT THE SLUG (CWE-863). The canonical key is `agent_uuid`
-- (repid_agents.id), NOT the human-readable slug `agent_id` (repid_agents.agent_name). agent_name is
-- NON-UNIQUE in production (many rows can share one slug — see
-- 20260817120000_agent_delegations_canonical_agent_key.sql), so keying on the slug would let the
-- FIRST grant for a slug lock out every colliding agent's real owner, and one owner signature would
-- authorize all of them. The reader resolves slug -> uuid and looks up by `agent_uuid`; the signed
-- grant message binds the uuid too. `agent_id` is retained only as a denormalized label for audit.

create table if not exists public.durable_spend_caps (
  id                 bigserial   primary key,
  agent_uuid         uuid        not null references public.repid_agents(id),  -- CANONICAL KEY: the agent's unique id; the reader looks up and verifies by this
  agent_id           text,                                -- denormalized slug / name label for audit only (NON-UNIQUE) — never the key
  domain             text        not null,               -- spend domain this ceiling governs, e.g. 'coding' | 'trade'
  owner_ceiling_usdc numeric     not null check (owner_ceiling_usdc >= 0),
  owner_address      text,                                -- the owner identity that signed the grant (public); REQUIRED by the reader — a row with no owner_address cannot be verified and is refused
  owner_signature    text        not null,               -- signature over the canonical v2 grant message (durableCapGrantMessage); verified cryptographically, must recover to owner_address
  grant_nonce        text,                                -- optional replay guard for the signed grant
  active             boolean     not null default true,  -- a revoked grant is kept for audit, not read
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  unique (agent_uuid, domain)
);

create index if not exists idx_durable_spend_caps_agent_uuid_domain_active
  on public.durable_spend_caps (agent_uuid, domain)
  where active;

alter table public.durable_spend_caps enable row level security;

revoke all on public.durable_spend_caps          from anon, authenticated;
revoke all on sequence public.durable_spend_caps_id_seq from anon, authenticated;

comment on table public.durable_spend_caps is
  'Lane 1 durable spend caps. One row per (agent_uuid, domain): the OWNER''S SIGNED CEILING only, '
  'keyed by the agent''s UNIQUE uuid (repid_agents.id), never the non-unique slug. Stake and '
  'RepID-in-domain are read live; the ethics floor is a hard-coded constant in '
  'src/services/durable-caps.ts (ETHICS_FLOOR_USDC) and is deliberately NOT a row. Read by '
  'resolveEffectiveCap, which fails closed (effective cap 0) on an absent row/table or any '
  'unreadable input. Service-role only (RLS on, no policies).';

comment on column public.durable_spend_caps.agent_uuid is
  'CANONICAL KEY: the agent''s unique id (repid_agents.id). The reader resolves the slug to this and '
  'looks up / verifies by it, and the signed grant message binds it — so one owner signature '
  'authorizes exactly one agent (CWE-863), never every agent sharing a non-unique slug.';

comment on column public.durable_spend_caps.owner_signature is
  'Signature over the canonical v2 grant message (src/services/durable-caps.ts#durableCapGrantMessage, '
  'EIP-191 personal_sign binding agent_uuid, domain, ceiling, owner_address and nonce). Presence is '
  'required (NOT NULL): a ceiling with no signature is not a grant. The reader '
  '(resolveEffectiveCap -> ownerCeiling) VERIFIES it cryptographically — it must recover to '
  'owner_address — and fails closed on a bad, mismatched, old-v1, or unverifiable signature or a '
  'missing owner_address. When arming, consider making owner_address NOT NULL so an unverifiable '
  'row cannot be inserted at all.';
