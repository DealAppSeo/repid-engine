# repid-engine API — TrustChat surface (S-SPINE)

Public endpoints for the TrustChat viral surface + security page. Base path `/api/v1`. All public
endpoints below mount **before** `authMiddleware` (no API key required) except `/referrals/stats`.
`hal_score` is a RISK score in `[0,1]` (HIGH = likely hallucination); the leaderboard ranks by
LOWEST avg risk.

| Method | Path | Auth | Body / Query | Success | Notes |
|---|---|---|---|---|---|
| GET | `/leaderboard` | none | — | 200 | provider trust ranking; 5-min cache; `integrity` = audit-chain status |
| GET | `/leaderboard/:provider` | none | — | 200 / 404 | per-provider detail + recent 10 + 7-day trend |
| POST | `/comparison/vote` | none | `{session_id_left, session_id_right, winner: left\|right\|tie, prompt?}` | 201 / 400 | stores into `comparison_votes` |
| PATCH | `/session/:sessionId/rate` | none | `{rating?: 1-5, rating_feedback?, hal_agreement?}` | 200 / 400 / 404 | updates `trustchat_sessions` rating cols |
| GET | `/providers` | none | — | 200 | provider list; `available` = API key configured |
| POST | `/subscribe` | none (5/min/IP) | `{email, source?, ref_code?}` | 201 / 200 / 400 / 409 | `email_subscribers`; 200 = resubscribe, 409 = active dup |
| GET | `/unsubscribe` | none | `?token=<uuid>` | 200 / 400 / 404 | CAN-SPAM/GDPR; marks `unsubscribed_at` |
| POST | `/track` | none | `{ref_code, source_type?, user_agent?, session_id?}` | 201 / 400 | `referral_tracking`; `source_type ∈ {qr_code,share_link,email,social,direct}` |
| GET | `/referrals/stats` | **API key** | — | 200 | aggregate dashboard (mounted after authMiddleware) |
| GET | `/security/status` | none | — | 200 | live RLS coverage + audit-chain integrity + posture |

## Shapes (abridged)

**GET /leaderboard**
```json
{
  "providers": [{
    "name": "claude", "display_name": "Claude (Anthropic)", "company": "Anthropic",
    "model": "claude-3-5-sonnet", "avg_score": 0.18, "total_evaluations": 7,
    "avg_signals": { "harm_probability": 0.05, "epistemic_uncertainty": 0.12, "evidence_quality": 0.85,
                     "scope_appropriateness": 0.92, "certainty_at_claim": 0.88 },
    "hallucination_rate": 0.0, "veto_rate": 0.0, "verified": false, "last_evaluation": "2026-06-02T00:05:11Z"
  }],
  "total_evaluations": 21, "last_updated": "...", "integrity": "VALID|CHAIN_BREAK|UNVERIFIED"
}
```

**GET /security/status** — `rls_status` (live `pg_class` coverage), `audit_trail.hash_chain_status`
(live server-side recompute over `hal_classifications` + `tool_call_log`), `authentication`
(`anon_write_blocked` live; in-flight code fixes reported by merge state, not asserted as deployed),
`tests` (last local gate, with `as_of`).

## Implementation notes

- All writes use the **service-role** db client (RLS: service_role full; anon/authenticated denied).
- New tables: `comparison_votes`, `email_subscribers`, `referral_tracking` — see
  `scripts/migrations/S-SPINE_tables.sql` (RLS-enabled; rollback line included).
- `/security/status` + leaderboard `integrity` use `src/services/audit/verify-chain-db.ts`, which runs
  the chain recompute via the direct-pg pooler (bypasses RLS, unlike the `exec_sql` RPC) and degrades
  to `UNVERIFIED` when `DATABASE_URL` is unset.
- The global SQL-keyword body sanitizer rejects POST bodies containing `SELECT `, `DROP `, `--`, `;`
  etc. — `prompt`/`ref_code`/`email` payloads must avoid those tokens (broad, pre-existing behavior).
