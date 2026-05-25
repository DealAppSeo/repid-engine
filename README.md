# repid-engine

Private. Proprietary behavioral reputation scoring engine.
Powers HyperDAG Protocol Trust* product ecosystem.

Not for public distribution.

Docs: trustrepid.dev
Protocol: github.com/DealAppSeo/hyperdag-protocol

## API Documentation

### Environment configuration
- `REPID_API_KEYS`: A comma-separated list of API keys in the format `key:tier` (e.g. `secret123:pro,mykey:free,corp_key:enterprise`).
- `REDIS_URL`: The url for the Redis-backed rate limiter infrastructure.

### Middleware
- **Authentication**: All API requests must be accompanied by an API key injected via `Authorization` (Bearer) or `x-api-key` header.
- **Versioning**: Provide an `X-RepID-Version` header to pin your schema implementation (default is `2026-04-17`).
- **Rate Limits**: 
  - *Free Tier*: 100 requests / hour
  - *Pro Tier*: 10,000 requests / hour
  - *Enterprise*: Unlimited

### Endpoints
- `GET /api/v1/openapi.json`: Retrieve OpenAPI 3.1 specifications.
- `GET /api/v1/health`: Connection and liveness checks.
- `POST /api/v1/prove-repid`: Fetch tiered ZKP verification stubs based on agent `repid_score`.

## HAL Library

`src/hal/lib/` is the extracted, callable Hallucination Auditor Layer used internally and intended for external consumption (Gemini benchmarks, `@hyperdag/protocol`).

The library exposes a 5-level **strictness scale** (1 Fast → 5 Maximum, default 4) controlling which veto layers run: extractor only, cross-LLM with semantic similarity, three-zone Pythagorean Comma band, consensus-vs-claim comparison, tampering detection.

```ts
import { evaluate } from './hal/lib';
const r = await evaluate(claim, output, { domain, certainty, prompt, providers, embeddingClient });
```

See [docs/HAL_LIBRARY_API.md](docs/HAL_LIBRARY_API.md) for the full API and [docs/HAL_TAMPERING_DETECTION.md](docs/HAL_TAMPERING_DETECTION.md) for the level-5 tampering signal spec.

## Sprint Discipline: pre-commit hook

This repo uses a Git pre-commit hook to prevent the HEAD-drift contamination pattern that caused 5 incidents in the May 6-11 sprint window (see `IDEAS_LOG` I-15 + I-17 in living-docs). Multi-agent sprints in shared working trees can silently land commits on the wrong branch; the hook blocks that.

**Install once per clone:**

```bash
npm run install:hooks
```

**At the start of every sprint, set your expected branch:**

```bash
echo "feat/your-sprint-branch-name" > .git/EXPECTED_BRANCH
```

**Behavior:**
- Match → commit proceeds silently.
- Mismatch → commit aborts with a loud error showing `Expected:` vs `Current:` and recovery steps.
- `.git/EXPECTED_BRANCH` missing → warning printed but commit allowed (graceful for old workflows).

**Bypass for emergencies:** `git commit --no-verify`.

The hook source lives in `scripts/git-hooks/pre-commit.sh`; the installer in `scripts/git-hooks/install.sh` copies it into `.git/hooks/pre-commit`. Tests are in `tests/git-hooks.test.ts` (6/6 passing as of CC Sprint 7).
