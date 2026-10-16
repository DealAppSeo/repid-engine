/**
 * [S2-2, 2026-10-16] An agent's memory is readable in full only with a key bound to that agent.
 *
 * GET /api/v1/agents/:id/recall and /agents/:id/memory/recent were in the auth bypass and returned
 * memory content (and the metadata blob, which names counterparties and contracts) for any agent id.
 * Now both need a key. A key bound to :id reads everything. Any other key gets /memory/recent
 * metadata only, and /recall refuses it: a search leaks through scores and counts even without content.
 */
jest.mock('../src/db', () => ({ db: { from: () => ({}) } }));
jest.mock('../src/auth/api-keys', () => ({ validateAgentApiKey: jest.fn(), matchEnvOperatorKey: jest.fn(() => null) }));
jest.mock('../src/engine/agent-log', () => ({ logAgentEvent: jest.fn() }));

const retrieve = jest.fn(async () => [
  { similarity: 0.9, node: { id: 'n1', node_type: 'fact', content: 'PRIVATE MEMORY', importance: 0.5, created_at: 't', access_count: 1, metadata: { other_agent_id: 'x' } }, related_nodes: [] },
]);
jest.mock('../src/services/graph-rag/retrieval-service', () => ({
  RetrievalService: jest.fn().mockImplementation(() => ({ retrieve, retrieveScoped: jest.fn() })),
}));
jest.mock('../src/services/graph-rag/graph-rag-store', () => ({ GraphRagStore: jest.fn() }));

import express from 'express';
import request from 'supertest';
import { authMiddleware } from '../src/middleware/auth';
import { createAgentRecallRouter } from '../src/routes/agent-recall';

const AGENT = '065ad782-ea58-4078-9414-60a862d67ba1';
const OTHER = 'bbbbbbbb-1111-2222-3333-444444444444';

async function passesKeyless(path: string): Promise<boolean> {
  const req: any = { method: 'GET', path, headers: {}, query: {}, body: {} };
  const res: any = { statusCode: 0, status(c: number) { this.statusCode = c; return this; }, json() { return this; } };
  const next = jest.fn();
  await authMiddleware(req, res, next);
  return next.mock.calls.length === 1 && res.statusCode === 0;
}

describe('the memory routes are not in the auth bypass', () => {
  it.each([`/api/v1/agents/${AGENT}/recall`, `/api/v1/agents/${AGENT}/memory/recent`])('%s needs a key', async (path) => {
    expect(await passesKeyless(path)).toBe(false);
  });
  it('/lessons/recall stays public', async () => {
    expect(await passesKeyless('/api/v1/lessons/recall')).toBe(true);
  });
});

describe('behind the key, only a key bound to :id reads content', () => {
  const selects: string[] = [];
  const supabase: any = {
    from: () => {
      const chain: any = {
        select: (cols: string) => { selects.push(cols); return chain; },
        eq: () => chain,
        order: () => chain,
        limit: async () => ({
          data: [{ id: 'n1', node_type: 'fact', importance: 0.5, created_at: 't', access_count: 1, ...(selects.at(-1)!.includes('content') ? { content: 'PRIVATE MEMORY', metadata: { other_agent_id: 'x' } } : {}) }],
          error: null,
        }),
      };
      return chain;
    },
  };
  // Stands in for authMiddleware, which sets req.agent_id for an agent-bound key (and nothing for an operator key).
  const app = express();
  app.use((req, _res, next) => { const a = req.header('x-test-agent'); if (a) (req as any).agent_id = a; next(); });
  app.use('/api/v1', createAgentRecallRouter(supabase));

  beforeEach(() => { selects.length = 0; retrieve.mockClear(); });

  it('memory/recent, key bound to another agent → metadata only', async () => {
    const res = await request(app).get(`/api/v1/agents/${AGENT}/memory/recent`).set('x-test-agent', OTHER);
    expect(res.status).toBe(200);
    expect(res.body.content_withheld).toBe(true);
    expect(selects[0]).not.toMatch(/content|metadata/);
    expect(JSON.stringify(res.body)).not.toContain('PRIVATE MEMORY');
    expect(res.body.nodes[0]).toEqual({ id: 'n1', node_type: 'fact', importance: 0.5, created_at: 't', access_count: 1 });
  });

  it('memory/recent, operator key (no agent binding) → metadata only', async () => {
    const res = await request(app).get(`/api/v1/agents/${AGENT}/memory/recent`);
    expect(res.body.content_withheld).toBe(true);
    expect(JSON.stringify(res.body)).not.toContain('PRIVATE MEMORY');
  });

  it('memory/recent, key bound to :id → content', async () => {
    const res = await request(app).get(`/api/v1/agents/${AGENT}/memory/recent`).set('x-test-agent', AGENT.toUpperCase());
    expect(res.body.content_withheld).toBe(false);
    expect(res.body.nodes[0].content).toBe('PRIVATE MEMORY');
  });

  it('recall, key bound to another agent → 403 and no search runs', async () => {
    const res = await request(app).get(`/api/v1/agents/${AGENT}/recall?q=secret`).set('x-test-agent', OTHER);
    expect(res.status).toBe(403);
    expect(retrieve).not.toHaveBeenCalled();
  });

  it('recall, key bound to :id → results with content', async () => {
    const res = await request(app).get(`/api/v1/agents/${AGENT}/recall?q=secret`).set('x-test-agent', AGENT);
    expect(res.status).toBe(200);
    expect(res.body.results[0].node.content).toBe('PRIVATE MEMORY');
  });
});
