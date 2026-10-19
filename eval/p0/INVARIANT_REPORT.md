# P0 invariant report: policy kernel, origin/main

XC1 (red-team and evaluator lane), 2026-10-19. Trust Harness gate P0.
Code under test: `origin/main` at `584d165f`. Nothing under `src/` was edited, even temporarily.

Tests: [`tests/kernel/p0-invariants.test.ts`](../../tests/kernel/p0-invariants.test.ts) and
[`tests/kernel/p0-receipt-strip.test.ts`](../../tests/kernel/p0-receipt-strip.test.ts). They extend
the #1323 red-team suite in its style:

- `it('[PASS …]')`: the invariant held.
- `it.failing('[FAIL …]')`: a secure expectation main does not meet. It stays green while the hole
  is open and turns red when it closes.
- `it.todo('[NOT_CHECKED …]')`: the mechanism the invariant needs does not exist yet.
- `CHARACTERISE`: pins a limitation so it cannot change unnoticed.

## Counts

| | distinct probes | individual jest tests |
|---|---|---|
| PASS | 45 | 136 |
| FAIL | 10 | 10 |
| NOT_CHECKED | 2 | 2 (`todo`) |
| CHARACTERISE | (9 pins, beside the FAILs) | 9 |
| positive control (unnamed) | | 1 |
| **total** | **57** | **158**: jest reports 156 passed, 2 todo |

Every `[FAIL]` was also run as a plain `it` (a temporary copy, since deleted). All 10 failed at their
intended assertion, not for an incidental reason. Every refusal group includes an ALLOW control from
the same harness.

## Findings (the 10 FAILs)

| id | finding | reachable today? |
|---|---|---|
| P0-I3-01, P0-I3-02 | **With the flag OFF (the production default), the tool class is the caller's word.** A payment closure filed as `read` runs under a policy that allows no spend. A publishing closure filed as `other` runs with no HAL check. This is #1323's RT-6, now measured as an I3 breach. The flag-ON registry closes it (P0-I3-05). | Not over HTTP: `runUnderKernel` has no production caller, and `/decide` is dry. Reachable as soon as an in-process caller exists with the flag OFF. |
| P0-I2-08 | **A failed OUTCOME append cannot mean zero effect.** The tool has already run. The gate reports `outcome_unrecorded` and withholds the result, but the ledger then shows an AUTHORIZED decision and nothing after it. That looks the same as "authorized, never run". There is no INDETERMINATE state and no reconciliation. | In-process only. |
| P0-I3-16 | **The grant does not bind the argument digest.** One owner policy authorizes any `args_hash`. | In-process only. |
| P0-TK-04, P0-TK-05 | **No one-use consumption.** Ten concurrent presentations of one identical attempt produce 10 effects. A replay after the effect is ALLOWed. The grant has no attempt id and no use count. | In-process only. |
| P0-TK-03 | **Owner-approval nonces live in process memory.** After a restart, a used approval verifies again. The source states this window, at most `MAX_LIFETIME_S` (10 min), for the identical action and params. | Yes. This is the live owner-authorization path, used by `key-management`, `mvp-api` and `v1`. |
| P0-VF-05 | **The kernel accepts a HAL PASS from any `method` string.** An unknown verifier counts as a pass. Same class as #1323 RT-2. | Only through an in-process `halCheck`. Under `KERNEL_HAL_ENABLED` the adapter sets `method` itself. |
| P0-RS-02 | **PR #1358's concession is PROVEN.** Strip the `capability` row and the `capability_enforced` marker from an enforced ALLOW, then reseal. `validateReceipt` accepts the result, and it reads as a flag-OFF ALLOW. | Anyone who can write the receipt store. |
| P0-RS-03 | **It goes further than the concession.** On an enforced capability DENY, the stripped rows were the only failing checks. Flip the verdict, clear the reasons and reseal, and you have a valid ALLOW for a tool the registry refused. | Same. |

**What catches the strip-and-reseal** (both PASS rows below are measured, not assumed):

- the receipt chain, when a later entry exists (P0-RS-04);
- the engine's detached receipt signature in the DB index (P0-RS-06).

**What does not catch it:**

- a chain where the attacker reseals every entry after the forgery (P0-RS-05, the chain is unsigned);
- a forged tip;
- any verifier running without `RECEIPT_SIGNING_KEY` (P0-RS-08: NOT_CHECKED);
- the key holder, who can sign the forgery (P0-RS-07).

**Two NOT_CHECKED:**

- **P0-I2-11:** there is no capability reservation to fail. Spend totals are summed after the fact,
  which is the "NOT ATOMIC" note in `gate.ts`.
