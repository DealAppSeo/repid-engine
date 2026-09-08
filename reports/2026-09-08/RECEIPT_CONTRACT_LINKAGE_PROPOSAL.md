# Receipt ↔ Contract linkage: proposal (blocks receipt-based enforcement)

**Status:** PROPOSAL. No DDL, no column added, no code changed. Read-only against prod
`qnnpjhlxljtqyigedwkb`, 2026-09-08. Every number below is tagged `[V]` (verified by query
this session), `[R]` (reported / from repo docs), or `NOT CHECKED`.

## The problem, restated with the measured schema

`service_contracts` and `trustshell_tool_receipts` have **no reference to each other in
either direction** `[V]`. Confirmed against `pg_constraint`: 12 FKs touch
`service_contracts` (it points at `repid_agents`, `agent_services`, `x402_settlements`,
`validation_queue`; and `a2a_awards`, `service_outcomes`, `reputation_attestations`,
`storage_contracts`, `dispute_validation_queue`, `defect_4_validation_log` point back at
it) — and `trustshell_tool_receipts` appears in **none** of them, on either side `[V]`.
The receipts table is an FK island with respect to the contract graph.

The "only shared column is `agent_id`" premise is **weaker than it sounds** `[V]`:

| | `service_contracts` | `trustshell_tool_receipts` |
|---|---|---|
| party columns | `buyer_agent_id uuid`, `provider_agent_id uuid` (FK → `repid_agents.id`) | `agent_id text` (no FK) |

They are not the same type and not the same domain. Contract parties are `repid_agents`
UUIDs; the receipt `agent_id` is free text and today holds
`88d6b597-…` (a raw uuid string), `HARNESS-01`, `xc-forge-agent`, `xc-stolen-key` `[V]` —
i.e. **every receipt in prod is a test/scratch row**, none minted by a real agent against a
real contract. So "join on agent_id" is not just coarse (an agent has many contracts and
many tool calls); it currently joins to nothing real at all.

There is therefore nothing to hang "refuse to settle on an unverified receipt" on. This
proposal decides where the reference belongs — it does **not** add it.

---

## 1. Direction of the reference

**Recommendation: a join table `contract_tool_receipts (contract_id uuid, receipt_id uuid)`,
not a column on either base table.** `[R, design]`

Reasoning, from the measured cardinality and the settlement flow:

- **A contract involves many tool calls** (the buyer's deliverable can be produced by N tool
  invocations), so `service_contracts.receipt_id` (contract → one receipt) is wrong by
  construction — it can only ever name one of them, and "which one" is undefined.
- **A tool receipt is not inherently about one contract**, either. `trustshell_tool_receipts`
  records a tool *execution* (agent, tool, input/output hash, hmac) — the same execution can
  legitimately be evidence for zero contracts (ad-hoc use) or, in principle, be cited by more
  than one. `receipt.contract_id` (receipt → one contract) bakes in a 1:1 that the data model
  does not have, and forces a NULL on every receipt not tied to a contract (which today is all
  of them).
- **A join table is the only shape that carries the real relationship** (contract ⇄ many
  receipts, receipt ⇄ zero-or-more contracts) and keeps the linkage *additive*: it touches
  neither base table, so it cannot break the frozen contract-settlement path or the receipt
  minter. It is also the natural place to record *when/why* a receipt was bound to a contract
  (a `bound_at`, a `bound_by`), which a bare FK column cannot.

This mirrors how the rest of the contract graph is already modelled: contract-adjacent facts
(`a2a_awards`, `service_outcomes`, `reputation_attestations`) live in **separate tables that
FK into `service_contracts`**, not as columns on it `[V]`. The receipt linkage should follow
the same pattern — a table that FKs `contract_id → service_contracts(id)` and
`receipt_id → trustshell_tool_receipts(id)`.

> Type note for whoever writes the DDL later: `service_contracts.id` and
> `trustshell_tool_receipts.id` are **both `uuid`** `[V]`, so the join table's two FK columns
> are clean uuid↔uuid. The `agent_id` type mismatch above is a reason *not* to try to derive
> the link from `agent_id`, not a blocker for the join table.

---

## 2. What breaks for the 224 existing contracts

**Nothing breaks, and that is the point of the join-table shape** — but the enforcement layer
must treat "no linked receipt" as a first-class, non-failing state, or it re-creates the
12-day outage in a new place.

Measured `[V]`:
- **224 contracts total**; **27 settled**; **5 carry a `work_statement_hash`**.
- **15 receipts total**, all test scratch, **0 linked to any contract** (no link exists).

So on day one of a join table, **all 224 contracts carry zero receipts**, and every future
contract will too until a minter starts writing links. Consequences:

- A join table is additive: adding it changes **no existing row** and no settled contract.
  The 224 keep settling exactly as now. ✅
