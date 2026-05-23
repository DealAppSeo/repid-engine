import { db } from '../../src/db';

/**
 * Red Team — Economic Attack 3: Double-Fulfill (deterministic data-layer proof)
 *
 * Firing mode: deterministic-only (irreversible on-chain risk) per Sean's directive.
 * This test does NOT call the /fulfill route and NEVER invokes applyServiceFulfilledDeltas,
 * so no RepID delta, no repid_events, and no on-chain attestation can fire. It exercises only
 * the service_contracts FSM at the data layer (status updates inside the test), marks the row
 * is_simulated so any (default-off) worker would skip it, and deletes it in afterAll.
 *
 * GAP (confirmed): the /fulfill route (src/routes/v1/contracts.ts) updates
 *   service_contracts SET status='fulfilled' WHERE id = :id      -- no status precondition
 * and then calls applyServiceFulfilledDeltas every time. The FSM trigger
 * enforce_service_contract_status_transition explicitly ALLOWS the self-transition
 * fulfilled -> fulfilled, and there is NO per-contract uniqueness on repid_score_events /
 * repid_events. So a second /fulfill re-awards provider+buyer RepID and writes a duplicate
 * service_fulfilled_settled event. Production shows 0 duplicates today only because nothing
 * has called /fulfill twice — the gap is latent, not yet exploited.
 *
 * FIX (proven idempotent below): add a status precondition to the route UPDATE
 *   ...WHERE id = :id AND status = 'escrowed'
 * so a second call matches 0 rows and skips the delta application. The route is Gemini's
 * territory this cycle, so the fix is handed off (CC2_HANDOFF_TO_GEMINI_x402.md / report P5),
 * not applied here.
 */

const PROVIDER = 'f3ef0bf8-5cdc-4fad-bce8-5144f01dc271'; // trinity-sophia
const BUYER = '32e0e809-c1c4-4405-913f-135c8a2d6626';    // trinity-shofet (distinct => not self-dealing)

describe('Economic Attack 3: Double-Fulfill (service_contracts FSM, data-layer)', () => {
  let serviceId: string | null = null;
  let contractId: string | null = null;

  beforeAll(async () => {
    const { data } = await db.from('agent_services').select('id').limit(1).maybeSingle();
    serviceId = (data as any)?.id ?? null;
  });

  afterAll(async () => {
    if (contractId) await db.from('service_contracts').delete().eq('id', contractId);
    await db.from('service_contracts').delete().eq('payload->>redteam', 'double_fulfill');
  });

  test('FSM trigger ALLOWS fulfilled -> fulfilled (the unguarded gap), and a status-preconditioned update is idempotent (the fix)', async () => {
    expect(serviceId).toBeTruthy();

    // pending -> escrowed -> fulfilled (legitimate first fulfillment, status-only, no deltas)
    const { data: created, error: insErr } = await db.from('service_contracts').insert({
      service_id: serviceId,
      buyer_agent_id: BUYER,
      provider_agent_id: PROVIDER,
      agreed_price_usdc_raw: 1,
      payload: { redteam: 'double_fulfill', is_simulated: true },
      metadata: { is_simulated: true },
      status: 'pending',
    }).select('id').single();
    expect(insErr).toBeNull();
    contractId = (created as any)?.id ?? null;
    expect(contractId).toBeTruthy();

    await db.from('service_contracts').update({ status: 'escrowed', escrowed_at: new Date().toISOString() }).eq('id', contractId!);
    const { error: f1Err } = await db.from('service_contracts')
      .update({ status: 'fulfilled', fulfilled_at: new Date().toISOString() })
      .eq('id', contractId!);
    expect(f1Err).toBeNull();

    // ATTACK: unguarded second fulfill (mirrors the route — only keyed on id). Must SUCCEED,
    // proving the FSM trigger permits the duplicate transition (the route would re-apply deltas here).
    const { data: attack, error: f2Err } = await db.from('service_contracts')
      .update({ status: 'fulfilled', fulfilled_at: new Date().toISOString() })
      .eq('id', contractId!)
      .select('id');
    expect(f2Err).toBeNull();
    expect(Array.isArray(attack) ? attack.length : 0).toBe(1); // gap: second fulfill is accepted

    // FIX: a status-preconditioned update matches 0 rows on the second attempt (idempotent).
    const { data: guarded, error: gErr } = await db.from('service_contracts')
      .update({ status: 'fulfilled', fulfilled_at: new Date().toISOString() })
      .eq('id', contractId!)
      .eq('status', 'escrowed') // precondition the route is missing
      .select('id');
    expect(gErr).toBeNull();
    expect(Array.isArray(guarded) ? guarded.length : -1).toBe(0); // fix: nothing to fulfill again
  });
});
