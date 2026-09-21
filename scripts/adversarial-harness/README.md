# Adversarial harness (LOOP X8)

Free, local, disposable. This is the staging environment every live red-team
probe was missing — the one that used to return `BLOCKED_FOR_SEAN`.

It never points at prod, never uses a real key, never broadcasts.

## One command

```bash
npm run harness          # up → probes → isolation proof → down
npm run harness:up       # scratch LOCAL_MODE store + anvil fork (if installed)
npm run harness:probe    # probes only (expects `harness:up` already)
npm run harness:down     # kill anvil, delete .harness/
```

## What it is

1. **Local chain** — `anvil --fork-url https://sepolia.base.org --fork-block-number <pin>`.
   Pin is `scripts/adversarial-harness/pin.json`. If anvil is not on PATH the
   HTTP/engine probes still run; the on-chain A7 path is `NOT_CHECKED`.
2. **Ephemeral engine** — `LOCAL_MODE=true LOCAL_STORE_PATH=.harness/store.db`.
   Throwaway SQLite/JSON. Synthetic agent ids only (`00000000-…`).
3. **Seven probes as code** — `tests/adversarial-harness.test.ts`.
   `PASS` = resisted, `FAIL` = accepted.

| Probe | Attack | Pass means |
|-------|--------|------------|
| A1 | ungrounded event | `g_verified = 0` |
| A2 | fabricated proof | well-formed fake `tx_hash` is not stored as grounded |
| A3 | replay | same evidence grounds once |
| A4 | flood | HTTP score-event cap is finite (60/min) |
| A5 | delta 9990 and 12000 | 12000 is rejected (opportunity bound) and clamped at 9990 |
| A6 | wash with a trivial settlement | `$0.001` does not ground |
| A7 | `giveFeedback` from a non-writer | engine allowlist refuses |

## Isolation

`.harness/isolation.json` after a run. The harness process has no
`SUPABASE_URL`. A query against prod from this process is impossible; that is
the proof, not a watermark we could only read by holding a prod key.

## Fixtures

Every id in this tree is `00000000-0000-4000-8…`. The prod-fixture guard
(`scripts/hooks/prod-fixture-guard.js`) still applies — do not paste live
agent UUIDs or proofs in here.

## C8 / X9

`tests/grounding.test.ts` is C8. `tests/grounding-attacks.test.ts` is X9
(five attacks, including a real-but-unrelated tx and a unique-constraint race).
`npm run harness` runs them too.
