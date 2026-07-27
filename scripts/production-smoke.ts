// Uses Node's built-in global fetch (stable since Node 18; package.json engines pins >=20.9).
// This file previously imported `node-fetch`, which is not a dependency of this repo and is not
// installed — so `npm run smoke:prod` threw MODULE_NOT_FOUND on any clean checkout and the
// deterministic smoke path was dead. That is a large part of why the endpoint regression below
// went unnoticed while an LLM task "reported" the same endpoints healthy every night.

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

/**
 * `bodyMustMatch` exists because a status code alone is not evidence of a live surface.
 * The nightly LLM-driven smoke task reported `/health` 200 with the "verbatim excerpt"
 * {"deployed_commit":"abc123"} for 16 consecutive nights — a status-only check would have
 * called that a pass. Asserting the SHAPE of the payload is what makes the check
 * un-fakeable by a narrator: a real deployed_commit is 40 hex chars, and no amount of
 * plausible prose produces one. See reports/2026-07-27/BEAT30_*.
 */
interface SmokeTest {
  path: string;
  method: string;
  body?: any;
  expected: number[];
  notes?: string;
  /** Response body must match this, or the check fails even on an expected status. */
  bodyMustMatch?: RegExp;
}

async function runSmoke(): Promise<TestResult[]> {
  const results: TestResult[] = [];

  const tests: SmokeTest[] = [
    // Discovery
    { path: '/openapi.json', method: 'GET', expected: [200] },
    { path: '/.well-known/agent.json', method: 'GET', expected: [200] },
    { path: '/ai-plugin.json', method: 'GET', expected: [200, 301] },
    
    // Agents
    { path: '/api/v1/agents/register', method: 'POST', body: { agent_name: 'smoke' }, expected: [201, 429] },
    { path: `/api/v1/agents/${TEST_AGENT}/card`, method: 'GET', expected: [200, 404] },
    { path: `/api/v1/agents/${TEST_AGENT}/keys`, method: 'GET', expected: [401] },
    
    // HAL & Scoring
    { path: '/api/v1/llm/complete', method: 'POST', body: { prompt: 'hi' }, expected: [401, 403] },
    { path: `/api/v1/agents-external/${TEST_AGENT}/score-event`, method: 'POST', body: { prompt: 'a', answer: 'b' }, expected: [200, 400, 404] },
    { path: '/api/v1/hal/stats', method: 'GET', expected: [200] },
    { path: '/api/v1/metrics', method: 'GET', expected: [200] },
    
    // ERC-8004 & ZKP
    { path: `/api/v1/repid/${TEST_AGENT}`, method: 'GET', expected: [200, 404] },
    { path: `/api/v1/repid/${TEST_AGENT}/history`, method: 'GET', expected: [200, 404] },
    { path: '/api/v1/repid/verify', method: 'POST', body: {}, expected: [400] },
    { path: `/api/v1/erc8004/validate/${TEST_AGENT}`, method: 'GET', expected: [200, 404] },
    { path: '/api/v1/prove-repid', method: 'POST', body: {}, expected: [400, 404] },
    
    // x402
    { path: '/api/v1/tip/request', method: 'POST', body: {}, expected: [400] },
    { path: '/api/v1/tip/deliver/tip_123', method: 'POST', expected: [402, 404] },
    
    // Bounties
    { path: '/bounties', method: 'GET', expected: [200] },
    
    // Audit & Network
    { path: '/api/v1/audit/verify', method: 'GET', expected: [200] },
    { path: '/api/v1/network/status', method: 'GET', expected: [501] },

    // Public value-loop — the keyless surfaces a visitor actually lands on. These are the
    // endpoints the nightly LLM smoke task was asked to check and never did (18/18 reports
    // carried invented statuses or no measurement at all). Body assertions, not just codes.
    {
      path: '/health', method: 'GET', expected: [200],
      // The exact field the fabricated reports rendered as "abc123".
      bodyMustMatch: /"deployed_commit"\s*:\s*"[0-9a-f]{40}"/,
      notes: 'deployed_commit must be a real 40-hex sha'
    },
    {
      path: '/api/v1/leaderboard', method: 'GET', expected: [200],
      bodyMustMatch: /"providers"\s*:\s*\[/,
      notes: 'provider trust ranking (NOT /api/v1/repid/leaderboard — that path does not exist)'
    },
    {
      path: '/api/v1/stats', method: 'GET', expected: [200],
      bodyMustMatch: /"real_proofs"\s*:\s*\d+/,
      notes: 'public stats counters'
    },
    {
      path: '/api/v1/marketplace/browse', method: 'GET', expected: [200],
      bodyMustMatch: /"listings"\s*:\s*\[/,
      notes: 'PUBLIC keyless TrustMarket browse — 500s while marketplace_listings is absent from prod (scripts/test-schema/marketplace.sql is Sean-gated)'
    }
  ];

  for (const t of tests) {
    try {
      const res = await fetch(`${BASE}${t.path}`, {
        method: t.method,
        headers: t.body ? { 'Content-Type': 'application/json' } : {},
        body: t.body ? JSON.stringify(t.body) : undefined,
        redirect: 'manual'
      });
      const statusOk = t.expected.includes(res.status);
      // Only read the body when something asserts on it — keeps existing checks byte-identical.
      let bodyOk = true;
      let bodyNote: string | undefined;
      if (statusOk && t.bodyMustMatch) {
        const text = await res.text();
        bodyOk = t.bodyMustMatch.test(text);
        if (!bodyOk) {
          bodyNote = `body did not match ${t.bodyMustMatch} — got: ${text.slice(0, 120)}`;
        }
      }
      results.push({
        endpoint: t.path,
        method: t.method,
        status: res.status,
        expected: t.expected,
        pass: statusOk && bodyOk,
        notes: bodyNote ?? t.notes
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
