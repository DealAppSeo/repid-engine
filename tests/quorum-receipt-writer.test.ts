/**
 * Self-test for the HAL family-quorum receipt writer (src/hal/quorum-receipt-writer.ts).
 * OUTPUT_PATH: tests/quorum-receipt-writer.test.ts  (tests/ is the jest root — CLAUDE.md test-layout quirk).
 *
 * PROVES:
 *   1. buildQuorumReceipt() (PURE) maps a SYNTHETIC cross-family quorum decision into one receipt row
 *      carrying the disjoint-family metadata (families[], families_unmapped[]) + N per-vote rows with a
 *      family each.
 *   2. writeQuorumReceipt() is a NO-OP by default (flag OFF) — it does NOT touch the client.
 *   3. With the flag ON and an INJECTED in-memory fake client (NOT prod), it lands >=1 receipt row and
 *      the validator-vote rows, with receipt_id linkage and the disjoint-family metadata intact.
 *
 * All data is synthetic: quorum ids and agent ids are literal 00000000-… strings; no prod extract.
 */

import {
  buildQuorumReceipt,
  writeQuorumReceipt,
  quorumReceiptWriteEnabled,
  type QuorumReceiptContext,
} from '../src/hal/quorum-receipt-writer';
import type { FactCheckResult } from '../src/hal/fact-check';

// ── Synthetic cross-family quorum VETO decision (3 distinct independent families vote FALSE) ──────────
const SYNTHETIC_QUORUM: FactCheckResult = {
  hal_score: 0.82,
  decision: 'vetoed',
  decision_reason: '2 of 3 independent model families judged this claim FALSE (llama, gemini, deepseek).',
  verdicts: [
    { provider: 'groq', model: 'llama-3.3-70b-versatile', verdict: 'FALSE', confidence: 90, latency_ms: 210 },
    { provider: 'gemini', model: 'gemini-2.0-flash', verdict: 'FALSE', confidence: 85, latency_ms: 340 },
    { provider: 'deepseek', model: 'deepseek-chat', verdict: 'TRUE', confidence: 60, latency_ms: 400 },
    { provider: 'brokenhost', model: 'some-model', verdict: 'ERROR', confidence: 0, error: 'timeout after 12000ms', latency_ms: 12000 },
  ],
  providers_used: 3,
  families_used: 3,
  families: ['llama', 'gemini', 'deepseek'],
  families_unmapped: [],
  agreement: 0.67,
  degraded: false,
  latency_ms: 950,
  quorum: 'full',
};

const CTX: QuorumReceiptContext = {
  quorumId: '00000000-0000-0000-0000-0000000000aa',
  agentId: '00000000-0000-0000-0000-0000000000bb',
  scoreEventId: 424242,
};

// ── Minimal in-memory fake of the Supabase client surface the writer uses (.from().insert().select().single()) ──
interface FakeInsert {
  table: string;
  rows: any[];
}
function makeFakeClient() {
  const inserts: FakeInsert[] = [];
  let nextId = 1000;
  const client = {
    from(table: string) {
      const captured: FakeInsert = { table, rows: [] };
      return {
        insert(payload: any) {
          captured.rows = Array.isArray(payload) ? payload : [payload];
          inserts.push(captured);
          // The votes-insert path awaits this object directly (no .select()).
          const thenable = {
            select(_cols: string) {
              return {
                async single() {
                  // Emulate RETURNING id for the receipt insert.
                  return { data: { id: ++nextId }, error: null };
                },
              };
            },
            then(resolve: (v: { error: null }) => void) {
              resolve({ error: null });
            },
          };
          return thenable;
        },
      };
    },
    inserts,
  };
  return client;
}

