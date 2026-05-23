import { db } from '../../src/db';
import { v4 as uuidv4 } from 'uuid';

/**
 * Red Team — Economic Attack 1: Idempotency Bypass (deterministic data-layer proof)
 *
 * Firing mode: live-fire OK (DB-cleanable) per Sean's directive. These tests write and
 * delete x402_settlements rows directly via the service-role client. They never touch the
 * x402 route code (Gemini's territory) and never fire an on-chain attestation:
 *   - all rows are is_simulated=true and orphaned (synthetic tip_id, no linked contract),
 *     which the FeedbackLoopWorker poll filters exclude from any gas/on-chain path; and
 *   - every created row is deleted in afterAll.
 *
 * Attack (ATTACKER v2 library): reuse one X-PAYMENT to settle a contract more than once.
 * The escrow handler (src/routes/v1/contracts.ts) keys idempotency on the CONTRACT id
 * (idempotency_key = contractId): it SELECTs an existing settlement and returns it instead
 * of settling again. That app-level check is best-effort (a SELECT-then-INSERT race could
 * pass twice). The load-bearing defense is the DB partial unique index
 *   CREATE UNIQUE INDEX idx_x402_settlements_idempotency_key
 *     ON x402_settlements (idempotency_key) WHERE idempotency_key IS NOT NULL
 * which makes a second settlement for the same contract impossible even under a race.
 *
 * Verdict: the documented attack (replay to the SAME contract) is DEFENDED in depth.
 * Residual (test 2, by design): idempotency keys on the contract, not the payment, so the
 * same X-PAYMENT can settle DIFFERENT contracts. In real mode the EIP-3009 nonce in the
 * facilitator settle rejects that replay on-chain; in simulated mode it is unguarded. That
 * residual is a handoff to Gemini (x402 owner), not patched here.
 */

const TOPIC = 'redteam_idempotency';

const baseRow = (idempotencyKey: string | null, header: string) => ({
  tip_id: `redteam_idem_${uuidv4()}`,
  prediction_topic: TOPIC,
  amount: 1,
  asset: 'USDC',
  status: 'settled',
  is_simulated: true,
  x_payment_header: header,
  idempotency_key: idempotencyKey,
});

describe('Economic Attack 1: Idempotency Bypass (x402_settlements data-layer defense)', () => {
  const createdIds: string[] = [];

  afterAll(async () => {
    if (createdIds.length) await db.from('x402_settlements').delete().in('id', createdIds);
    // Belt-and-suspenders: nuke anything left under the red-team topic.
    await db.from('x402_settlements').delete().eq('prediction_topic', TOPIC);
  });

  test('replay to the SAME contract cannot double-settle — partial unique index rejects the duplicate', async () => {
    const contractId = `redteam_contract_${uuidv4()}`;
    const header = `xpay_${uuidv4()}`;

    const { data: first, error: e1 } = await db
      .from('x402_settlements')
      .insert(baseRow(contractId, header))
      .select('id')
      .single();
    expect(e1).toBeNull();
    expect(first?.id).toBeTruthy();
    if (first?.id) createdIds.push(first.id);

    // Attack: same payment, same contract → second settlement for idempotency_key = contractId.
    const { data: second, error: e2 } = await db
      .from('x402_settlements')
      .insert(baseRow(contractId, header))
      .select('id')
      .single();
    if (second?.id) createdIds.push(second.id); // should not happen; guarded so cleanup still runs

    expect(second).toBeNull();
    expect(e2?.message ?? '').toMatch(/duplicate key value violates unique constraint/i);
  });

  test('residual: the SAME X-PAYMENT settles DIFFERENT contracts (idempotency keys on contract, not payment)', async () => {
    const header = `xpay_shared_${uuidv4()}`;
    const contractA = `redteam_contract_${uuidv4()}`;
    const contractB = `redteam_contract_${uuidv4()}`;

    const { data: a, error: ea } = await db
      .from('x402_settlements')
      .insert(baseRow(contractA, header))
      .select('id')
      .single();
    expect(ea).toBeNull();
    if (a?.id) createdIds.push(a.id);

    // Same header, different contract → different idempotency_key → NOT blocked at the data layer.
    const { data: b, error: eb } = await db
      .from('x402_settlements')
      .insert(baseRow(contractB, header))
      .select('id')
      .single();
    expect(eb).toBeNull();
    if (b?.id) createdIds.push(b.id);

    expect(a?.id).toBeTruthy();
    expect(b?.id).toBeTruthy();
    expect(a?.id).not.toEqual(b?.id);
  });

  test('NULL idempotency_key rows are exempt from the partial index (legacy settlements coexist)', async () => {
    const { data: n1, error: en1 } = await db
      .from('x402_settlements')
      .insert(baseRow(null, `xpay_${uuidv4()}`))
      .select('id')
      .single();
    const { data: n2, error: en2 } = await db
      .from('x402_settlements')
      .insert(baseRow(null, `xpay_${uuidv4()}`))
      .select('id')
      .single();

    expect(en1).toBeNull();
    expect(en2).toBeNull();
    if (n1?.id) createdIds.push(n1.id);
    if (n2?.id) createdIds.push(n2.id);
    expect(n1?.id).not.toEqual(n2?.id);
  });
});
