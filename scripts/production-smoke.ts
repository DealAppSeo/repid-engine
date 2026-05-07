import fetch from 'node-fetch';

const BASE = process.env.SMOKE_BASE_URL || 'https://repid-engine-production.up.railway.app';
const TEST_AGENT = process.env.SMOKE_TEST_AGENT || 'c2aab664-2c47-4418-bda5-e274098738d1';

interface TestResult {
  endpoint: string;
  method: string;
  status: number;
  expected: number[];
  pass: boolean;
  notes?: string;
}

async function runSmoke(): Promise<TestResult[]> {
  const results: TestResult[] = [];

  const tests: Array<{ path: string; method: string; body?: any; expected: number[]; notes?: string }> = [
    // Discovery
    { path: '/openapi.json', method: 'GET', expected: [200] },
    { path: '/.well-known/agent.json', method: 'GET', expected: [200] },
    { path: '/ai-plugin.json', method: 'GET', expected: [200] },
    
    // Agents
    { path: '/api/v1/agents/register', method: 'POST', body: { agent_name: 'smoke' }, expected: [201, 429] },
    { path: `/api/v1/agents/${TEST_AGENT}/card`, method: 'GET', expected: [200, 404] },
    { path: `/api/v1/agents/${TEST_AGENT}/keys`, method: 'GET', expected: [401] },
    
    // HAL & Scoring
    { path: '/api/v1/llm/complete', method: 'POST', body: { prompt: 'hi' }, expected: [401] },
    { path: `/api/v1/agents-external/${TEST_AGENT}/score-event`, method: 'POST', body: { prompt: 'a', answer: 'b' }, expected: [400, 404] },
    { path: '/api/v1/hal/stats', method: 'GET', expected: [200] },
    { path: '/api/v1/metrics', method: 'GET', expected: [200] },
    
    // ERC-8004 & ZKP
    { path: `/api/v1/repid/${TEST_AGENT}`, method: 'GET', expected: [200, 404] },
    { path: `/api/v1/repid/${TEST_AGENT}/history`, method: 'GET', expected: [200, 404] },
    { path: '/api/v1/repid/verify', method: 'POST', body: {}, expected: [400] },
    { path: `/api/v1/erc8004/validate/${TEST_AGENT}`, method: 'GET', expected: [200, 404] },
    { path: '/api/v1/prove-repid', method: 'POST', body: { agent_id: TEST_AGENT }, expected: [400, 404] },
    
    // x402
    { path: '/api/v1/tip/request', method: 'POST', body: {}, expected: [400] },
    { path: '/api/v1/tip/deliver/tip_123', method: 'POST', expected: [402, 404] },
    
    // Bounties
    { path: '/bounties', method: 'GET', expected: [200] },
    
    // Audit & Network
    { path: '/api/v1/audit/verify', method: 'GET', expected: [200] },
    { path: '/api/v1/network/status', method: 'GET', expected: [501] }
  ];

  for (const t of tests) {
    try {
      const res = await fetch(`${BASE}${t.path}`, {
        method: t.method,
        headers: t.body ? { 'Content-Type': 'application/json' } : {},
        body: t.body ? JSON.stringify(t.body) : undefined
      });
      const pass = t.expected.includes(res.status);
      results.push({
        endpoint: t.path,
        method: t.method,
        status: res.status,
        expected: t.expected,
        pass,
        notes: t.notes
      });
    } catch (err: any) {
      results.push({
        endpoint: t.path,
        method: t.method,
        status: 0,
        expected: t.expected,
        pass: false,
        notes: err.message
      });
    }
  }

  return results;
}

const main = async () => {
  console.log(`\nStarting Production Smoke Test against ${BASE}...`);
  const results = await runSmoke();
  const failures = results.filter(r => !r.pass);
  
  console.log(`\n=== SMOKE RESULTS: ${results.length - failures.length}/${results.length} pass ===\n`);
  
  for (const r of results) {
    const statusStr = r.status === 0 ? 'ERR' : r.status.toString();
    console.log(`${r.pass ? '✅' : '❌'} ${r.method.padEnd(4)} ${r.endpoint.padEnd(50)} → ${statusStr.padStart(3)} (expected ${r.expected.join('|')})${r.notes ? ' — ' + r.notes : ''}`);
  }

  if (failures.length > 0) {
    console.log(`\n❌ ${failures.length} failures detected.`);
    process.exit(1);
  } else {
    console.log(`\n✅ All clear!`);
    process.exit(0);
  }
};

main();