describe('HAL family-quorum receipt writer', () => {
  const OLD_ENV = { ...process.env };
  afterEach(() => {
    process.env = { ...OLD_ENV };
  });

  test('buildQuorumReceipt maps the disjoint-family metadata + per-vote families (PURE)', () => {
    const { receipt, votes } = buildQuorumReceipt(SYNTHETIC_QUORUM, CTX);

    // Disjoint-family metadata — the reason this receipt exists.
    expect(receipt.families).toEqual(['llama', 'gemini', 'deepseek']);
    expect(receipt.families_used).toBe(3);
    expect(receipt.families_unmapped).toEqual([]);
    expect(receipt.quorum_met).toBe(true); // 3 families >= 2

    // Decision faithfulness.
    expect(receipt.decision).toBe('vetoed');
    expect(receipt.scoring_decision).toBe('veto');
    expect(receipt.decision_source).toBe('quorum');
    expect(receipt.hal_mode).toBe('fact-check');
    expect(receipt.quorum_id).toBe(CTX.quorumId);
    expect(receipt.agent_id).toBe(CTX.agentId);
    expect(receipt.score_event_id).toBe(424242);
    expect(receipt.hal_score).toBeCloseTo(0.82);

    // One vote row per provider verdict (incl. the ERROR row — audit completeness).
    expect(votes).toHaveLength(4);
    const byProvider = Object.fromEntries(votes.map((v) => [v.provider, v]));
    expect(byProvider.groq.family).toBe('llama');
    expect(byProvider.gemini.family).toBe('gemini');
    expect(byProvider.deepseek.family).toBe('deepseek');
    expect(byProvider.groq.verdict).toBe('FALSE');
    expect(byProvider.brokenhost.verdict).toBe('ERROR');
    expect(byProvider.brokenhost.error).toContain('timeout');
    // Every vote carries a resolved family (disjointness is per-vote, not just aggregate).
    for (const v of votes) expect(typeof v.family).toBe('string');
  });

  test('writeQuorumReceipt is a NO-OP when the flag is OFF (default) — client untouched', async () => {
    delete process.env.HAL_QUORUM_RECEIPT_ENABLED;
    expect(quorumReceiptWriteEnabled()).toBe(false);

    const client = makeFakeClient();
    const res = await writeQuorumReceipt(client as any, SYNTHETIC_QUORUM, CTX);

    expect(res.written).toBe(false);
    expect(res.skippedReason).toBe('flag-off');
    expect(client.inserts).toHaveLength(0); // nothing written anywhere
  });

  test('with flag ON + injected fake client, lands 1 receipt row + N vote rows (shadow/test, NOT prod)', async () => {
    process.env.HAL_QUORUM_RECEIPT_ENABLED = 'true';
    process.env.HAL_QUORUM_RECEIPT_SAMPLE_RATE = '1.0';
    expect(quorumReceiptWriteEnabled()).toBe(true);

    const client = makeFakeClient();
    const res = await writeQuorumReceipt(client as any, SYNTHETIC_QUORUM, CTX);

    // >= 1 evidence row written.
    expect(res.written).toBe(true);
    expect(res.receiptId).toBeGreaterThan(0);
    expect(res.voteCount).toBe(4);

    // Exactly one receipt insert + one votes insert.
    const receiptInserts = client.inserts.filter((i) => i.table === 'hal_quorum_receipts');
    const voteInserts = client.inserts.filter((i) => i.table === 'hal_quorum_validator_votes');
    expect(receiptInserts).toHaveLength(1);
    expect(voteInserts).toHaveLength(1);

    // The persisted receipt row carries the disjoint-family metadata.
    const receiptRow = receiptInserts[0]!.rows[0];
    expect(receiptRow.families).toEqual(['llama', 'gemini', 'deepseek']);
    expect(receiptRow.families_unmapped).toEqual([]);
    expect(receiptRow.decision).toBe('vetoed');
    expect(receiptRow.scoring_decision).toBe('veto');

    // Every vote row is linked to the receipt id and carries its family.
    const voteRows = voteInserts[0]!.rows;
    expect(voteRows).toHaveLength(4);
    for (const v of voteRows) expect(v.receipt_id).toBe(res.receiptId);
    // The three independent voting families are each present on their own vote row.
    const familiesByProvider = Object.fromEntries(voteRows.map((v: any) => [v.provider, v.family]));
    expect(familiesByProvider.groq).toBe('llama');
    expect(familiesByProvider.gemini).toBe('gemini');
    expect(familiesByProvider.deepseek).toBe('deepseek');
  });

  test('unmapped family surfaces in receipt.families_unmapped (spoofable-vote visibility)', () => {
    const withUnmapped: FactCheckResult = {
      ...SYNTHETIC_QUORUM,
      families: ['llama', 'gemini'],
      families_used: 2,
      families_unmapped: ['mystery-model-9000'],
    };
    const { receipt } = buildQuorumReceipt(withUnmapped, CTX);
    expect(receipt.families_unmapped).toEqual(['mystery-model-9000']);
  });
});
