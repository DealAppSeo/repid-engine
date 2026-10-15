---
name: credential-safety
description: >
  Load before ANY change that touches auth, API keys, tokens, secrets, wallets, private keys,
  mnemonics, or credential storage (writing, hashing, comparing, migrating, or serving one).
  CLAUDE_RULES r32 / D-108: one credential, one form, one verifier.
---

# Credential safety (r32: one credential, one form, one verifier)

## Checklist (every item, every time)

- [ ] **At rest: only a hash.** sha256 for random tokens of 128 bits or more; argon2/bcrypt for
      anything a human chose. Never plaintext. Never two forms of one secret (plaintext + hash,
      old hash + new hash).
- [ ] **Entropy before hashing.** A sha256 of a guessable value (timestamp + a few random chars) is
      the plaintext with one extra step. Generate with `crypto.randomBytes(16)` or more.
- [ ] **One verifier per credential type**, constant-time compare (`crypto.timingSafeEqual` on
      equal-length buffers, or compare sha256 digests). Never `===` / `!==` on a secret.
- [ ] **Ambiguous state refuses and alerts** (two forms, unknown shape). It never picks one.
- [ ] **Migrations that hash remove the plaintext in the same statement.**
- [ ] **Exposure = burned.** Anything ever readable (anon-readable column, log, response, repo) is
      revoked or rotated. Hashing it later does not un-expose it.
- [ ] **Old auth paths: delete, don't patch**, once a live query shows nothing uses them.
- [ ] **Never serve a credential.** Rows go out through an allowlist (`publicConstitution`), not a
      denylist.
- [ ] **No credentials in commands, files, or scratch inside the repo.** Scratch goes to %TEMP%.

## Where the layers live

| Layer | Where |
|---|---|
| The one agent-key verifier | `src/auth/api-keys.ts` (`validateAgentApiKey`; keys hashed in `agent_api_keys.key_hash`) |
| Public constitution allowlist | `src/auth/api-keys.ts` (`publicConstitution`) |
| Architecture test (CI `test` job) | `tests/credential-safety-architecture.test.ts`: fails if any other `src/` file reads `constitution.api_key`, `->>'api_key'`, `privateId`, or compares a secret with `===`. Allowlist is per snippet; DEBT entries are paid by deleting them |
| Retired legacy token | `tests/legacy-token-retired.test.ts`: `constitution.api_key` no longer authenticates anywhere |
| DB CHECK constraint | `repid_agents_no_plaintext_credentials` (review SQL: `E:\dev\reports\2026-10-15\D108_CREDENTIAL_CHECK_CONSTRAINT.sql`) |
| Rule text | `E:\dev\living-docs\CLAUDE_RULES.md` rule 32; decision D-108 |

## Known debt (allowlisted in the architecture test, fix in a follow-up)

`===` compares on operator/admin keys: `src/middleware/auth.ts` and `src/routes/route.ts`
(REPID_API_KEYS parsed inline), `src/routes/admin-caps.ts` and `src/routes/admin-flags.ts`
(`x-admin-key`). `matchEnvOperatorKey` in the verifier also uses `===`. Route all of them through
one constant-time check in `src/auth/api-keys.ts`, then delete their allowlist entries.

## Before you claim it is done

Run `npx tsc --noEmit` and the architecture test. A live claim ("0 rows hold plaintext") needs a
SELECT against prod, tagged [V], not a report.
