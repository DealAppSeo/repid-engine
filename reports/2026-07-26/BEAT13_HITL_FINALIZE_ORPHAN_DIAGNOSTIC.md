# Beat 13 — HITL finalization loop is ORPHANED (root cause of validation_queue stranding)
**Date:** 2026-07-26 · **Type:** verify-first diagnostic (read-only; code + live SQL vs `qnnpjhlxljtqyigedwkb`) · **Author:** autonomous build-loop (Claude, apex)
**Motivated by:** Beat 12 follow-up (a) — "`resolveRequest()` never writes `validation_queue`… a latent `resolved`-stranding sibling of the bug #194 fixes." This beat confirms it at the code level and finds it is **broader** than flagged.

---

## TL;DR
The validation-queue HITL **finalization** loop (`pollResolvedHitlEntries → finalizeHitlResolvedEntry`, default-ON in `validation-queue-worker.ts`) is **orphaned**: it only acts on `validation_queue` rows whose `metadata.hitl_resolved === 'true'`, but **NO code path anywhere sets that flag.** Therefore a `validation_queue` row escalated to HITL is **never** transitioned out of `processing` by the normal machinery — not on human approve/deny, not on timeout. That is the real root cause of the 13+ stranded `processing` rows; PR #194 (Beat 12) is the *downstream reconciler* that closes them, not the root fix.

Two independent defects compound it:
1. **Missing write-back:** neither `hitlService.resolveRequest()`/`expireStaleRequests()` nor the Telegram callback handler writes `metadata.hitl_resolved`/`hitl_resolution` onto the linked `validation_queue` row.
2. **Two disconnected HITL tables:** the canonical `validation_queue` path links to **`hitl_requests`** (24 rows), but the actual human decision surface — the Telegram approve/deny handler — writes **`trinity_hitl_requests`** (259k legacy rows) + `trinity_hitl_decisions`. A human decision made in Telegram never reaches the canonical `validation_queue` at all.

