/**
 * memory-walk-verify-route.test.ts — HTTP contract for POST /memory/verify-walk (backlog item 12
 * HTTP layer). Tests the route via supertest with a mocked db; does not import the pure verifier
 * directly — verifies the HTTP boundary, auth contract, and serialization.
 */
import express from 'express';
import request from 'supertest';
import { LeanIMTPlus } from '../src/memory/leanimt-plus';
import { entityLeafValue, graphEdgeHash } from '../src/memory/graphrag-leaf-schema';

const AGENT_ID = 'agent-walk-123';

interface Db {
  roots: Array<{ agent_id: string; epoch: number; root: string }>;
  leaves: Array<{ agent_id: string; root_epoch: number; leaf_index: number; value: string; next: string; tombstoned: boolean }>;
}
const state: Db = { roots: [], leaves: [] };

function makeQuery(table: string) {
  const filters: Record<string, unknown> = {};
  const q: any = {};
  q.select = () => q;
  q.eq = (col: string, val: unknown) => { filters[col] = val; return q; };
  q.order = () => q;
  q.limit = () => q;
  q.maybeSingle = async () => {
    const rows = state.roots.filter((r) => Object.entries(filters).every(([k, v]) => (r as any)[k] === v));
    rows.sort((a, b) => b.epoch - a.epoch);
    return { data: rows[0] ?? null, error: null };
  };
  q.then = (resolve: any) => {
    const source = table === 'agent_memory_leaves' ? state.leaves : [];
    const rows = (source as any[]).filter((r) => Object.entries(filters).every(([k, v]) => r[k] === v));
    return resolve({ data: rows, error: null });
  };
  return q;
}

jest.mock('../src/db', () => ({ db: { from: (t: string) => makeQuery(t) } }));

// eslint-disable-next-line import/first
import memoryWalkVerifyRouter from '../src/routes/memory-walk-verify';

function makeApp(agentId?: string) {
  const app = express();
  app.use(express.json());
  app.use((req: any, _res, next) => { if (agentId) req.agent_id = agentId; next(); });
  app.use('/api/v1', memoryWalkVerifyRouter);
  return app;
}

function seedTree(agentId: string, values: bigint[]): LeanIMTPlus {
  const tree = new LeanIMTPlus();
  for (const v of values) tree.insert(v);
  state.roots.push({ agent_id: agentId, epoch: 1, root: tree.root() });
  tree.leafSet().forEach((l, i) => {
    state.leaves.push({ agent_id: agentId, root_epoch: 1, leaf_index: i, value: l.value.toString(), next: l.next.toString(), tombstoned: l.tombstoned });
  });
  return tree;
}

beforeEach(() => { state.roots = []; state.leaves = []; });

describe('POST /api/v1/memory/verify-walk', () => {
  it('403s when no agent identity is bound to the key', async () => {
    const res = await request(makeApp(undefined)).post('/api/v1/memory/verify-walk').send({ steps: [] });
    expect(res.status).toBe(403);
  });

  it('400s when steps is missing or not an array', async () => {
    const app = makeApp(AGENT_ID);
    let res = await request(app).post('/api/v1/memory/verify-walk').send({});
    expect(res.status).toBe(400);
    res = await request(app).post('/api/v1/memory/verify-walk').send({ steps: 'bad' });
    expect(res.status).toBe(400);
  });

  it('409s when the agent has no committed memory root', async () => {
    const res = await request(makeApp(AGENT_ID)).post('/api/v1/memory/verify-walk').send({ steps: [] });
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/no committed memory root/);
  });

  it('returns valid:true for an empty walk (no steps)', async () => {
    const valA = BigInt(entityLeafValue({ entity_id: 'e1', name: 'Alice', entity_type: 'person', description: '', embedding_hash: 'aaa', epoch: 1 }));
    seedTree(AGENT_ID, [valA]);
    const res = await request(makeApp(AGENT_ID)).post('/api/v1/memory/verify-walk').send({ steps: [] });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ valid: true, steps: [] });
  });

  it('returns valid:true for a single valid hop whose nodes are in the tree', async () => {
    const fromVal = BigInt(entityLeafValue({ entity_id: 'e1', name: 'Alice', entity_type: 'person', description: '', embedding_hash: 'aaa', epoch: 1 }));
    const toVal = BigInt(entityLeafValue({ entity_id: 'e2', name: 'Bob', entity_type: 'person', description: '', embedding_hash: 'bbb', epoch: 1 }));
    seedTree(AGENT_ID, [fromVal, toVal]);
    const step = {
      from_value: fromVal.toString(),
      relation_type: 'knows',
      to_value: toVal.toString(),
      edge_hash: graphEdgeHash({ from_value: fromVal.toString(), relation_type: 'knows', to_value: toVal.toString() }),
    };
    const res = await request(makeApp(AGENT_ID)).post('/api/v1/memory/verify-walk').send({ steps: [step] });
    expect(res.status).toBe(200);
    expect(res.body.valid).toBe(true);
    expect(res.body.steps).toHaveLength(1);
    expect(res.body.steps[0].edgeHashValid).toBe(true);
    expect(res.body.steps[0].fromNodeIncluded).toBe(true);
    expect(res.body.steps[0].toNodeIncluded).toBe(true);
  });

  it('returns valid:false with failAt:0 for a step with a tampered edge_hash', async () => {
    const fromVal = BigInt(entityLeafValue({ entity_id: 'e1', name: 'Alice', entity_type: 'person', description: '', embedding_hash: 'aaa', epoch: 1 }));
    const toVal = BigInt(entityLeafValue({ entity_id: 'e2', name: 'Bob', entity_type: 'person', description: '', embedding_hash: 'bbb', epoch: 1 }));
    seedTree(AGENT_ID, [fromVal, toVal]);
    const step = {
      from_value: fromVal.toString(),
      relation_type: 'knows',
      to_value: toVal.toString(),
      edge_hash: '0x000bad000',  // tampered
    };
    const res = await request(makeApp(AGENT_ID)).post('/api/v1/memory/verify-walk').send({ steps: [step] });
    expect(res.status).toBe(200);
    expect(res.body.valid).toBe(false);
    expect(res.body.failAt).toBe(0);
    expect(res.body.steps[0].edgeHashValid).toBe(false);
  });

  it('returns valid:false with failAt:0 when from_value is not in the tree', async () => {
    const fromVal = BigInt(entityLeafValue({ entity_id: 'e1', name: 'Alice', entity_type: 'person', description: '', embedding_hash: 'aaa', epoch: 1 }));
    const toVal = BigInt(entityLeafValue({ entity_id: 'e2', name: 'Bob', entity_type: 'person', description: '', embedding_hash: 'bbb', epoch: 1 }));
    // Only insert toVal — fromVal is absent from this agent's tree
    seedTree(AGENT_ID, [toVal]);
    const step = {
      from_value: fromVal.toString(),
      relation_type: 'knows',
      to_value: toVal.toString(),
      edge_hash: graphEdgeHash({ from_value: fromVal.toString(), relation_type: 'knows', to_value: toVal.toString() }),
    };
    const res = await request(makeApp(AGENT_ID)).post('/api/v1/memory/verify-walk').send({ steps: [step] });
    expect(res.status).toBe(200);
    expect(res.body.valid).toBe(false);
    expect(res.body.failAt).toBe(0);
    expect(res.body.steps[0].fromNodeIncluded).toBe(false);
  });
});
