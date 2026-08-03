# Who writes RepID — the complete map, and what D-054 actually said

**Date:** 2026-08-03 · **Author:** CC · **All findings verified against prod.**

---

## 1. D-054 is a collision

Two different decisions carry the number.

| where | D-054 means |
|---|---|
| `~/.claude/CLAUDE.md` + THE_ONE | the **Claude+Grok decision protocol** (default-proceed litmus test) |
| `DECISIONS.md:249` | **"RepID-sync A6 co-sign — ⛔ WITHHELD for live writes (double-count)"** · 2026-05-29 |

The code comment in `agents-external.ts` ("single-applier cutover (D-054)") means the second.
This is the **second** decision-number collision found — Grok's 2026-08-01 audit already flagged
D-095 being used for both TrustMedical and pay-after-delivery. Worth a renumber before a third.

### What the RepID-sync D-054 resolved (DECISIONS.md:251)

> XC shipped the reversible `WRITER_DIRECT_APPLY` flag + seed-then-flip runbook. SQL proof
> confirms: stale watermark would re-add 48h of deltas (mel −31,200, shofet −31,090 →
> **re-crater**); seeded-now watermark re-adds 0 for all.
> **CONDITION:** Sean MUST seed the watermark (`UPDATE repid_agents SET
> last_reputation_written_at = now()`) at the cutover instant BEFORE flipping
> `REPIDSYNC_APPLY=true`. Instant rollback via `WRITER_DIRECT_APPLY=true`.

So the intended end state is **one applier**: the aggregator applies, and the direct writers become
insert-event-only via `WRITER_DIRECT_APPLY=false`. **That cutover has not happened** —
`WRITER_DIRECT_APPLY` defaults to true and is unset in prod.

---

## 2. The actor nobody mentioned: a live DB trigger

`trg_apply_repid_score_event` — **BEFORE INSERT on `repid_score_events`, ENABLED**.

```sql
IF NEW.repid_delta_applied IS NOT NULL THEN
  RETURN NEW;                          -- ← the entire double-count guard
END IF;
v_delta := COALESCE(NEW.repid_delta_calculated, NEW.delta, 0);
...
UPDATE repid_agents SET current_repid = COALESCE(v_before,0) + v_delta ...
NEW.repid_before := v_before; NEW.repid_after := v_after;
NEW.repid_delta_applied := v_delta;
INSERT INTO agent_repid_history (...);   -- and the history mirror
```

**The database is the default applier.** It applies the delta, stamps the audit fields, and mirrors
to `agent_repid_history` — *unless* the inserting code pre-sets `repid_delta_applied`, in which case
it backs off entirely.

That single `IF` is the whole safety mechanism, it is **per-writer**, and it is not enforced anywhere
in the application. Nothing stops a new writer from omitting it.

---

## 3. The writer map

Eleven modules insert into `repid_score_events`. Column 2 is the only thing preventing a
double-apply.

| writer | sets `repid_delta_applied`? | trigger | also writes `current_repid`? | verdict |
|---|---|---|---|---|
| `scoring/pipeline.ts` `runScoreEvent` | **YES** | backs off | yes | **single apply ✓** |
| `scoring/pipeline.ts` `applyValidationEvent` | **YES** | backs off | yes | **single apply ✓** |
| `services/repid-earning.ts` | **YES** | backs off | yes | **single apply ✓** |
| `routes/agents-external.ts` (PREDICTION_RESOLVE) | **no** | **applies** | yes (abs, flag-gated) | ⚠ agrees by luck — §4 |
| `routes/agents.ts` | **no** | **applies** | yes | ⚠ unaudited |
| `routes/challenge.ts` | **no** | **applies** | yes | ⚠ unaudited |
| `services/substance-gate-writer.ts` | **no** | **applies** | yes | ⚠ unaudited |
| `routes/v1/red-team.ts` | **no** | **applies** | yes | ⚠ unaudited |
| `services/redteam-adjudication.ts` | **no** | **applies** | yes | ⚠ unaudited |
| `services/t12-e2e-proof.ts` | **no** | **applies** | yes | ⚠ unaudited |
| `routes/mirror-test.ts` | **no** | **applies** | no | safe (event-only) |
| `engine/repid-update.ts` (documented, **dormant**) | no | would apply | yes | dormant |

**Only 3 of 11 writers hold the guard.** Seven both let the trigger apply *and* write
`current_repid` themselves.

---

## 4. Why there is no live double-count — and why that is not reassuring

Measured on the PREDICTION_RESOLVE event I generated at 03:51 UTC:

```
repid_before 1268 · delta −9 · repid_after 1259 · repid_delta_applied −9
current_repid now = 1259          (double-apply would have given 1250)
```

The trigger applied `v_before + v_delta` (relative). The route then wrote its own computed
`current_repid` (absolute). **Both arrived at 1259, so the second write was a no-op.**

They agree because both derive from the same `before` and the same `delta`. That is coincidence of
arithmetic, not a mechanism. The moment they disagree — a concurrent event between the two writes,
or any app-side adjustment the trigger does not know about — the absolute write silently wins and
`repid_after` on the audit row becomes a lie.

**This is exactly the failure the RepID-sync D-054 was withheld over.** It is currently benign, and
it is load-bearing on luck.

---

## 5. What this means for the decay work I just shipped (#315)

In **shadow** — no interaction. Decay applies nothing, so nothing to reconcile. Safe as shipped.

In **enforce** — a real problem, and this is the reason not to flip it yet:

`pipeline.ts` sets `repid_delta_applied = effectiveDeltaApplied` — **the delta only, not the decay.**
It then writes `current_repid = decayBase + delta`. So:

```
repid_before        = 1268   (pre-decay)
repid_delta_applied = −9     (delta only)
repid_after         = 1234   (decay −25, then −9)
```

`repid_after − repid_before ≠ repid_delta_applied`. **The audit row would not reconcile**, and
`agent_repid_history` would disagree with it too.

That is a defect in my own change that shadow hides. Before enforce, decay needs either to be folded
into `repid_delta_applied`, or recorded as its own ledger line — not silently bundled into the
score.

---

## 6. Recommendation

Ordered by ratio of risk removed to work required.

**1. Make the guard structural instead of per-writer.** The `IF repid_delta_applied IS NOT NULL`
contract is invisible at every call site. One helper — `insertScoreEvent()` — that every writer must
use and that always sets the field, plus a test asserting no raw
`.from('repid_score_events').insert(` survives outside it. This is the fix that stops writer #12
reintroducing the bug.

**2. Audit the seven.** Each needs the same check I did in §4: does its absolute write agree with
the trigger's relative one? Cheap per writer, and `redteam-adjudication.ts` /
`t12-e2e-proof.ts` touch `current_repid` in four places each.

**3. Then execute the D-054 cutover properly** — seed the watermark, flip `WRITER_DIRECT_APPLY=false`,
and let one applier own it. Note the SQL proof in DECISIONS.md: **an unseeded watermark re-adds 48h
of deltas and re-craters mel and shofet by ~31,000 points each.** Do not flip without the seed.

**4. Only then reconsider decay enforce**, with §5 fixed.

**Do not renumber D-054 silently** — two documents and at least one code comment point at it. Give
the RepID-sync decision a new number and leave a pointer.

---

*Trigger definition, writer table, and the 1259 reconciliation all read from prod 2026-08-03.*
