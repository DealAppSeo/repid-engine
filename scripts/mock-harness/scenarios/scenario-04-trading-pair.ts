/**
 * Scenario 04 — Trading Pair (canonical agent-to-agent value exchange).
 *
 * Two mock agents PAIR_A (buyer) and PAIR_B (seller). PAIR_A asks PAIR_B a
 * question. PAIR_B answers. Both adjust RepID based on the interaction.
 *
 * This is the foundation for Phase 8's full-loop demo. Scenario 04 stages
 * the lifecycle WITHOUT x402 settlement (mocked locally). The full-loop demo
 * adds the actual x402 wrapper.
 *
 * Validates: agent-to-agent interaction shape, paired RepID adjustment,
 * teardown of two agents in one run.
 */

import 'dotenv/config';
import { MockAgent } from '../mock-agent';

(async () => {
  const ts = Date.now();
  const buyer = new MockAgent(`mock-pair-buyer-${ts}`, 'uncertain');
  const seller = new MockAgent(`mock-pair-seller-${ts}`, 'constitutional');

  console.log(`[scenario-04] bootstrapping pair...`);
  await buyer.bootstrap();
  await seller.bootstrap();
  console.log(`[scenario-04] buyer: ${buyer.state.agent_name} repid=${buyer.state.current_repid}`);
  console.log(`[scenario-04] seller: ${seller.state.agent_name} repid=${seller.state.current_repid}`);

  // BUYER asks question → SELLER answers → BUYER evaluates
  const question = 'What is the current ETH price?';
  console.log(`[scenario-04] BUYER asks: "${question}"`);
  const decision = seller.makeDecision(question);
  console.log(`[scenario-04] SELLER decision: ${decision.decision} confidence=${decision.confidence} reasoning=${decision.reasoning}`);

  // Mocked answer quality: if seller is constitutional and refused, answer is "I can't answer that with confidence"
  // (HAL would score this as low hallucination risk — caller awards +5)
  // If seller executed, answer is "$3,247.50" (HAL would have to verify; for mock, assume good answer)
  const answerQualityGood = decision.decision === 'REFUSED' || decision.confidence > 0.7;
  const sellerDelta = answerQualityGood ? +5 : -3;
  const buyerDelta = +1; // small RepID for the buyer per Sprint 3's "decisive action" branch

  // SELLER earns from answer quality
  await seller.recordEvent('AGENT_TEACHING', sellerDelta, {
    role: 'seller',
    question_snippet: question.slice(0, 50),
    answer_quality: answerQualityGood ? 'good' : 'flagged',
    counterparty: buyer.state.agent_name,
  });
  console.log(`[scenario-04] SELLER repid: ${seller.state.current_repid} (delta: +${sellerDelta})`);

  // BUYER earns small RepID for participating constructively
  await buyer.recordEvent('AGENT_TEACHING', buyerDelta, {
    role: 'buyer',
    question_snippet: question.slice(0, 50),
    counterparty: seller.state.agent_name,
  });
  console.log(`[scenario-04] BUYER repid: ${buyer.state.current_repid} (delta: +${buyerDelta})`);

  console.log(`[scenario-04] tearing down pair...`);
  await buyer.teardown();
  await seller.teardown();
  console.log(`[scenario-04] DONE`);
})().catch((e) => { console.error('scenario-04 crashed:', e); process.exit(1); });
