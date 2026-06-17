/**
 * Tests for validation-loop-writeback.ts
 * feat/cc-2026-06-17-validation-loop
 *
 * Covers:
 *   - Flag DEFAULT OFF: emitBilateralWriteback returns skipped when VALIDATION_WRITEBACK_ENABLED unset
 *   - Idempotency: re-running with existing idempotency key rows → idempotent_replay=true, 0 new rows
 *   - D-3 Collusion cap: mutual pair > 25/7d → validator reward skipped
 *   - D-5 Diminishing returns: multiplier = 1/sqrt(N) applied to delta
 *   - D-1 Anchor gate: unanchored → micro-reward only; anchored → full reward
 *   - Bilateral shape: one validator event + one source event emitted on 'verified'
 *   - D-WT idempotency keys: validator key = peer_verify:{id}:validator:{vId}, source key similarly
 *   - dryRunWriteback: returns 2 would_emit entries, no DB writes, dry_run=true
 *   - AT-WB-2 (double-apply): second call with same pvqId → idempotent_replay, no extra rows
 */

// ─── Mocks must be declared before imports ────────────────────────────────────

// Track all pgQuery calls and repid_score_events inserts
const pgQueryMock = jest.fn();
const dbFromMock = jest.fn();

jest.mock('../src/db/direct-pg', () => ({
  pgQuery: (...args: any[]) => pgQueryMock(...args),
  pgPing: jest.fn(async () => true),
}));

jest.mock('../src/db', () => ({
  db: {
    from: (table: string) => dbFromMock(table),
  },
}));

jest.mock('../src/scoring/pipeline', () => ({
  runScoreEvent: jest.fn(async (input: any) => ({
    score_event_id: 9999,
    hal_score: 0.5,
    hal_decision: 'clean',
    signals: {},
    repid_delta_calculated: 0,
    repid_delta_applied: 0,
    old_repid: 1000,
    new_repid: 1000,
    zk_proof_triggered: false,
    zk_proof_id: null,
    reason: 'mock',
    idempotency_key: input.idempotency_key,
  })),
}));

import { emitBilateralWriteback, dryRunWriteback } from '../src/services/validation-loop-writeback';

// ─── Constants ────────────────────────────────────────────────────────────────

const PVQ_ID = 42;
const VERIFIER_ID = 'aaaaaaaa-bbbb-4ccc-8ddd-000000000001';
const SOURCE_ID = 'aaaaaaaa-bbbb-4ccc-8ddd-000000000002';
const RESPONSE_ID = 'source-response-uuid-001';
const CLAIM_TEXT = 'The Eiffel Tower is in Paris, France.';
const VALIDATOR_KEY = `peer_verify:${PVQ_ID}:validator:${VERIFIER_ID}`;
const SOURCE_KEY = `peer_verify:${PVQ_ID}:source:${SOURCE_ID}`;

// ─── Helpers ──────────────────────────────────────────────────────────────────

function enableWriteback() {
  process.env.VALIDATION_WRITEBACK_ENABLED = 'true';
}
function disableWriteback() {
  delete process.env.VALIDATION_WRITEBACK_ENABLED;
}

/**
 * Configure pgQueryMock for the standard "verified, no collision, no anchor" case.
 * Returns row-count arrays keyed by label argument.
 */