**Nothing shipped this beat** (7 loop PRs #188–#194 already await Sean; per the standing "don't stack an 8th PR — prefer a diagnostic" guidance). Fix designs are teed up below, shadow-first, for the next beat once the queue moves.

---

## Evidence (all [V])

### 1. The finalize loop's trigger flag is never written
`src/services/validation-queue-worker.ts`:
- L241–247 `pollResolvedHitlEntries()` selects `validation_queue` rows `status IN ('processing','completed')` **AND `metadata->>hitl_resolved = 'true'` AND `metadata->>hitl_finalized IS NULL`**.
- L263–300 `finalizeHitlResolvedEntry()` reads `entry.metadata.hitl_resolution` (L273), applies RepID deltas (`applyValidationDeltas`, L276), writes the audit chain, updates task status, and finally sets `validation_queue.status='completed'` + `metadata.hitl_finalized=true` (L287–297).

Grep for any **writer** of that flag across `src/**` (`hitl_resolved|hitl_resolution|hitl_resolver`):
- `validation-queue-worker.ts:245,273,329,330` — **reads only** (the poll filter + finalize reads).
- `hitl-reconciliation.ts:12` — a comment.
- `database.types.ts:23241-23282` — `hitl_resolved_at/by` are generated-type columns on an **unrelated** table, not a `validation_queue` write.
→ **Zero writers.** The finalize loop can never fire. `[V]`

### 2. The resolve/expire service writes only `hitl_requests`
`src/services/hitl-service.ts`:
- `resolveRequest()` L127–162 → `UPDATE hitl_requests SET status='resolved'…` + `append_hal_audit_chain`. **No `validation_queue` write.** The caller comment `hitl-expiration-job.ts:43` ("Update validation queue to sync resolution") is **false**.
- `expireStaleRequests()` L164–180 → `UPDATE hitl_requests SET status='expired'…`. **No `validation_queue` write.** `[V]`

### 3. The human decision surface writes a *different* table
`src/services/hitl-callback-handler.ts` (Telegram approve/deny, `handleHitlCallback`):
- L180–195 `UPDATE trinity_hitl_requests SET status='approved'|'denied'…` and L227–237 `INSERT trinity_hitl_decisions`.
- **Never** touches `validation_queue` and **never** touches `hitl_requests` (the table `validation_queue.metadata.hitl_request_id` actually points to). `[V]`
- `hitl-expiry-sweeper.ts` (default-OFF) likewise operates on `trinity_hitl_requests`. `[V]`

### 4. Escalation set the row to `processing` and linked `hitl_requests`
`validation-queue-worker.ts:116–140` — on `escalated`, `hitlService.createRequest()` inserts into **`hitl_requests`** with `validation_queue_id=claim.id`, and the worker sets `validation_queue.status='processing'` + `metadata.hitl_request_id=<hitl_requests.id>`. So the canonical link is `validation_queue.metadata.hitl_request_id → hitl_requests.id`. `[V]`

### 5. Live state (read-only SQL vs `qnnpjhlxljtqyigedwkb`, 2026-07-26)
`validation_queue` rows in `processing`, joined by `metadata.hitl_request_id → hitl_requests`:
| linked hitl_requests.status | n | resolved_at NULL | oldest vq |
|---|---|---|---|
| expired | 13 | 13 | 2026-05-16 |
| pending | 1 | 1 | 2026-07-25 (task 434999, expires 2026-08-01) |

→ **0 rows linked to a `resolved` hitl_request today.** The `resolved`-path stranding Beat 12 flagged is genuinely **latent** (not manifesting) — consistent with §1–3: the finalize loop that would produce/clear a `resolved` row can't fire, and few requests reach `resolved` on the canonical table anyway. `[V]`

---

## Why this matters (and why it's not urgent)
- **Correctness of the moat's HITL leg:** the design intends a human (or timeout) HITL decision to flow back into `validation_queue`, apply RepID deltas, and finalize. Today that return path is severed at two points (§1, §3). The engine still *escalates* to HITL correctly; it just never *finalizes*.
- **#194 interaction:** #194 reconciles `expired`/`cancelled`-linked rows → `skipped` (no RepID delta — correct, the human window lapsed). It deliberately leaves `resolved` "for the worker." Given §1, the worker can't finalize a `resolved` row either — so if a `resolved` stranding ever appeared, #194 would (correctly) not touch it and it would strand. **0 such rows today**, so #194 fully covers the live problem; the gap is latent. Documented so it isn't mistaken for complete coverage.
- **Not urgent:** the 13 stranded rows are 100% internal-swarm churn, 0 external deliverables owed (Beat 11 [V]); the 1 genuine pending is a trivial internal task. No user is waiting.

---

## Fix designs (teed up, NOT shipped — shadow-first, one per concern)
1. **Write-back on resolve/expire (root fix for §1+§2).** In `hitlService.resolveRequest()` (and the timeout path), after updating `hitl_requests`, set the linked `validation_queue` row's `metadata.hitl_resolved='true'` + `metadata.hitl_resolution=<mapped>` + `hitl_resolved_at/resolver` so the existing `finalizeHitlResolvedEntry` loop fires. Behind a flag, shadow-first — it re-activates a **RepID-delta-applying** path, so it needs the same discipline as scoring gates (measure which rows would finalize + what deltas before enforce). This is the correct long-term fix; #194 remains the safety net for the human-lapsed (`expired`) case where NO delta should apply.
2. **Reconcile the two-table disconnect (§3).** Decide the canonical HITL request table. The Telegram human-decision surface writes `trinity_hitl_requests`; the validation_queue path reads `hitl_requests`. Either (a) point the Telegram handler at `hitl_requests` for validation-queue-linked requests, or (b) add a bridge that mirrors a `trinity_hitl_requests` decision onto the linked `hitl_requests` + `validation_queue`. Vision-adjacent (which table is canonical) — flag for Sean, don't decide autonomously.
3. **Fix the false comment** `hitl-expiration-job.ts:43` regardless (cheap, correctness-of-record).

**Recommendation:** do NOT ship any of these as an 8th stacked PR now. Fold #1 (root fix, shadow-first) as the natural successor to #194 **once Sean starts merging the queue**; raise #2 as a small vision question; #3 rides along with #1.

---
*Verify-first. Read-only. No prod mutation. The finalize loop is orphaned; #194 is the reconciler that makes the symptom safe; the root fix is a shadow-first write-back gated like a scoring change.*
