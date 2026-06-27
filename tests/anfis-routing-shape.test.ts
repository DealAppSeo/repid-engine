/**
 * anfis-routing-shape.test.ts — locks (1) the anfis_routing_logs insert shape against the reconciled
 * 22-column schema, and (2) the root-cause #4 domain-resolution fix in providers/router.ts.
 *
 * The prod `anfis_routing_logs` table was reconciled to 22 columns by
 * migrations/2026-06-05-anfis-routing-logs.sql (verified applied 2026-06-26: columns present incl.
 * anfis_provider, category, static_* cols, cost_usdc, notes). The Supabase client (src/db.ts) is
 * UNTYPED, so
 * an extra/renamed column would NOT be caught by tsc — only by an insert at runtime. This test pins
 * the column set the code inserts so a future column rename cannot silently re-break shadow logging.
 */

// shadow-log imports ../db → config.ts (throws without SUPABASE_URL). Mock db so the pure
// buildShadowRow can be imported without real Supabase credentials.
jest.mock('../src/db', () => ({
  db: { from: () => ({ insert: () => Promise.resolve({ data: null, error: null }) }) },
}));

import { buildShadowRow } from '../src/resilience/shadow-log';
import type { SurfaceSignal } from '../src/resilience/decision-contract';
import { resolveAnfisDomain, ANFIS_POPULATED_DOMAINS } from '../src/providers/router';

// The authoritative reconciled column set (from migrations/2026-06-05-anfis-routing-logs.sql +
// live information_schema.columns 2026-06-26). The insert row's keys must be a SUBSET of these.
const RECONCILED_COLUMNS = new Set([
  'id',
  'created_at',
  'request_text',
  'selected_model',
  'confidence_score',
  'cost_saved',
  'latency_ms',
  'success',
  'verified_by',
  'prompt_preview',
  'category',
  'static_provider',
  'static_tier',
  'static_reason',
  'anfis_provider',
  'anfis_tier',
  'anfis_conf',
  'cost_usdc',
  'outcome_hal_score',
  'outcome_vetoed',
  'n_providers',
  'notes',
]);

describe('anfis_routing_logs insert shape (Task 1)', () => {
  const sig: SurfaceSignal = {
    surface: 'llm',
    primary: 'groq',
    candidates: [
      {
        target: 'groq',
        healthy: false,
        consecutiveErrors: 4,
        latencyMsP50: 900,
        errorRate: 0.8,
        costPerUnit: 0.2,
        reliability: 0.6,
        lastSuccessAt: null,
      },
      {
        target: 'cerebras',
        healthy: true,
        consecutiveErrors: 0,
        latencyMsP50: 120,
        errorRate: 0.02,
        costPerUnit: 0.05,
        reliability: 0.92,
        lastSuccessAt: Date.now(),
      },
    ],
    requestStakes: 0.2,
    requestHint: 'llm',
  };

  const decision = {
    surface: 'llm' as const,
    action: 'failover' as const,
    chosenTarget: 'cerebras',
    confidence: 0.8,
    reason: 'failover groq→cerebras',
    selectedFeatures: ['health', 'error_rate'],
    shadow: true,
  };

  test('every inserted key exists in the reconciled prod schema', () => {
    const row = buildShadowRow(sig, decision);
    for (const key of Object.keys(row)) {
      expect(RECONCILED_COLUMNS.has(key)).toBe(true);
    }
  });

  test('row carries the load-bearing anfis columns', () => {
    const row = buildShadowRow(sig, decision);
    expect(row.anfis_provider).toBe('cerebras');
    expect(row.category).toBe('llm'); // category = surface
    expect(row.static_provider).toBe('groq');
    expect(typeof row.anfis_conf).toBe('number');
    expect(row.notes.shadow).toBe(true);
    expect(row.notes.surface).toBe('llm');
    // counterfactual cost_saved = primary.cost - chosen.cost = 0.2 - 0.05
    expect(row.cost_saved).toBeCloseTo(0.15, 6);
  });
});

describe('root-cause #4 — resolveAnfisDomain maps default away from empty general (Task 2)', () => {
  const ORIG = process.env.ROUTER_ANFIS_DEFAULT_DOMAIN;
  afterEach(() => {
    if (ORIG === undefined) delete process.env.ROUTER_ANFIS_DEFAULT_DOMAIN;
    else process.env.ROUTER_ANFIS_DEFAULT_DOMAIN = ORIG;
  });

  test('no hint → populated default (peer_verify), NOT empty general', () => {
    delete process.env.ROUTER_ANFIS_DEFAULT_DOMAIN;
    const d = resolveAnfisDomain(undefined);
    expect(d).toBe('peer_verify');
    expect(d).not.toBe('general');
  });

  test('legacy general hint is treated as no useful hint → populated default', () => {
    delete process.env.ROUTER_ANFIS_DEFAULT_DOMAIN;
    expect(resolveAnfisDomain('general')).toBe('peer_verify');
    expect(resolveAnfisDomain('GENERAL')).toBe('peer_verify');
  });

  test('a real populated domain hint is honored (case-insensitive canonical form)', () => {
    expect(resolveAnfisDomain('evergreen')).toBe('EVERGREEN');
    expect(resolveAnfisDomain('peer_verify')).toBe('peer_verify');
    expect(ANFIS_POPULATED_DOMAINS).toContain('cait');
  });

  test('an unknown but explicit hint is honored verbatim (graceful empty-RPC fallback)', () => {
    expect(resolveAnfisDomain('research')).toBe('research');
  });

  test('ROUTER_ANFIS_DEFAULT_DOMAIN override is respected', () => {
    process.env.ROUTER_ANFIS_DEFAULT_DOMAIN = 'EVERGREEN';
    expect(resolveAnfisDomain(undefined)).toBe('EVERGREEN');
  });
});