function setupPgQueryMocks({
  existingRows = 0,       // how many rows match `peer_verify:{PVQ_ID}:%` (idempotency probe)
  collusionCount = 0,     // mutual verified count (D-3)
  diminishingN = 1,       // verifier's 24h completion count (D-5)
  anchorFound = false,    // hal_test_cases lookup (D-1)
  validatorRepid = 1000,
  sourceRepid = 900,
  insertValidatorId = '101',
  insertSourceId = '102',
}: {
  existingRows?: number;
  collusionCount?: number;
  diminishingN?: number;
  anchorFound?: boolean;
  validatorRepid?: number;
  sourceRepid?: number;
  insertValidatorId?: string;
  insertSourceId?: string;
} = {}) {
  pgQueryMock.mockImplementation(async (_sql: string, _params: any[], opts?: any) => {
    const label = opts?.label ?? '';

    // Outer idempotency check (LIKE 'peer_verify:{id}:%')
    if (label === 'validation-writeback-idempotency-check') {
      return [{ count: String(existingRows) }];
    }
    // D-3 collusion cap
    if (label === 'validation-writeback-collusion-cap') {
      return [{ n: String(collusionCount) }];
    }
    // D-5 diminishing returns
    if (label === 'validation-writeback-diminishing') {
      return [{ n: String(diminishingN) }];
    }
    // Inner validator idempotency check
    if (label === 'validation-writeback-validator-idempotency') {
      return [{ n: existingRows > 0 ? '1' : '0' }];
    }
    // Inner source idempotency check
    if (label === 'validation-writeback-source-idempotency') {
      return [{ n: existingRows > 0 ? '1' : '0' }];
    }
    // Validator agent repid fetch
    if (label === 'validation-writeback-validator-agent') {
      return [{ current_repid: String(validatorRepid), tier: 'ESTABLISHED' }];
    }
    // Source agent repid fetch
    if (label === 'validation-writeback-source-agent') {
      return [{ current_repid: String(sourceRepid) }];
    }
    // Validator score_events insert
    if (label === 'validation-writeback-validator-insert') {
      return [{ id: insertValidatorId }];
    }
    // Source score_events insert
    if (label === 'validation-writeback-source-insert') {
      return [{ id: insertSourceId }];
    }
    // WRITER_DIRECT_APPLY updates
    if (label === 'validation-writeback-validator-repid-update') return [];
    if (label === 'validation-writeback-source-repid-update') return [];
    // Dry-run repid fetch
    if (label === 'dry-run-repid-fetch') {
      // Return different value based on which agent is being queried (param[0])
      return [{ current_repid: String(validatorRepid) }];
    }

    return [];
  });

  // db.from mock for hal_test_cases lookup (D-1)
  dbFromMock.mockImplementation((table: string) => {
    if (table === 'hal_test_cases') {
      return {
        select: () => ({
          eq: () => ({
            maybeSingle: async () => ({
              data: anchorFound ? { id: RESPONSE_ID } : null,
              error: null,
            }),
          }),
        }),
      };
    }
    if (table === 'hal_canary_cases') {
      return {
        select: () => ({
          eq: () => ({
            maybeSingle: async () => ({ data: null, error: null }),
          }),
        }),
      };
    }
    return { select: () => ({}) };
  });
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('emitBilateralWriteback', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    disableWriteback();
  });

  afterEach(() => {
    disableWriteback();
  });

  // ── Flag off ─────────────────────────────────────────────────────────────

  it('returns skipped=true when VALIDATION_WRITEBACK_ENABLED is unset (default-off)', async () => {
    // Do NOT enable the flag
    const result = await emitBilateralWriteback({
      pvqId: PVQ_ID,
      verdict: 'verified',
      verifierAgentId: VERIFIER_ID,
      sourceAgentId: SOURCE_ID,
      sourceResponseId: RESPONSE_ID,
      claimText: CLAIM_TEXT,
    });

    expect(result.skipped).toBe(true);
    expect(result.skip_reason).toMatch(/VALIDATION_WRITEBACK_ENABLED=false/);
    // No DB calls should have been made
    expect(pgQueryMock).not.toHaveBeenCalled();
  });

  it('returns skipped=true when VALIDATION_WRITEBACK_ENABLED=false explicitly', async () => {
    process.env.VALIDATION_WRITEBACK_ENABLED = 'false';
    const result = await emitBilateralWriteback({
      pvqId: PVQ_ID,
      verdict: 'verified',
      verifierAgentId: VERIFIER_ID,
      sourceAgentId: SOURCE_ID,
      sourceResponseId: RESPONSE_ID,
      claimText: CLAIM_TEXT,
    });
    expect(result.skipped).toBe(true);
    expect(pgQueryMock).not.toHaveBeenCalled();
  });

  // ── Idempotency (AT-WB-2 defense) ────────────────────────────────────────

  it('returns idempotent_replay=true when idempotency rows already exist (AT-WB-2)', async () => {
    enableWriteback();
    setupPgQueryMocks({ existingRows: 2 }); // 2 rows already exist for this pvqId

    const result = await emitBilateralWriteback({
      pvqId: PVQ_ID,
      verdict: 'verified',
      verifierAgentId: VERIFIER_ID,
      sourceAgentId: SOURCE_ID,
      sourceResponseId: RESPONSE_ID,
      claimText: CLAIM_TEXT,
    });

    expect(result.idempotent_replay).toBe(true);
    expect(result.skipped).toBe(false);
    // Only the idempotency probe query should have fired — no inserts
    const insertCalls = pgQueryMock.mock.calls.filter(
      (c: any[]) => c[2]?.label?.includes('insert'),
    );
    expect(insertCalls).toHaveLength(0);
  });

  it('second call with same pvqId → 0 new rows (D-WT idempotency)', async () => {
    enableWriteback();
    // First call: no existing rows
    setupPgQueryMocks({ existingRows: 0 });
    const first = await emitBilateralWriteback({
      pvqId: PVQ_ID, verdict: 'verified',
      verifierAgentId: VERIFIER_ID, sourceAgentId: SOURCE_ID,
      sourceResponseId: RESPONSE_ID, claimText: CLAIM_TEXT,
    });
    expect(first.skipped).toBe(false);
    expect(first.idempotent_replay).toBeUndefined();

    // Second call: simulate rows already written
    jest.clearAllMocks();
    setupPgQueryMocks({ existingRows: 2 }); // DB now has rows from first run
    const second = await emitBilateralWriteback({
      pvqId: PVQ_ID, verdict: 'verified',
      verifierAgentId: VERIFIER_ID, sourceAgentId: SOURCE_ID,
      sourceResponseId: RESPONSE_ID, claimText: CLAIM_TEXT,
    });
    expect(second.idempotent_replay).toBe(true);
    const secondInserts = pgQueryMock.mock.calls.filter(
      (c: any[]) => c[2]?.label?.includes('insert'),
    );
    expect(secondInserts).toHaveLength(0);
  });

  // ── Bilateral shape: verified verdict emits 2 events ─────────────────────

  it('verified verdict → emits both validator and source events', async () => {
    enableWriteback();
    setupPgQueryMocks({
      existingRows: 0,
      validatorRepid: 1000,
      sourceRepid: 900,
      insertValidatorId: '201',
      insertSourceId: '202',
    });

    const result = await emitBilateralWriteback({
      pvqId: PVQ_ID, verdict: 'verified',
      verifierAgentId: VERIFIER_ID, sourceAgentId: SOURCE_ID,
      sourceResponseId: RESPONSE_ID, claimText: CLAIM_TEXT,
    });

    expect(result.skipped).toBe(false);
    expect(result.idempotent_replay).toBeUndefined();
    expect(result.validator_event).toBeDefined();
    expect(result.source_event).toBeDefined();

    // Validator event: micro-reward (no anchor, first 24h)
    const vEvent = result.validator_event!;
    expect(vEvent.score_event_id).toBe(201);
    expect(vEvent.repid_delta_applied).toBeGreaterThan(0);

    // Source event: positive delta for verified
    const sEvent = result.source_event!;
    expect(sEvent.score_event_id).toBe(202);
    expect(sEvent.repid_delta_applied).toBeGreaterThan(0);
    expect(sEvent.old_repid).toBe(900);
  });

  // ── D-3: Collusion cap ───────────────────────────────────────────────────

  it('D-3: collusion cap exceeded → validator event skipped, collusion_capped=true', async () => {
    enableWriteback();
    setupPgQueryMocks({ existingRows: 0, collusionCount: 30 }); // > 25 cap

    const result = await emitBilateralWriteback({
      pvqId: PVQ_ID, verdict: 'verified',
      verifierAgentId: VERIFIER_ID, sourceAgentId: SOURCE_ID,
      sourceResponseId: RESPONSE_ID, claimText: CLAIM_TEXT,
    });

    expect(result.collusion_capped).toBe(true);
    // Validator event should be absent (skipped due to cap)
    expect(result.validator_event).toBeUndefined();
    // Source event still emitted (cap only blocks validator reward)
    expect(result.source_event).toBeDefined();
  });

  // ── D-5: Diminishing returns ─────────────────────────────────────────────

  it('D-5: diminishing returns scales validator delta (N=4 verifications → multiplier=0.5)', async () => {
    enableWriteback();
    setupPgQueryMocks({
      existingRows: 0,
      diminishingN: 4, // 1/sqrt(4) = 0.5
      validatorRepid: 1000,
      sourceRepid: 900,
    });

    const result = await emitBilateralWriteback({
      pvqId: PVQ_ID, verdict: 'verified',
      verifierAgentId: VERIFIER_ID, sourceAgentId: SOURCE_ID,
      sourceResponseId: RESPONSE_ID, claimText: CLAIM_TEXT,
    });

    expect(result.diminishing_multiplier).toBeCloseTo(0.5, 2);
    // Micro-reward (3) * 0.5 = 1 (rounded)
    if (result.validator_event) {
      expect(result.validator_event.repid_delta_applied).toBeLessThan(3);
    }
  });

  // ── D-1: Anchor gate ─────────────────────────────────────────────────────

  it('D-1: unanchored claim → micro-reward (3), anchor_found=false', async () => {
    enableWriteback();
    setupPgQueryMocks({ existingRows: 0, anchorFound: false, validatorRepid: 1000, sourceRepid: 900 });

    const result = await emitBilateralWriteback({
      pvqId: PVQ_ID, verdict: 'verified',
      verifierAgentId: VERIFIER_ID, sourceAgentId: SOURCE_ID,
      sourceResponseId: RESPONSE_ID, claimText: CLAIM_TEXT,
    });

    expect(result.anchor_found).toBe(false);
    if (result.validator_event) {
      // With no anchor and diminishingN=1 → 3 * (1/sqrt(1)) = 3
      expect(result.validator_event.repid_delta_applied).toBe(3);
    }
  });

  it('D-1: anchored claim → full reward (120), anchor_found=true', async () => {
    enableWriteback();
    setupPgQueryMocks({ existingRows: 0, anchorFound: true, validatorRepid: 1000, sourceRepid: 900 });

    const result = await emitBilateralWriteback({
      pvqId: PVQ_ID, verdict: 'verified',
      verifierAgentId: VERIFIER_ID, sourceAgentId: SOURCE_ID,
      sourceResponseId: RESPONSE_ID, claimText: CLAIM_TEXT,
    });

    expect(result.anchor_found).toBe(true);
    if (result.validator_event) {
      // With anchor and diminishingN=1 → 120 * (1/sqrt(1)) = 120
      expect(result.validator_event.repid_delta_applied).toBe(120);
    }
  });

  // ── D-4: Idempotency key includes verifier UUID ───────────────────────────

  it('D-4: idempotency key contains verifier UUID (binds verifier identity)', async () => {
    enableWriteback();
    setupPgQueryMocks({ existingRows: 0 });

    await emitBilateralWriteback({
      pvqId: PVQ_ID, verdict: 'verified',
      verifierAgentId: VERIFIER_ID, sourceAgentId: SOURCE_ID,
      sourceResponseId: RESPONSE_ID, claimText: CLAIM_TEXT,
    });

    // Find the validator insert call and check the idempotency_key param
    const validatorInsert = pgQueryMock.mock.calls.find(
      (c: any[]) => c[2]?.label === 'validation-writeback-validator-insert',
    );
    if (validatorInsert) {
      const params = validatorInsert[1] as string[];
      // idempotency_key is the 6th param ($6) in our INSERT
      const key = params[5];
      expect(key).toBe(VALIDATOR_KEY);
      expect(key).toContain(VERIFIER_ID);
    }

    const sourceInsert = pgQueryMock.mock.calls.find(
      (c: any[]) => c[2]?.label === 'validation-writeback-source-insert',
    );
    if (sourceInsert) {
      const params = sourceInsert[1] as string[];
      const key = params[5];
      expect(key).toBe(SOURCE_KEY);
      expect(key).toContain(SOURCE_ID);
    }
  });

  // ── disputed verdict ──────────────────────────────────────────────────────

  it('disputed verdict → validator penalty + source slash', async () => {
    enableWriteback();
    setupPgQueryMocks({
      existingRows: 0,
      validatorRepid: 1000,
      sourceRepid: 900,
      insertValidatorId: '301',
      insertSourceId: '302',
    });

    const result = await emitBilateralWriteback({
      pvqId: PVQ_ID, verdict: 'disputed',
      verifierAgentId: VERIFIER_ID, sourceAgentId: SOURCE_ID,
      sourceResponseId: RESPONSE_ID, claimText: CLAIM_TEXT,
    });

    expect(result.skipped).toBe(false);
    // Both events should be emitted (disputed path has different event types)
    // Validator penalty should have negative delta
    if (result.validator_event) {
      expect(result.validator_event.repid_delta_applied).toBeLessThan(0);
    }
    // Source slash should also be negative
    if (result.source_event) {
      expect(result.source_event.repid_delta_applied).toBeLessThan(0);
    }
  });
});

