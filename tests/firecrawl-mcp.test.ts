/**
 * Firecrawl MCP real-client — unit tests (CC2 2026-05-26).
 * Covers: registry miss, access scope, per-agent rate limit, missing API key (graceful),
 * successful real call + cost tracking, and non-firecrawl regression (stub unchanged).
 * db + constitutional-audit are mocked via a call-time global holder (no hoist/TDZ issues);
 * global.fetch is mocked per test.
 */
jest.mock('../src/db', () => ({
  db: {
    from: (table: string) => {
      const st = (global as any).__mcpMock || {};
      const h = st[table] || {};
      const chain: any = {
        select: () => chain,
        insert: (v: any) => { if (h._insert) h._insert(v); return Promise.resolve({ error: null }); },
        update: () => chain,
        eq: () => chain,
        gte: () => chain,
        single: () => Promise.resolve(h.single ?? { data: null }),
        then: (res: any, rej: any) => Promise.resolve(h.await ?? { count: 0, data: [] }).then(res, rej),
      };
      return chain;
    },
  },
}));
jest.mock('../src/layers/constitutional-audit', () => ({
  auditConstitutionalCompliance: async () =>
    (global as any).__mcpAudit ?? { passed: true, complianceScore: 1, easAttestationId: 'eas-test' },
}));

import { callMCPWithGuardrails } from '../src/engine/mcp';

const NEXUS = '848da285-93c5-4e99-a989-3d9e49ebed09'; // in default Firecrawl scope
const OUTSIDER = '00000000-0000-0000-0000-000000000999';

const firecrawlTool = {
  tool_name: 'firecrawl', approved: true, constitutional_cue: 'cue',
  repid_bonus: 6, requires_conservator_approval: false, usage_count: 0,
};

function setMock(tables: any, audit?: any) {
  (global as any).__mcpMock = tables;
  (global as any).__mcpAudit = audit ?? { passed: true, complianceScore: 1, easAttestationId: 'eas-test' };
}

afterEach(() => {
  delete (global as any).__mcpMock;
  delete (global as any).__mcpAudit;
  delete process.env.FIRECRAWL_API_KEY;
  (global as any).fetch = undefined;
});

test('tool not in registry → blocked', async () => {
  setMock({ repid_mcp_tools: { single: { data: null } } });
  const r = await callMCPWithGuardrails({ agentId: NEXUS, toolName: 'firecrawl', params: {} });
  expect(r.allowed).toBe(false);
  expect(r.blockedReason).toMatch(/not in approved MCP registry/);
});

test('firecrawl: agent outside access scope → blocked', async () => {
  setMock({ repid_mcp_tools: { single: { data: firecrawlTool } } });
  const r = await callMCPWithGuardrails({ agentId: OUTSIDER, toolName: 'firecrawl', params: { query: 'x' } });
  expect(r.allowed).toBe(false);
  expect(r.blockedReason).toMatch(/outside the Firecrawl access scope/);
});

test('firecrawl: per-agent rate limit → blocked', async () => {
  setMock({
    repid_mcp_tools: { single: { data: firecrawlTool } },
    trinity_tool_usage: { await: { count: 99 } },
  });
  const r = await callMCPWithGuardrails({ agentId: NEXUS, toolName: 'firecrawl', params: { query: 'x' } });
  expect(r.allowed).toBe(false);
  expect(r.blockedReason).toMatch(/rate limit reached/);
});

test('firecrawl: missing API key → graceful block (no fetch)', async () => {
  const inserts: any[] = [];
  setMock({
    repid_mcp_tools: { single: { data: firecrawlTool }, await: {} },
    trinity_tool_usage: { await: { count: 0 }, _insert: (v: any) => inserts.push(v) },
  });
  const fetchSpy = jest.fn();
  (global as any).fetch = fetchSpy;
  const r = await callMCPWithGuardrails({ agentId: NEXUS, toolName: 'firecrawl', params: { query: 'x' } });
  expect(r.allowed).toBe(false);
  expect(r.blockedReason).toMatch(/FIRECRAWL_API_KEY not configured/);
  expect(fetchSpy).not.toHaveBeenCalled();
  // usage still logged (for the audit trail), with ok=false
  expect(inserts.length).toBe(1);
  expect(inserts[0].outcome.ok).toBe(false);
});

test('firecrawl: success → real call, cost tracked in usage outcome', async () => {
  const inserts: any[] = [];
  setMock({
    repid_mcp_tools: { single: { data: firecrawlTool }, await: {} },
    trinity_tool_usage: { await: { count: 0 }, _insert: (v: any) => inserts.push(v) },
  });
  process.env.FIRECRAWL_API_KEY = 'fc-test';
  (global as any).fetch = jest.fn(async () => ({
    ok: true,
    status: 200,
    json: async () => ({ data: [{ title: 'res' }], creditsUsed: 5 }),
  }));
  const r = await callMCPWithGuardrails({ agentId: NEXUS, toolName: 'firecrawl', params: { query: 'mcp cost tracking', limit: 5 } });
  expect(r.allowed).toBe(true);
  expect((r.result as any).firecrawl).toBe(true);
  expect(r.costUsd).toBeGreaterThan(0);
  expect(inserts.length).toBe(1);
  expect(inserts[0].outcome.cost_credits).toBe(5);
  expect(inserts[0].outcome.cost_usd).toBeCloseTo(5 * 0.00083, 6);
  expect(inserts[0].outcome.query).toBe('mcp cost tracking');
});

test('non-firecrawl tool → Phase-1 stub unchanged (no regression)', async () => {
  const githubTool = { ...firecrawlTool, tool_name: 'github', repid_bonus: 8, usage_count: 1 };
  setMock({
    repid_mcp_tools: { single: { data: githubTool }, await: {} },
    trinity_tool_usage: { await: { count: 0 }, _insert: () => {} },
  });
  const fetchSpy = jest.fn();
  (global as any).fetch = fetchSpy;
  const r = await callMCPWithGuardrails({ agentId: OUTSIDER, toolName: 'github', params: {} });
  expect(r.allowed).toBe(true);
  expect((r.result as any).stub).toBe(true);
  expect(fetchSpy).not.toHaveBeenCalled();
});
