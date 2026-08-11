# stake → authority is reading the wrong table — three defects, one money path

**Found 2026-08-11 while starting spec §6 step 3. Not fixed here: this changes who may spend
money, so it is ORIGINAL work touching LIVE STATE and ships shadow-first, after Sean's look
(CLAUDE_RULES 23).**

---

## The finding

`src/services/x402-gate.ts` decides whether an agent may settle an x402 payment. For the tiers
that `requires_stake` (EARNING, ESTABLISHED), it sums collateral and refuses transfers the stake
does not cover. Line 98:

```ts
db.from('agent_stakes').select('stake_amount').eq('staker_agent', shortId).eq('status','active')
```

**`agent_stakes` is not a collateral table.** Its columns:

```
staker_agent, target_model, dimension, stake_amount, stake_position,
actual_consensus, deviation, slash_amount, learning_tip, status
```

`target_model` · `stake_position` · `actual_consensus` · `deviation` — this is a **prediction
market**. An agent wagers that a model will score a certain way on a dimension, and is slashed on
deviation. It is a bet on an outcome, not capital posted against misbehaviour.

The collateral table is **`stake_deposits`** — `builder_id, amount, asset, tx_hash, is_simulated`
— which is what `depositStake()` in `src/services/stake-vault.ts` actually writes.

### Live counts `[V 2026-08-11]`

| table | active rows | sum | note |
|---|---:|---:|---|
| `stake_deposits` — collateral | **50** | 4,672,000,000 raw | **49 of 50 are `is_simulated`** |
| `agent_stakes` — prediction wagers | 4 | 175,500,000 raw | what the gate reads |
| `staking_deposits` | **0** | — | named in the gate's own doc comment; **does not exist as data** |

## Three defects, not one

1. **Real collateral earns no authority.** A builder who posts USDC lands in `stake_deposits`,
   which the gate never queries. Their stake is invisible; their agent stays gated.
2. **Prediction wagers grant spending authority.** Rows in `agent_stakes` are summed as if they
   were posted collateral, so winning bets on model scores buy the right to spend real money.
3. **Simulated deposits are not excluded.** 49 of 50 active deposits are `is_simulated`. Any fix
   that simply repoints the reader at `stake_deposits` would grant real authority against
   **demo collateral** — a worse bug than the one it replaces.

There is also a **join gap**: `stake_deposits` is keyed on `builder_id` (a human/account) and the
gate reasons about an agent. Repointing requires a verified builder→agent mapping, which is a
design decision, not a rename.

## Defect 5 — the staking API's own read and write disagree `[V 2026-08-11]`

Found while correcting the stale comment. In **one router**, both endpoints live under
`app.use('/api/v1', mvpApiRouter)`:

```
POST /api/v1/staking/deposit  ->  writes  agent_stakes      (the prediction-market table)
GET  /api/v1/staking/:agent   ->  reads   staking_deposits  (the EMPTY table, 0 rows)
```

So a caller stakes through the API and is then told, by the same API, that they have
`total_active_usdc: 0` and `deposits: []`. Permanently, for every agent, regardless of what they
staked. The read can never return anything, because nothing writes the table it reads.

This also revises defect 2's framing: `agent_stakes` is not merely *"a prediction market the gate
mistakenly reads."* It is **also where this deposit endpoint writes**, which is very likely the
origin of the 4 rows the gate credits. The concepts are conflated at the WRITER, not only at the
reader — so there are two deposit paths (`stake-vault.ts#depositStake` → `stake_deposits`, and
`POST /staking/deposit` → `agent_stakes`) landing in different tables, neither of which the
`GET` surface reads.

**Three tables, two writers, one blind reader.** That is the whole reason "stake → authority" has
never worked, and no single rename fixes it.

## How this hid for so long

The gate's own header comment says stake is summed from *"active `staking_deposits`"* — a table
with **zero rows that no code writes**. The comment names neither the table the code reads
(`agent_stakes`) nor the one the writer fills (`stake_deposits`). Three stake-ish names, and the
documentation points at the one that is empty.

I repeated the error myself: I reported "0 active stakes" earlier in the session, having queried
`staking_deposits` **because the comment named it**. The true figure is 50 active deposits. That
is LESSONS 2 (verify the thing itself, never a proxy) and LESSONS 5 (match the real names the
system emits) landing on the same line of code.

## Why nothing looked broken

`x402_payment_gates` holds **2 decisions, ever**. The path has effectively never run, so neither
defect has produced a visible failure. Absence of incidents was absence of traffic.

## The fix, shadow-first

1. A resolver that computes authority-backing collateral from `stake_deposits`, **excluding
   `is_simulated`**, via an explicit builder→agent mapping.
2. Run it **alongside** the current sum, log both to `x402_payment_gates`, change no decision.
3. Measure the divergence on real traffic. Only then flip, with Sean's GO.

Do **not** hot-swap the table. Defect 1 currently fails *closed* (under-granting), which is the
safe direction; a careless fix inverts it to failing *open* against simulated collateral.

## What this means for the demo

Spec §6 step 3 called this "the least-tested path in the system and where the bugs will be."
That was right, and Act One of the demo — *stake USDC, unlock your agent* — cannot honestly run
until the gate reads the table the deposit actually lands in.

---
*`[V]` = verified against live Supabase in-session, 2026-08-11.*
