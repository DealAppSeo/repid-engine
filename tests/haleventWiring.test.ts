import { logHalProductionEvent } from '../src/engine/production-logger';
import { verifyAuditChain } from '../src/services/auditChainWriter';
import { db } from '../src/db';

// Gated behind the same env var as the other audit-chain integration tests
// because it writes a real row to hal_production_events and truncates
// hal_audit_chain between runs — don't point it at a chain with real data.
const runIntegration = process.env.RUN_AUDIT_CHAIN_INTEGRATION === '1';
const describeIntegration = runIntegration ? describe : describe.skip;

describeIntegration('hal_production_events → hal_audit_chain wiring', () => {
  let insertedEventId: string | null = null;

  beforeEach(async () => {
    await db.from('hal_audit_chain').delete().neq('id', -1);
  });

  afterAll(async () => {
    await db.from('hal_audit_chain').delete().neq('id', -1);
    if (insertedEventId) {
      await db.from('hal_production_events').delete().eq('id', insertedEventId);
    }
  });

  it('inserts a matching hal_audit_chain row and /audit/verify stays valid', async () => {
    const promptHash = `prompt_wire_test_${Date.now().toString(16)}`;

    await logHalProductionEvent({
      agentDomain: '__wire_test__',
      promptHash,
      halVerdict: 'PASS',
      halMode: 1,
      layersActive: { sbfa: true },
    });

    const { data: halRow, error: halErr } = await db
      .from('hal_production_events')
      .select('id, prompt_hash')
      .eq('prompt_hash', promptHash)
      .single();
    expect(halErr).toBeNull();
    expect(halRow?.id).toBeTruthy();
    insertedEventId = halRow!.id;

    const { data: chainRows, error: chainErr } = await db
      .from('hal_audit_chain')
      .select('id, source_table, source_id, event_payload')
      .eq('source_table', 'hal_production_events')
      .eq('source_id', String(halRow!.id));
    expect(chainErr).toBeNull();
    expect(chainRows).toHaveLength(1);
    expect(chainRows![0]!.source_table).toBe('hal_production_events');
    expect(chainRows![0]!.source_id).toBe(String(halRow!.id));
    expect((chainRows![0]!.event_payload as any).prompt_hash).toBe(promptHash);

    const result = await verifyAuditChain();
    expect(result.valid).toBe(true);
    if (result.valid) {
      expect(result.total_entries).toBe(1);
    }
  });
});
