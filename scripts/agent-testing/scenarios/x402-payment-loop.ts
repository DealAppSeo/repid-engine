import { Scenario, ScenarioContext } from '../framework';
import { freeComplete } from '../free-llm-router';

/**
 * Scenario 1 — x402 payment loop.
 * Buyer agent requests a tip from a provider; asserts the mounted x402 surface
 * answers a 402 challenge and guards delivery until payment is presented.
 * Completing real settlement needs a signed EIP-3009 authorization + funded
 * wallet (out of scope for free dogfooding); this asserts the wiring is live.
 */
export const x402PaymentLoop: Scenario = {
  name: 'x402-payment-loop',
  description: 'Buyer requests a tip; x402 returns 402 + accepts; deliver is payment-guarded.',
  async run(ctx: ScenarioContext) {
    const provider = process.env.TEST_PROVIDER_AGENT_ID;
    const requestor = process.env.TEST_REQUESTOR_AGENT_ID;
    if (!provider || !requestor) {
      return { pass: false, skip: true, reason: 'set TEST_PROVIDER_AGENT_ID + TEST_REQUESTOR_AGENT_ID (repid_agents UUIDs) to run' };
    }

    // Dogfood the free LLM: the buyer agent picks a prediction topic.
    let topic = 'BTC 24h direction';
    const llm = await freeComplete('In 6 words or fewer, name one crypto market prediction topic.', { maxTokens: 24 });
    if (llm.ok && llm.text) {
      topic = llm.text.replace(/\s+/g, ' ').trim().slice(0, 80);
      ctx.log(`buyer (via ${llm.provider}) chose topic: "${topic}"`);
    } else {
      ctx.log(`free LLM unavailable (${llm.error}); using default topic`);
    }

    // 1. Request → expect HTTP 402 with an `accepts` array.
    const req = await ctx.http.post('/api/v1/tip/request', {
      requestor_agent_id: requestor,
      provider_agent_id: provider,
      prediction_topic: topic,
    });
    if (req.status !== 402) {
      return { pass: false, reason: `expected 402 from /tip/request, got ${req.status}`, details: { body: req.body, err: req.error } };
    }
    const tipId = req.body?.tip_id;
    const accepts = req.body?.accepts;
    if (!tipId || !Array.isArray(accepts) || accepts.length === 0) {
      return { pass: false, reason: '402 response missing tip_id / accepts[]', details: { body: req.body } };
    }
    ctx.log(`402 received: tip_id=${tipId}, is_simulated=${req.body?.is_simulated}`);

    // 2. Deliver without an X-PAYMENT header → must be refused (payment guard).
    //    We intentionally do NOT inject a signed authorization (needs a funded wallet).
    const del = await ctx.http.post(`/api/v1/tip/deliver/${tipId}`, {});
    const guarded = del.status === 402 || !!del.body?.error;
    return {
      pass: guarded,
      reason: guarded
        ? 'x402 surface live: 402 challenge issued + delivery payment-guarded (full settlement needs a funded wallet)'
        : `deliver was not payment-guarded (status ${del.status})`,
      details: { tipId, requestStatus: req.status, deliverStatus: del.status, deliverBody: del.body },
    };
  },
};
