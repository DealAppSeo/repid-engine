/**
 * The OpenAPI spec must describe the service that actually exists (2026-08-28).
 *
 * WHY. `POST /api/v1/hal/evaluate` was live, public and keyless — and absent from the
 * spec, which documented only `/api/v1/hal/stats`. So the one endpoint that demonstrates
 * what this system is for could not be discovered by any external agent reading the spec.
 * Adding it to the spec is only half the fix. The other half is this: a documented
 * endpoint that does not exist is WORSE than an undocumented one, because a caller
 * integrates against it and finds out at runtime.
 *
 * These tests read the SOURCE, not a fixture, so the spec cannot drift away from the
 * router without turning this red. They are deliberately narrow: they check the two
 * things a stranger integrating against the spec would be broken by — that the path is
 * really mounted, and that the response enum they will switch on is really the one the
 * code produces.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { openApiSpec } from '../src/api/openapi';

const SRC = join(__dirname, '..', 'src');
const read = (p: string) => readFileSync(join(SRC, p), 'utf8');

const HAL_EVALUATE = '/api/v1/hal/evaluate';

describe('OpenAPI documents the public HAL verify surface', () => {
  it('declares POST /api/v1/hal/evaluate', () => {
    const paths = (openApiSpec as any).paths;
    expect(Object.keys(paths)).toContain(HAL_EVALUATE);
    expect(paths[HAL_EVALUATE].post).toBeDefined();
  });

  it('the documented path is actually mounted at that prefix', () => {
    // index.ts mounts the router at a prefix; the router owns the sub-path. Both halves
    // have to be true for the documented URL to resolve, so assert both.
    const index = read('index.ts');
    expect(index).toMatch(/app\.use\(\s*['"]\/api\/v1\/hal['"]\s*,\s*halEvaluateRouter\s*\)/);

    const route = read('routes/hal-evaluate.ts');
    expect(route).toMatch(/router\.post\(\s*['"]\/evaluate['"]/);
  });

  it('is documented as keyless — no security block on the public primitive', () => {
    // The whole point of this endpoint is that a stranger can call it with nothing.
    // If someone later adds auth, the spec must stop advertising it as open.
    const op = (openApiSpec as any).paths[HAL_EVALUATE].post;
    expect(op.security).toBeUndefined();
  });
});

describe('the documented contract matches the code', () => {
  it('the decision enum is exactly the one the service type declares', () => {
    // A caller switches on `decision`. If the code grows a fifth outcome and the spec
    // does not, that caller silently falls through its default branch.
    const schema = (openApiSpec as any).components.schemas.HalEvaluateResponse;
    const documented: string[] = schema.properties.decision.enum;

    const service = read('hal/service.ts');
    const declared = service.match(/decision:\s*((?:'[a-z-]+'\s*\|\s*)*'[a-z-]+')/);
    expect(declared).not.toBeNull();
    const actual = declared![1]!.split('|').map((s) => s.trim().replace(/'/g, ''));

    expect([...documented].sort()).toEqual([...actual].sort());
  });

  it('documents `abstain`, which is a real outcome and not an error', () => {
    // Three outcomes, never two. A spec that hides `abstain` teaches integrators to
    // treat "HAL declined to judge" as a failure, which is the opposite of the point.
    const schema = (openApiSpec as any).components.schemas.HalEvaluateResponse;
    expect(schema.properties.decision.enum).toContain('abstain');
  });

  it('documents the degraded-mode fields, so a fallback cannot read as a real fact-check', () => {
    // `mode: 'extractor-fallback'` means strictness 2 was requested and the quorum was
    // NOT available. An integrator who cannot see that in the spec will score a
    // style-extractor result as a verified one.
    const schema = (openApiSpec as any).components.schemas.HalEvaluateResponse;
    expect(schema.properties.mode.enum).toContain('extractor-fallback');
    expect(schema.properties.degraded_mode).toBeDefined();
    expect(schema.properties.degraded_reason).toBeDefined();

    const service = read('hal/service.ts');
    expect(service).toContain('degraded_mode');
    expect(service).toContain('extractor-fallback');
  });

  it('the documented max length matches the value the route enforces', () => {
    const schema = (openApiSpec as any).components.schemas.HalEvaluateRequest;
    const route = read('routes/hal-evaluate.ts');
    const enforced = route.match(/text\.length\s*>\s*(\d+)/);
    expect(enforced).not.toBeNull();
    expect(schema.properties.text.maxLength).toBe(Number(enforced![1]));
  });
});
