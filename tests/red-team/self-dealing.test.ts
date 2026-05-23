import { db } from '../../src/db';

/**
 * Red Team — Economic Attack 4: Self-dealing (provider == buyer)
 *
 * Firing mode: deterministic-only. The DB CHECK constraint
 * `service_contracts_no_self_dealing CHECK (buyer_agent_id <> provider_agent_id)`
 * (migration 20260523120000) is the allowed data-layer guard. This test attempts a
 * self-dealing insert and asserts it is rejected, and that a normal cross-agent contract
 * still inserts. No deltas, no on-chain; any created row is cleaned up.
 */

const A = 'f3ef0bf8-5cdc-4fad-bce8-5144f01dc271'; // trinity-sophia
const B = '32e0e809-c1c4-4405-913f-135c8a2d6626'; // trinity-shofet

describe('Economic Attack 4: Self-dealing (service_contracts CHECK constraint)', () => {
  let serviceId: string | null = null;
  const createdIds: string[] = [];

  beforeAll(async () => {
    const { data } = await db.from('agent_services').select('id').limit(1).maybeSingle();
    serviceId = (data as any)?.id ?? null;
  });

  afterAll(async () => {
    if (createdIds.length) await db.from('service_contracts').delete().in('id', createdIds);
    await db.from('service_contracts').delete().eq('payload->>redteam', 'self_deal_test');
  });

  test('self-dealing insert (buyer == provider) is rejected by the CHECK constraint', async () => {
    expect(serviceId).toBeTruthy();
    const { data, error } = await db.from('service_contracts').insert({
      service_id: serviceId,
      buyer_agent_id: A,
      provider_agent_id: A, // same agent → must be rejected
      agreed_price_usdc_raw: 1,
      payload: { redteam: 'self_deal_test', is_simulated: true },
      status: 'pending',
    }).select('id').single();

    if (data?.id) createdIds.push(data.id); // should not happen; guard for cleanup
    expect(data).toBeNull();
    expect(error?.message ?? '').toMatch(/service_contracts_no_self_dealing|violates check constraint/i);
  });

  test('cross-agent contract (buyer != provider) still inserts', async () => {
    const { data, error } = await db.from('service_contracts').insert({
      service_id: serviceId,
      buyer_agent_id: B,
      provider_agent_id: A,
      agreed_price_usdc_raw: 1,
      payload: { redteam: 'self_deal_test', is_simulated: true },
      status: 'pending',
    }).select('id').single();

    expect(error).toBeNull();
    expect(data?.id).toBeTruthy();
    if (data?.id) createdIds.push(data.id);
  });
});
