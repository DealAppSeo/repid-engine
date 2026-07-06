# HAL cross-fix findings

## FIX CYCLE 1 — CC (2026-07-05)

Blind verifier XC failed **V3 (real)**: `families_unmapped` never populated on the default
build→score path (structured field was theater; only the per-lookup `console.warn` fired).
GA fuzz then found a companion never-throws hole (600/14310 throws, all non-string inputs).
Both fixed in this cycle. `tsc --noEmit` exit 0. HAL family/quorum/fact-check suites: 48/48 green.

### V3 root cause + fix (families_unmapped populates + propagates)

- **Root cause:** `src/hal/fact-check.ts:467` did `p.family ?? familyOfResolved(p.model, flagUnmapped)`.
  The default builder (`buildFactCheckProvidersWith:796`) always pre-tags `.family`, so the `??`
  short-circuited, `flagUnmapped` never ran, `familiesUnmapped` stayed `[]`, and the field was
  omitted at `:703`.
- **Fix (collect on every path)** — `src/hal/fact-check.ts:464-476`: resolve EVERY provider's
  model through `familyOfResolved(p.model, flagUnmapped)` unconditionally; the pre-tagged
  `.family` is still honored for classification, but the unmapped set is now authoritative
  regardless of entry path (default builder or explicit providers).
- **Propagation (was dropped downstream):**
  - `src/hal/service.ts:107-109` — surface `fc.families_unmapped` into `signals` (conditional,
    matching the `quorum_note` pattern).
  - `src/services/validation-repid-delta.ts:320-322` — carry `fc.families_unmapped` into the
    strictness-2 `hal_signals` so it reaches score-event metadata (not just logs).

### Fuzz-hardening (never-throws made TOTAL) — GA fuzz follow-up

`familyOfResolved`'s catch called `familyOf`/`resolveFamily`, which did `(model||'').toLowerCase()`
— throws on a TRUTHY non-string (number/object/Symbol), escaping the catch. Coerced with
`String(model ?? '')` (Symbol-safe) at every reachable site:

- `src/hal/fact-check.ts:71` — `familyOf`
- `src/decisioning/family-registry.ts:217` — `resolveFamily`
- `src/decisioning/family-registry.ts:129` — `matchedFamilies`
- `src/hal/fact-check.ts:125` — no-collector diagnostic log (`"${String(model)}"`; raw template
  interpolation throws on a Symbol)
- `src/decisioning/family-registry.ts:200` — `UnmappedFamilyError` ctor message (same Symbol hazard)

### New tests — `tests/hal-registry-family.test.ts`

- **`factCheck — surfaces families_unmapped on the DEFAULT build→score path (V3)`** (2 tests):
  mocks `global.fetch` (deterministic TRUE verdict so `providers_used > 0` → real return path),
  calls `factCheck` with an unmapped model (`some-brand-new-model-v9`), asserts
  `result.families_unmapped` is defined AND contains that model AND excludes the registry-known
  `llama-3.1-8b-instant`; plus the negative case (all-known → field absent). Proves the field
  surfaces, not just the log.
- **`familyOfResolved — never-throws is TOTAL (fuzz-hardening)`** (7 cases via `it.each`):
  number / object / array / boolean / Symbol / null / undefined — each returns a non-empty
  string family and does NOT throw. (The Symbol case caught the two remaining template-literal
  throw sites above during this cycle.)

### Scope (RULE-3)

Only V3 + the GA fuzz follow-up. Untouched: scoring math, quorum thresholds, the provider set,
and the inherited `src/hal/config.ts` / `buildFactCheckProvidersWith` (XC's V5 was a verified
false positive — pre-existing in base). Not deployed.