- **Receipt-based enforcement must default to NOT_CHECKED for an unlinked contract, never
  REFUSE.** If "no linked receipt" mapped to REFUSE, enforcement would halt the money path on
  100% of current contracts and 100% of near-future ones — the availability failure is
  guaranteed, not hypothetical. See §4.
- Back-linking the 27 settled contracts is **not possible honestly**: there are no production
  receipts to link them to, and inventing links is fiction. Leave history NULL; enforce
  forward only, exactly as the 2026-08-17 issuer-identity migration decided for its own
  backfill `[R]`.

---

## 3. Does `work_statement_hash` already cover part of this?

**Partly — for the *satisfy* path, yes; for the *tool-evidence* path, no. They bind different
things and should not be conflated.** `[V]` + `[R, src/services/work-statement*.ts]`

- `work_statement_hash` binds **what was agreed**: a canonical SHA-256 over
  `(acceptance_criteria, agreed_price, deadline, deliverable)`, written by the Postgres
  trigger `trg_service_contracts_work_statement` at bind time `[R]`. It makes the *terms*
  tamper-evident and lets a receipt prove "this proof is about this exchange and no other."
- It says **nothing about which tool calls produced the deliverable**. A receipt linkage is
  about *evidence of the work*, not *the terms of the work*. `work_statement_hash` cannot
  answer "was the deliverable produced by a tool run whose receipt verifies?" — that is the
  question receipt enforcement exists to answer.
- Coverage is also thin: **5 of 224** contracts carry a hash `[V]` (the rest settled before
  ZK BIND T1, per the `trust-receipt.ts` caveat `[R]`). So even for the terms-binding it
  covers, it is not yet a load-bearing signal across the table.

**Where they overlap (and where redundancy is real):** for the *satisfy* decision — "did the
provider deliver what was agreed?" — `work_statement_hash` + `criterion_ratings` +
`buyer_satisfaction_score` already give a checkable, on-receipt story `[R, trust-receipt.ts]`.
Receipt linkage adds little there. **Where they do not overlap:** "was the delivered artifact
produced by a genuine, signed tool execution rather than fabricated?" — that is purely the
receipt's job, and `work_statement_hash` is silent on it. Conclusion: **keep both; do not make
receipt linkage a prerequisite for the satisfy path** (work-statement already covers it), and
scope receipt enforcement to the tool-evidence claim only.

---

## 4. Enforcement semantics — THREE outcomes, and the load-bearing NOT_CHECKED

The existing view **already encodes exactly this distinction**, which is the strongest
argument that the three-outcome model is right: `v_trustshell_tool_receipts_verified` computes
`verified boolean` plus a `quarantine_reason` with these branches `[V, pg_get_viewdef]`:

```
verified = (sig_version = 2 AND minted_by IS NOT NULL AND expected IS NOT NULL
            AND hmac_signature = expected)
quarantine_reason =
  sig_version <> 2        -> 'legacy_sig_v'||sig_version   -- old format, cannot verify
  minted_by IS NULL       -> 'no_minter_direct_insert'      -- FORGERY: bypassed the minter
  expected IS NULL        -> 'signing_key_unavailable'      -- key not loadable
  hmac_signature<>expected-> 'signature_mismatch'           -- FORGERY: tampered/forged sig
```

Map enforcement onto this as **three outcomes**, and pin `signing_key_unavailable` to
NOT_CHECKED explicitly:

| Outcome | Exit | View state(s) | Money-path action |
|---|---|---|---|
| **ALLOW** | 0 | `verified = true` | settle |
| **REFUSE** | 3 → mapped to dispute/hold | `signature_mismatch`, `no_minter_direct_insert` | do **not** settle; the receipt is forged/tampered |
| **NOT_CHECKED** | (distinct, never 0, never REFUSE) | `signing_key_unavailable`, **no linked receipt**, `legacy_sig_v*` | leave contract in place for retry; **do not** settle-as-pass and **do not** dispute |

The three hard rules, each with the reason it exists:

1. **`signing_key_unavailable` → NOT_CHECKED, never REFUSE and never ALLOW.** The key row
   (`receipt_signing_key` id=1) not loading is an *infrastructure* fact, not a verdict on the
   receipt. REFUSE would halt the money path on a key-loading failure — the same class as the
   HAL 12-day outage where NOT_CHECKED was scored as FAILED and it moved real money `[R,
   CLAUDE.md]`. ALLOW would settle on an unchecked receipt — the availability-over-integrity
   error in the other direction.