- **P0-TK-06:** one-use capability tokens (compare-and-set consumption, consumption that survives a
  restart, INDETERMINATE reconciliation) do not exist on main.

**Low, characterised, not counted as a FAIL:**

- **P0-I3-10:** a whitespace- or BOM-padded implementation id resolves to the canonical registration
  (`trim`). The receipt keeps the padded name, so an exact-match audit query misses it.
- From reading the code, not tested: `parsePolicy` accepts implementation ids without `/`, while
  `register()` accepts `/`. An id containing `/` can be registered but never authorized. It fails
  closed.

## Invariant table

Paths are relative to the repo root. `inv` = p0-invariants.test.ts, `strip` = p0-receipt-strip.test.ts,
`rt` = red-team.test.ts (#1323).

### I1: DENY or NOT_CHECKED means zero protected effect

"Zero effect" is checked from outside. The tool and every registered impl are called 0 times. The
gate returns no result and no tool_error. No outcome row is written, the receipt says
`executed:false`, and the payment is `NOT_APPLICABLE`.

| id | test | result | what it proves | what it cannot prove |
|---|---|---|---|---|
| P0-I1-00 | inv:166 | PASS | Control: the same harness ALLOWs and runs once for read, spend, post and other. | — |
| P0-I1-01 | inv:188 | PASS | 4 classes × 8 refusal families (no policy, store down, owner unknown or none, expired, other subject, no actions, impostor signer) give the right DENY or NOT_CHECKED and zero effect. 32 cases. | Effects outside the closure. The kernel only governs what runs through it. |
| P0-I1-02 | inv:200 | PASS | Flag ON: an unregistered tool is DENY in every class. Neither the caller's closure nor any registered impl runs. | — |
| P0-I1-03 | inv:209 | PASS | Flag ON: a registry that throws while screening gives NOT_CHECKED and runs nothing. | A registry that lies (returns a wrong entry) is not modelled. |
| P0-I1-04 | inv:224 | PASS | DENY and NOT_CHECKED rows add nothing to the cumulative spend totals. The full budget remains. | Concurrent spends (rt:526, RT-5). |
| P0-I1-05 | inv:245 | PASS | A malformed request is DENY, with nothing persisted and nothing run. | — |
| P0-I1-06 | inv:255 | PASS | `observePayment` is never called on a refusal. | — |

### I2: no effect if the decision cannot be written durably or an append fails

| id | test | result | what it proves | what it cannot prove |
|---|---|---|---|---|
| P0-I2-01 | inv:273 | PASS | A decision-row append that throws or rejects late gives NOT_CHECKED(`receipt_write_failed`) and tool 0. 8 cases (4 classes × 2 modes). | Partial writes inside a real sink. |
| P0-I2-02 | inv:285 | PASS | A DENY whose row cannot be written stays DENY and runs nothing. | — |
| P0-I2-03 | inv:296 | PASS | Ordering: the ALLOW decision row is in the sink when the tool starts. | — |
| P0-I2-04 | inv:311 | PASS | One failed append does not wedge the ledger lock. The next call writes and runs. | — |
| P0-I2-05 | inv:327 | PASS | On-disk JSONL with an unwritable path: nothing runs. | Disk-full or fsync failure on a real disk. |
| P0-I2-06 | inv:344 | PASS | On-disk JSONL with a damaged line: every read refuses, NOT_CHECKED, nothing runs. | — |
| P0-I2-07 | inv:355 | PASS | Control: a writable JSONL has the decision line on disk before the tool returns. | Durability across power loss. `datasync` is called, but this test does not cut power. |
| P0-I2-08 | inv:372 | **FAIL** | A failed OUTCOME append leaves an effect: the tool has already run. CHARACTERISE at inv:380 shows `outcome_unrecorded`, the result withheld, one row on the ledger, and no INDETERMINATE state. | — |
| P0-I2-09 | inv:398 | CHARACTERISE | A sink that acks and drops is not detected. The tool runs, and a restarted ledger has no record of it. | The kernel trusts the sink's contract by design. |
| P0-I2-10 | inv:414 | CHARACTERISE | The best-effort DB index failing does not block the effect. The JSONL file is the only durable precondition, and in production it lives under `os.tmpdir()` (rt RT-3). | — |
| P0-I2-11 | inv:430 | NOT_CHECKED | No capability reservation exists to fail. | Everything about reservations. |

### I3: class from registration; forged, swapped and look-alike ids; widened scope; what a grant binds

| id | test | result | what it proves | what it cannot prove |
|---|---|---|---|---|
| P0-I3-01 | inv:438 | **FAIL** | Flag OFF: a payment closure filed as `read` ALLOWs and runs under a no-spend policy. | — |
| P0-I3-02 | inv:445 | **FAIL** | Flag OFF: a publishing closure filed as `other` ALLOWs. HAL (set to VETO) is never asked. | — |
| P0-I3-03 | inv:453 | CHARACTERISE | The flag-OFF receipt states `tool_class (caller-asserted …)`. | — |
| P0-I3-04 | inv:468 | PASS | Control: each registered impl under its registered class ALLOWs and runs the registered function once. | — |
| P0-I3-05 | inv:479 | PASS | 3 impls × 3 wrong classes: DENY(`impl_class_mismatch`), nothing runs, even when handed the impl's own function. The class is bound at registration. | The request still carries `tool.class`, which is compared, not ignored. A registry entry with the wrong class registered at boot is trusted. |
| P0-I3-06 | inv:488 | PASS | A forged id is DENY(`unregistered_tool`). | — |
| P0-I3-07 | inv:500 | PASS | 3 swaps (one id named, another registered function handed over) are DENY(`impl_reference_mismatch`), and neither function runs. | — |
| P0-I3-08 | inv:507 | PASS | A closure with the same source text is not the registered object. | — |
| P0-I3-09 | inv:527 | PASS | 10 look-alike ids (Cyrillic, fullwidth, zero-width, case, trailing dot or NUL, `_` for `.`, path suffix, combining mark) are DENY even when handed the real function. | Look-alikes the list misses. Matching is exact-string, which is the right default. |
| P0-I3-10 | inv:535 | CHARACTERISE | Whitespace- or BOM-padded ids resolve to the canonical entry, and the receipt keeps the padded name. | — |
| P0-I3-11 | inv:545 | PASS | `register()` refuses non-ASCII ids, duplicate ids, one function under two ids, and an unknown class. | A boot module that registers a hostile impl on purpose. |
| P0-I3-12 | inv:558 | PASS | A registered but unbound impl is DENY(`impl_unauthorized`). | — |
| P0-I3-13 | inv:565 | PASS | Adding a binding without re-signing breaks the v2 signature: DENY. | — |
| P0-I3-14 | inv:576 | PASS | A v1 policy (blanket `tool`) authorizes no impl under enforcement. | — |
| P0-I3-15 | inv:585 | PASS | A binding does not widen `actions`: a bound payment impl without `spend` is DENY. | — |
| P0-I3-16 | inv:598 | **FAIL** | The grant does not bind the argument digest. | — |
| (bound) | rt:249, rt:248, rt:477 | PASS (#1323) | The grant binds identity (subject), expiry, and nonce supersession within one ledger. The policy hash is in every receipt. | Nonce supersession across a restart (rt RT-3). |

### AP: a fake owner approval authorizes nothing

| id | test | result | what it proves | what it cannot prove |
|---|---|---|---|---|
| P0-AP-01 | inv:622 | PASS | A genuine signature carried onto a policy with a raised limit is DENY(`policy_signature_invalid`). | — |
| P0-AP-02 | inv:630 | PASS | A v1 signature carried onto a policy that adds bindings is DENY. | — |
| P0-AP-03 | inv:638 | PASS | The owner's signature under another EIP-712 domain (chainId 1) is DENY. | — |
| P0-AP-04 | inv:652 | PASS | 4 placeholder signatures (`0x`, one byte, 65 zero bytes, non-hex) are never ALLOW. | — |
| P0-AP-05 | inv:657 | PASS | 10 approval-shaped body fields (`owner_authorization`, `approved`, `hal`, `verdict`, `capability`, …) are rejected by the strict parser: nothing persisted, nothing run. | — |
| P0-AP-06 | inv:669 | PASS | 4 extra `tool.*` fields are rejected: the request cannot vouch for its own tool. | — |
| P0-AP-07 | inv:699 | PASS | Control: a genuine owner approval verifies. | — |
| P0-AP-08 | inv:709 | PASS | An approval from another wallet, for other params, another action or another subject is `bad_signature`. | — |
| P0-AP-09 | inv:720 | PASS | A missing, expired, over-long or malformed-nonce approval is refused. | — |
| P0-AP-10 | inv:730 | PASS | A forged approval does not burn the owner's nonce. | A real ERC-1271 wallet contract. Chains are fakes. |

### VF: an unknown or unavailable verifier is NOT_CHECKED, never a pass

| id | test | result | what it proves | what it cannot prove |
|---|---|---|---|---|
| P0-VF-01 | inv:764 | PASS | Smart-wallet policy signature with getCode unreachable, the `isValidSignature` call unreachable, or ERC-6492 with the chain unreachable: NOT_CHECKED(`policy_signature_not_checked`), nothing runs, for spend and read. | A real RPC's error shapes. These are thrown `Error`s. |
| P0-VF-02 | inv:775 | PASS | Control: a verifier that answers "not valid" is DENY, not NOT_CHECKED. | — |
| P0-VF-03 | inv:785 | PASS | Owner authorization for a smart wallet with the chain unreachable is `not_checked`, never ok. | — |
| P0-VF-04 | inv:795 | PASS | The engine receipt-signature verifier with no key is NOT_CHECKED, never VERIFIED. | — |
| P0-VF-05 | inv:809 | **FAIL** | A HAL PASS naming an unknown verifier `method` ALLOWs a post. | — |
| (HAL) | rt:127 | PASS (#1323) | HAL not wired, throwing, abstaining, null, or returning an unknown verdict word is never ALLOW. | — |

### TK: one-use tokens under a race and on replay

| id | test | result | what it proves | what it cannot prove |
|---|---|---|---|---|
| P0-TK-01 | inv:833 | PASS | 12 concurrent presentations of one owner approval: exactly 1 ok, 11 `replayed`. The nonce is reserved before the async check. | More than one replica. The API runs one. |
| P0-TK-02 | inv:840 | PASS | A sequential replay is refused. | — |
| P0-TK-03 | inv:846 | **FAIL** | After a restart, a used approval verifies again. | — |
| P0-TK-04 | inv:855 | **FAIL** | 10 concurrent presentations of one authorized attempt give 10 effects. | — |
| P0-TK-05 | inv:862 | **FAIL** | A replay of an attempt after its effect is ALLOWed. | — |
| P0-TK-06 | inv:869 | NOT_CHECKED | No one-use capability token exists. | Everything about CAS consumption. |

### RS: capability row AND `capability_enforced` marker stripped, then resealed (PR #1358)

| id | test | result | what it proves | what it cannot prove |
|---|---|---|---|---|
| (control) | strip:67 | PASS | The genuine enforced ALLOW and DENY validate, carry both rows, and form a valid chain. | — |
| P0-RS-01 | strip:79 | PASS | Stripping only the capability row is refused. The #1358 F2 control holds. | — |
| P0-RS-02 | strip:88 | **FAIL** | Stripping both rows and resealing validates. CHARACTERISE at strip:92: it reads as flag-OFF, and only the hash differs. | — |
| P0-RS-03 | strip:104 | **FAIL** | An enforced DENY rewritten into an ALLOW validates. CHARACTERISE at strip:112. | — |
| P0-RS-04 | strip:124 | PASS | Substituted into the ledger, the forgery breaks the chain at the next entry. | A forged tip, or a resealed suffix (P0-RS-05). |
| P0-RS-05 | strip:134 | CHARACTERISE | Resealing every later entry makes the chain verify again. | — |
| P0-RS-06 | strip:160 | PASS | The engine detached signature over the original FAILS on both forgeries. | That the DB index actually holds a signature. With no key it indexes UNSIGNED. |
| P0-RS-07 | strip:179 | CHARACTERISE | The key holder can sign the forgery. The signature shows who sealed, not that enforcement ran. | — |
| P0-RS-08 | strip:188 | PASS | Without the engine key, the check is NOT_CHECKED, never VERIFIED. | — |

## What this report does not prove

- **No production behaviour.** No database, Railway service or chain was read or touched. The
  flags (`KERNEL_CAPABILITY_REGISTRY_ENABLED`, `KERNEL_HAL_ENABLED`, `RECEIPT_SIGNING_KEY`) were not
  read in production. Each flag-ON result is for an injected registry or key in a unit test.
- **No mutation testing of `src/`.** #1323 mutated `decide.ts` by hand and reverted. This lane's
  rule forbids touching `src/` even temporarily. Non-vacuity rests on the positive controls and on
  running every `[FAIL]` as a plain `it`.
- **Only what runs through the kernel.** Code that calls a tool without `runUnderKernel` is outside
  every invariant here, and `runUnderKernel` has no production caller today.
- **No multi-replica race.** The single-process lock and the owner-auth nonce reservation hold for
  one process. Two replicas were not modelled.
- **Not family-independent.** This lane runs on Claude, the same model family as the CC1 builder. It
  is separated by lane (its own context, its own files, no `src/` edits), not by model family.
  Final grading of CC1's PRs should also be run by Sean's usual XC1 lane if that uses another family.