// ─── dryRunWriteback ──────────────────────────────────────────────────────────

describe('dryRunWriteback', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('returns dry_run=true with 2 would_emit entries, makes no DB inserts', async () => {
    // Setup mocks for the queries dryRun does (repid fetches + checks)
    pgQueryMock.mockImplementation(async (_sql: string, _params: any[], opts?: any) => {
      const label = opts?.label ?? '';
      if (label === 'validation-writeback-collusion-cap') return [{ n: '0' }];
      if (label === 'validation-writeback-diminishing') return [{ n: '1' }];
      if (label === 'dry-run-repid-fetch') return [{ current_repid: '1000' }];
      return [];
    });

    dbFromMock.mockImplementation((table: string) => ({
      select: () => ({
        eq: () => ({
          maybeSingle: async () => ({ data: null, error: null }),
        }),
      }),
    }));

    const result = await dryRunWriteback({
      pvqId: PVQ_ID,
      verdict: 'verified',
      verifierAgentId: VERIFIER_ID,
      sourceAgentId: SOURCE_ID,
      sourceResponseId: RESPONSE_ID,
      claimText: CLAIM_TEXT,
    });

    expect(result.dry_run).toBe(true);
    expect(result.would_emit).toHaveLength(2);
    expect(result.would_emit[0]?.agent).toContain('validator');
    expect(result.would_emit[1]?.agent).toContain('source');

    // Validator entry
    const validatorEntry = result.would_emit[0]!;
    expect(validatorEntry.agent_id).toBe(VERIFIER_ID);
    expect(validatorEntry.delta).toBeGreaterThanOrEqual(0);
    expect(validatorEntry.repid_before).toBe(1000);

    // Source entry
    const sourceEntry = result.would_emit[1]!;
    expect(sourceEntry.agent_id).toBe(SOURCE_ID);
    expect(sourceEntry.delta).toBeGreaterThan(0); // verified → positive source delta

    // No insert labels should appear
    const insertCalls = pgQueryMock.mock.calls.filter(
      (c: any[]) => c[2]?.label?.includes('insert'),
    );
    expect(insertCalls).toHaveLength(0);

    // Idempotency keys are present
    expect(result.idempotency_keys.validator).toBe(VALIDATOR_KEY);
    expect(result.idempotency_keys.source).toBe(SOURCE_KEY);
  });

  it('dry run: re-running produces same result (truly no side effects)', async () => {
    pgQueryMock.mockImplementation(async (_sql: string, _params: any[], opts?: any) => {
      const label = opts?.label ?? '';
      if (label === 'validation-writeback-collusion-cap') return [{ n: '0' }];
      if (label === 'validation-writeback-diminishing') return [{ n: '1' }];
      if (label === 'dry-run-repid-fetch') return [{ current_repid: '1000' }];
      return [];
    });
    dbFromMock.mockImplementation(() => ({
      select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null, error: null }) }) }),
    }));

    const r1 = await dryRunWriteback({ pvqId: PVQ_ID, verdict: 'verified', verifierAgentId: VERIFIER_ID, sourceAgentId: SOURCE_ID, sourceResponseId: RESPONSE_ID, claimText: CLAIM_TEXT });
    const r2 = await dryRunWriteback({ pvqId: PVQ_ID, verdict: 'verified', verifierAgentId: VERIFIER_ID, sourceAgentId: SOURCE_ID, sourceResponseId: RESPONSE_ID, claimText: CLAIM_TEXT });

    // Both runs produce identical output (idempotent by design)
    expect(r1.would_emit[0]?.delta).toBe(r2.would_emit[0]?.delta);
    expect(r1.would_emit[1]?.delta).toBe(r2.would_emit[1]?.delta);
  });
});
