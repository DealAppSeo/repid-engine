# Beat 32 — POSTCARD commitment sha256 → Poseidon2 (backlog 4.0-e), shadow-first

**Date:** 2026-07-27 · **Branch:** `feat/cc-2026-07-27-poseidon2-commitment-4.0-e` (off `origin/main` `a1b6e7f`)
**Scope:** `src/zkp/commitment.ts` + `tests/zkp-commitment-poseidon2.test.ts` + this report. No call-site change, no DDL, no live flag.

---

## 1. Objective

ZKP_ARCHITECTURE_INVARIANTS **Invariant 1** requires commitments to be Poseidon2 over a
Plonky3-native field so they are aggregation-ready. The POSTCARD path has been sha256 since
2026-05-29; the module's own header has carried a "HASH-TIMING FLAG — SURFACE, DO NOT DECIDE"
box since then. Backlog **4.0-e** is the migration, shadow-first.

The prerequisite landed in Beats 16–18: `poseidon2-leaf.ts` (`poseidon2LeafHash`) is a verbatim
port of Plonky3's `PaddingFreeSponge<16,8,8>` and is **bit-exact against an independent Rust
oracle**. So 4.0-e introduces **no new hash surface** — it composes an already-parity-gated
primitive over the existing preimage.

## 2. What shipped

Both families now live in `commitment.ts` over **one shared preimage**:

| export | what it is |
|---|---|
| `postcardCommitmentPreimage` | the frozen `\|`-joined preimage — **shared** |
| `postcardCommitmentSha256` | today's live construction, unchanged |
| `postcardCommitmentPoseidon2` | the same preimage through the parity-gated sponge |
| `resolveCommitmentMode` | `POSTCARD_COMMITMENT_MODE` → `sha256` (default) \| `shadow` |
| `buildPostcardCommitment` | **unchanged name/signature/return** → zero call-site change |

Sharing the preimage is the point. A "migration" where the two families hash different bytes is
not a migration — it is a second, unrelated statement. Five per-field tests pin that any change to
`agentId`/`score`/`tier`/`nonce`/`proverCommitment` moves **both** digests.

`buildPostcardCommitment` returns the **sha256** value in *every* supported mode, so persistence is
byte-identical to today. `shadow` adds sampled log lines and nothing else.

## 3. The finding: there is deliberately NO persist mode, and here is the measured reason

`repid_zkp_proofs` has `leaf_scheme` for the Merkle leaf but **no column recording which hash family
produced `zk_commitment`** [V, `information_schema.columns`, 16 columns enumerated]. Both families
emit the identical shape: `0x` + 64 hex.

The tempting discriminator is canonicality — a Poseidon2 digest is 8 big-endian u32 limbs each
`< p` (BabyBear `p = 2013265921`), and a sha256 digest usually is not. **"Usually" is not "always",
and the gap is measurable:**

```
P(all 8 limbs < p) = (p / 2^32)^8 = (0.468750000232)^8 = 0.0023309…  = 0.2331%
```

Measured on the live table [V sql:2026-07-27, project `qnnpjhlxljtqyigedwkb`]:

| quantity | value |
|---|---|
| `repid_zkp_proofs` rows | 78,783 |
| well-formed `0x`+64-hex commitments | 78,783 (100%) |
| distinct commitments | 56,622 |
| **distinct commitments already limb-canonical** | **131** |
| predicted (56,622 × 0.0023309) | **131.98** |
| rows affected | 135 |

Observed 131 against a predicted 131.98. So an **untagged cutover would leave ~131 historical
sha256 rows permanently indistinguishable from post-cutover Poseidon2 rows**, with no second signal
to break the tie. That is a one-way loss of provenance in the table the EAS anchor set is derived
from — precisely the class of thing this loop keeps finding after the fact.

Therefore the mode enum is `sha256 | shadow` **only**. `poseidon2`, `on`, `enforce`, `true`, `1`,
`enabled` all resolve to `sha256` **and warn once** — an operator who tried to cut over is told why
nothing happened rather than assuming it worked. Fail-safe, not fail-open; `shadwo` and `''`
resolve to `sha256` silently.

