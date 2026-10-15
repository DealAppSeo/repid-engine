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
| The one secret compare | `src/auth/api-keys.ts` (`secretEquals`: sha256 both sides, `timingSafeEqual`; false on non-string/empty). `matchEnvOperatorKey` (REPID_API_KEYS) and the `x-admin-key` guards call it |
| Public constitution allowlist | `src/auth/api-keys.ts` (`publicConstitution`) |
| Architecture test (CI `test` job) | `tests/credential-safety-architecture.test.ts`: fails if any other `src/` file reads `constitution.api_key`, `->>'api_key'`, `privateId`, or compares a secret with `===`. Allowlist is per snippet; DEBT entries are paid by deleting them |
| Retired legacy token | `tests/legacy-token-retired.test.ts`: `constitution.api_key` no longer authenticates anywhere |
| DB CHECK constraint | `repid_agents_no_plaintext_credentials` (review SQL: `E:\dev\reports\2026-10-15\D108_CREDENTIAL_CHECK_CONSTRAINT.sql`) |
| Rule text | `E:\dev\living-docs\CLAUDE_RULES.md` rule 32; decision D-108 |

## Known debt

None allowlisted. The four operator/admin `===` compares #1408 listed now go through `secretEquals`.
The architecture test's grep only sees `===`/`!==` on a secret-named operand, so it does not catch
`keys.includes(presented)` in `src/middleware/env-api-key.ts` (the rate-limit bypass check). That
compare is not constant-time yet.

## Before you claim it is done

Run `npx tsc --noEmit` and the architecture test. A live claim ("0 rows hold plaintext") needs a
SELECT against prod, tagged [V], not a report.
