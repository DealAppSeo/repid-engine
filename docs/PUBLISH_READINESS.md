# HAL Library — npm Publish Readiness (Wave 6 Phase 3)

**Date:** 2026-05-05
**Branch:** `feat/embedding-provider-swap-2026-05-04` at tip `5d5a730`
**Target package name (proposed):** `@hyperdag/hal-core`
**Status:** **NOT publish-ready as-is.** Library is functionally complete; packaging requires extraction work documented below. Estimated effort: half-day.

---

## Current state

The HAL library lives at `repid-engine/src/hal/lib/` inside a private application repository. `npm pack --dry-run` against the current `package.json` produces a tarball named `repid-engine-1.0.0.tgz` containing **289 files / 1.2 MB unpacked / 322.9 kB packed** — i.e., the entire `repid-engine` codebase, not a focused HAL library. This is expected: the package.json describes the application, not the embedded library.

External consumption today (e.g., Gemini's `hyperdag-bench` runner) goes through runtime `require(path.resolve(...))` against the absolute filesystem path:

```ts
// hyperdag-bench/src/hal-client.ts:88
const halPath = path.resolve(__dirname, '../../repid-engine/src/hal/lib/index.ts');
const halLib = require(halPath);
```

This works for a local sibling-checkout setup but is not a portable npm dependency.

---

## What's needed for `@hyperdag/hal-core` publish

### 1. Extract to a standalone package directory

Create `packages/hal-core/` (monorepo style, or extract to its own repo). Move:

- `src/hal/lib/**` → `packages/hal-core/src/`
- `tests/hal-regression.test.ts` → `packages/hal-core/tests/`
- `tests/hal-lib-cross-llm.test.ts` → `packages/hal-core/tests/`
- `tests/hal-semantic-similarity.test.ts` → `packages/hal-core/tests/`
- `tests/hal-claim-comparison.test.ts` → `packages/hal-core/tests/`
- `tests/hal-comma-zones.test.ts` → `packages/hal-core/tests/`
- `tests/hal-tampering.test.ts` → `packages/hal-core/tests/`
- `tests/fixtures/hal-regression.json` → `packages/hal-core/tests/fixtures/`
- `docs/HAL_LIBRARY_API.md`, `docs/HAL_TAMPERING_DETECTION.md`, `docs/HAL_CANONICAL_v1.md` → `packages/hal-core/docs/`

### 2. Author a focused `package.json`

```jsonc
{
  "name": "@hyperdag/hal-core",
  "version": "0.2.0-alpha.0",
  "description": "Hallucination Auditor Layer — strictness-graded cross-LLM consensus and Pythagorean Comma BFT veto",
  "license": "Apache-2.0",
  "main": "dist/index.js",
  "types": "dist/index.d.ts",
  "files": [
    "dist/",
    "README.md",
    "LICENSE"
  ],
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "test": "jest --config jest.config.js",
    "prepublishOnly": "npm run build && npm test"
  },
  "dependencies": {},
  "peerDependencies": {
    "@xenova/transformers": "^2.17.0"
  },
  "peerDependenciesMeta": {
    "@xenova/transformers": { "optional": true }
  },
  "engines": {
    "node": ">=20.9.0"
  }
}
```

Dependency notes:
- `@xenova/transformers` should be a **peer dependency**, not a hard dep. Callers using OpenAI or Voyage embedders shouldn't pay the 22MB Xenova download. The library imports it dynamically inside `XenovaEmbeddingClient`.
- `@supabase/supabase-js` typing is `unknown` in the public surface (`HALContext.supabase`), so no runtime dep on it.
- `crypto` and `fetch` are Node.js built-ins.
- No other runtime dependencies — the core library is intentionally stand-alone.

### 3. Build target

Compile to `dist/` with:
- `module: commonjs` (matches repid-engine's current TypeScript output)
- `target: es2020`
- `declaration: true` (emit `.d.ts`)
- `sourceMap: true` (debugging in consumers)

### 4. README.md

Brief — under 200 lines. Sections:
- 1-paragraph "what it is"
- Quick-start example with the strictness scale
- Link to `docs/HAL_LIBRARY_API.md` for full API
- License + version statement

### 5. Adjust internal imports

Inside `packages/hal-core/`, `src/services/hal-signals.ts` is NOT included — that's the application-side delegation wrapper that lives in repid-engine. The library's tests should not import from `src/services/`. Verify no leakage.

### 6. CI smoke

Add a CI workflow that:
- Runs `npm test` (must show 410/410)
- Runs `npm pack --dry-run` (verify tarball contents include only `dist/`, `README.md`, `LICENSE`)
- Runs `npx tsc --noEmit` against a stand-alone consumer fixture in `examples/external-consumer/`

### 7. External-caller verification (already exists, can be reused)

`scripts/external-caller-smoke-test.ts` already imports only from `src/hal/lib/index.ts` and verifies the library is consumable without touching `src/services/`. After extraction, this script becomes the package's integration smoke test.

---

## Cross-repo type compatibility check (Wave 6 Phase 3)

Ran `npx tsc --noEmit` in `C:\Users\Cash4\repos\hyperdag-bench` (Gemini's runner repo).

Result:
```
scripts/test-persistence.ts(1,57): error TS2307: Cannot find module '../src/persistence/benchmark-results-writer' or its corresponding type declarations.
scripts/test-persistence.ts(2,33): error TS2305: Module '"../src/persistence/ablation-results-writer"' has no exported member 'AblationRecord'.
exit=0
```

**Both errors are Gemini-side issues, not HAL-library issues.** The HAL imports in `hyperdag-bench/src/hal-client.ts` are runtime `require(path.resolve(...))` (dynamic), so they do not trigger TypeScript checking against the library's exported types. After the npm extraction, Gemini's `hal-client.ts` would switch to:

```ts
import { evaluate, createDefaultEmbeddingClient, type HALContext } from '@hyperdag/hal-core';
```

and the library types would be fully checked at compile time. This is an upgrade, not a regression.

The two `test-persistence.ts` errors above are missing-module issues in Gemini's `scripts/` directory — surfaced for visibility but not in this sprint's scope.

---

## Estimated effort to publish-ready

- **Code mechanical work:** half-day. Move files, write package.json, configure tsconfig, write README, set up the `dist/` build.
- **Decoupling check:** few hours. Confirm no leak from `src/services/` or `repid-engine/`-specific code into the extracted library; the existing `scripts/external-caller-smoke-test.ts` already proves clean extraction empirically.
- **Counsel review gate:** unknown. The library is functionally and architecturally ready; legal review of what's published to public npm vs what stays private is a Sean+counsel decision, not engineering work.
- **CI workflow setup:** 1-2 hours.

**Recommendation:** do not publish until counsel sign-off. The library is internally consumable as-is. The publish step is mechanical once legal clears.

---

## What NOT to do tonight (per Wave 6 Phase 3 fallback A)

This sprint is documentation, not packaging. The actual extraction-to-standalone-package work is deferred. This document captures the gap analysis so the next sprint can execute mechanically.
