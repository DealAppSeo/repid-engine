import { summarize } from '../src/routes/costs';
import { isFreeProvider, frontierCostEstimate } from '../src/billing/free-providers';

const call = (over: any = {}) => ({
  provider: 'groq', model: 'llama-3.1-8b-instant',
  prompt_tokens: 100, completion_tokens: 50, total_tokens: 150,
  cost_usd: 0.0001, agent_id: 'trinity-veritas', task_hint: 'peer_verify', status: 'success', ...over,
});

const s = summarize([call({ provider: 'groq' }), call({ provider: 'anthropic', cost_usd: 0.01 })]);
console.log('isFree(groq):', isFreeProvider('groq'));
console.log('isFree(anthropic):', isFreeProvider('anthropic'));
console.log('frontierCostEstimate(100, 50):', frontierCostEstimate(100, 50));
console.log('result s:', JSON.stringify(s, null, 2));