2. **No linked receipt → NOT_CHECKED, never REFUSE** (see §2). Today that is every contract.
3. **NOT_CHECKED must be operationally distinct from both PASS and FAIL** — it settles nothing
   and disputes nothing; it leaves the contract for a later cycle to re-evaluate, exactly the
   pattern PR #529 established for the validator path (`checked: false` → contract stays
   escrowed for retry, never disputed) `[R]`. A binary pass/fail collapses NOT_CHECKED into
   whichever side is the default, and whichever default you pick is a known outage.

Note the enforcement layer should read **REFUSE only from the two genuine forgery branches**
(`signature_mismatch`, `no_minter_direct_insert`). `legacy_sig_v*` is *"cannot verify this
old format,"* which is NOT_CHECKED, not forgery — see §5 for why that boundary matters.

---

## 5. "Forgeries detected and quarantined": construction, not injection

**It was proven by CONSTRUCTION only. No forgery has ever been observed to quarantine, and I
can cite the run that would have shown it and did not.** `[V]`

Live classification of the 15 receipts `[V, GROUP BY on the view]`:

```
verified = true                      1
legacy_sig_v1  (quarantine_reason)  14
signature_mismatch                   0
no_minter_direct_insert              0
signing_key_unavailable              0
```

This matches your reading exactly. Now the part you could not check — **why** it's all
`legacy_sig_v1`, and what that says about the guard:

The 15 rows, by `sig_version` / `minted_by` `[V]`:
- **1 row** `sig_version = 2`, `minted_by` set → the single `verified = true` (HARNESS-01, the
  happy path).
- **14 rows** `sig_version = 1`, `minted_by` **NULL** — including agent_ids literally named
  **`xc-forge-agent`** and **`xc-stolen-key`** `[V]`.

Someone clearly *intended* to test forgery — the fixtures are named for it. But every one of
those fixtures is `sig_version = 1`, and the view's CASE tests `sig_version <> 2` **first**, so
they all fall into `legacy_sig_v1` and **never reach** the `no_minter_direct_insert` branch
(which their `minted_by IS NULL` would otherwise trigger) or `signature_mismatch`. The two
branches that constitute actual forgery detection have **fired zero times in production**. The
one `sig_version = 2` row is the *pass* case. So:

- **No `sig_version = 2` receipt with a tampered HMAC has ever been injected** → the
  `signature_mismatch` branch is unexercised.
- **No `sig_version = 2` receipt with `minted_by = NULL` has ever been injected** → the
  `no_minter_direct_insert` branch is unexercised.
- The forgery fixtures that *do* exist are quarantined as `legacy_sig_v1`, which is the
  *softer, benign* bucket ("old format") — not as "forgery detected." A reader glancing at the
  data would see 14 "legacy" and conclude the forgery path is clean, when in fact it has never
  run.

**Per LESSONS §3 and §6, this guard is currently "wired at one end only" / "a test that cannot
fail":** the CASE expression is correct-looking, but a guard nobody has watched go red is a
comment. To make it an asset, inject three `sig_version = 2` rows and assert the view buckets
them:
1. correctly minted → `verified = true`
2. same but HMAC flipped one byte → `signature_mismatch`
3. same but `minted_by = NULL` → `no_minter_direct_insert`

and, to close the NOT_CHECKED corner, temporarily point `receipt_signing_key` away (or read as
absent) and assert a v2 row surfaces `signing_key_unavailable`, **not** `signature_mismatch`.
Until that run exists and is cited, the honest claim is *"the classifier is defined and the
happy path verifies; forgery quarantine is unproven against live data."*

> Housekeeping finding (not the question, but adjacent): the checked-in
> `src/types/database.types.ts` for `trustshell_tool_receipts` is **stale** — it omits the
> live `minted_by` and `sig_version` columns `[V]`. Regenerate types before any code binds to
> the verification view.

---

## Summary for the enforcement decision

- **Link via a join table** `contract_tool_receipts(contract_id, receipt_id)` (uuid↔uuid),
  not a column — a contract has many tool calls and a receipt isn't owned by one contract. §1
- **Additive; nothing breaks.** All 224 contracts (27 settled, 5 with a work-statement hash)
  keep settling; history stays NULL, enforce forward only. §2
- **`work_statement_hash` covers the *terms/satisfy* path, not the *tool-evidence* path** —
  keep both, don't gate satisfy on receipts. §3
- **Three outcomes.** ALLOW only on `verified=true`; REFUSE only on the two forgery branches;
  everything else — including `signing_key_unavailable` and *no linked receipt* — is
  NOT_CHECKED, which halts nothing and disputes nothing. §4
- **Forgery quarantine is proven by construction only** — 0 of the two forgery branches have
  ever fired; the "forge"/"stolen-key" fixtures are all `sig_version=1` → `legacy_sig_v1`.
  Inject v2 forgeries and cite the run before claiming detection. §5

*No DDL was run. Read-only against prod. Draft PR — await Strix verdict on the exact head SHA
before merge.*
