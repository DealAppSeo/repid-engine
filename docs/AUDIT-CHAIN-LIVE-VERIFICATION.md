# AUDIT-CHAIN-LIVE-VERIFICATION — 2026-04-25

End-to-end verification that the hash-chained audit trail works on live
Trinity Supabase after merging PR A + PR B to `main`.

## Environment

- Main HEAD: `3e8ac94` — feat(hal): wire hal_production_events writes into hal_audit_chain
- Supabase project: `qnnpjhlxljtqyigedwkb`
- Local engine: `PORT=3099 node dist/index.js` (built from main via `tsc`)
- Performed: 2026-04-25 02:00 UTC

## Steps

1. `DELETE FROM hal_audit_chain;` (Supabase MCP) — left the table empty.
2. Booted local engine on port 3099.
3. Confirmed public route reachable: `GET /api/v1/audit/verify` returned
   `{"valid":true,"total_entries":0,"last_id":null}` — chain empty, clean.
4. Ran `scripts/verify-audit-chain-live.js` — fires one HAL event through
   `logHalProductionEvent` (the wired write path) with
   `prompt_hash=prompt_7dcd32db`, then HTTP-GETs the verify endpoint.
5. Cross-checked DB state via Supabase MCP.

## Results

### HTTP

```
GET http://localhost:3099/api/v1/audit/verify
→ 200 {"valid":true,"total_entries":1,"last_id":96}
```

### DB row

```
id:                  96
source_table:        hal_production_events
source_id:           b8394c64-0df6-44b8-8932-c96182c66420  (uuid of the hal_production_events row)
prompt_hash:         prompt_7dcd32db                       (matches the fired event)
agent_domain:        __live_verify__                       (test marker)
previous_entry_hash: null                                  (genesis row — chain was empty)
current_entry_hash:  d70c4940ef33c47ef9fee0f98e2985df1b2f7c159f50cbc1dd86b017b82a4b60
created_at:          2026-04-25 02:00:16.37462+00
```

### What this confirms

- `logHalProductionEvent` successfully inserts into `hal_production_events`
  and captures the UUID.
- The UUID flows to `appendToAuditChain` as `source_id`.
- The RPC takes the advisory lock, reads the (null) previous tail, computes
  the SHA256 over `'' || canonical_json || 'hal_production_events' || uuid`,
  and inserts the chain row with `previous_entry_hash=null`.
- `/api/v1/audit/verify` walks the chain, recomputes the hash, finds a
  match, and returns `valid:true`.
- The route is reachable without auth (the mount is ahead of
  `authMiddleware` in `src/index.ts`).

## Notes

- `id` starts at 96, not 1, because `bigserial` continues after earlier
  `DELETE`s from test runs and smoke-checks. That is expected — the chain
  is logically empty at the start of this verification; the id sequence is
  orthogonal to the chain's semantic length.
- Pre-existing test suite failure (`runHAEEEpoch` firing at module load and
  leaking a timer past test end) is unrelated to the audit chain and was
  left alone per CLAUDE-RULE-3.

## Known follow-ups (not in this sprint's scope)

- Running `tests/auditChain.test.ts` and `tests/haleventWiring.test.ts` in
  parallel jest workers races because both truncate the shared
  `hal_audit_chain` table. Fix: add `--runInBand` to the integration test
  command, or scope the truncation to test-specific `source_table` values.
  In production the advisory lock in the RPC serializes writers correctly.