**The cutover is one small change away and needs no DDL:** write `commitment_scheme` into the
existing `statement` jsonb (`'sha256-v1'` / `'poseidon2-babybear-sponge-v1'`, both already exported
as constants). That change touches `proof-drain-service.ts`, which open PR **#201** also edits in
the adjacent hunk — so it is deliberately deferred rather than shipped into a conflict.

## 4. A second, inherited weakness — documented, pinned, not unilaterally "fixed"

The preimage is a `|`-join, so a component containing `|` re-splits ambiguously:
`{agentId:'x|1', score:2}` and `{agentId:'x', score:'1|2'}` produce the **identical** preimage and
therefore the identical commitment in **both** families (test asserts all three equalities).

Not exploitable today: all five components are engine-controlled (`agentId` a DB uuid, `score` a
number, `tier` a constrained enum, `nonce` engine hex, `proverCommitment` prover hex) and none can
contain `|`. It is pinned by a test so that adding a free-text component becomes a visible failure.

It is **not** fixed here on purpose: changing only sha256 invalidates every historical commitment;
changing only Poseidon2 destroys the shared-preimage property this whole beat rests on. It must
land in both families in one change, as its own decision.

## 5. Verification

- **[V] Golden vectors produced OUTSIDE this module** — `printf '%s' 'agent-1|1234|ESTABLISHED|0xdeadbeef|0xabc' | sha256sum`.
  The "unchanged persistence" claim is therefore not self-referential.
- **[V] The Poseidon2 claim is a composition assertion, not a re-assertion of cryptography** —
  the test asserts `postcardCommitmentPoseidon2(x) === poseidon2LeafHash(preimage(x))`; the hash
  itself is gated against the Rust oracle in `tests/poseidon2-leaf.test.ts`.
- **[V] 96/96 across 5 zkp suites** (`zkp-commitment-poseidon2` 38 new, `zkp-commitment-nonce` 5
  pre-existing and untouched, `poseidon2-leaf`, `poseidon2-babybear`, `poseidon2-hash2`).
  `npx tsc --noEmit` clean.
- **[V] Four mutations, each grepped back to confirm it LANDED before its result was trusted**
  (a silent no-op substitution reading as a pass has burned this loop three times — Beats 27, 30, 31):

| mutation | tests killed |
|---|---|
| shadow persists the Poseidon2 value | 4 |
| persist-like modes resolve to `shadow` | 8 |
| preimage join `\|` → `:` | 5 |
| log every call (drop sampling) | 1 |

  Clean revert to 43/43 after each; `grep -c MUT` = 0 in the shipped file.
- **[V] Shadow logging is bounded** — first 20 then every 500th; 10,000 shadow calls emit exactly
  40 lines, so a 40k-row drain restart cannot flood the log.
- **[V] A shadow failure cannot break a proof write** — the Poseidon2 computation is wrapped; a
  lone-surrogate `agentId` (unencodable UTF-8) throws, is caught, logs `poseidon2 FAILED`, and the
  sha256 value still returns. The test asserts the *failure marker* and the *absence* of a claimed
  candidate, so it cannot be satisfied by the happy path.

## 6. What this does NOT claim

- It does **not** claim any Poseidon2 commitment has been persisted. Zero rows change.
- It does **not** claim the deployed prover emits Poseidon2 anything — `poseidon2_leaf` remains
  non-null on 0 of 78,783 rows; that hole is #201's (4.2), not this one's.
- It does **not** run in shadow anywhere. Shadow is opt-in via an env var Sean sets.

## 7. Next

1. Merge → set `POSTCARD_COMMITMENT_MODE=shadow` on the engine, read a sample of log lines.
2. Add `statement.commitment_scheme` (no DDL) — after #201 lands, to avoid an adjacent-hunk conflict.
3. Then, and only then, the persist mode.
