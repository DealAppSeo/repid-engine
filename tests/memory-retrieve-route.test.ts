/**
 * memory-retrieve-route.test.ts — HTTP contract for GET /memory/retrieve (backlog item 3's
 * retrieval half). Exercises the route the way a real caller would: no import of
 * retrieveVerifiedMemory directly, just a mocked `db` and an `agent_id` the same way
 * middleware/auth.ts attaches it.
 */
import express from 'express';
import request from 'supertest';
import { LeanIMTPlus } from '../src/memory/leanimt-plus';
import { encodeEntry, type MemoryEntry } from '../src/memory/proof-carrying-memory';
import { poseidon2LeafHash } from '../src/zkp/poseidon2-leaf';

const AGENT_ID = 'agent-123';

interface Db {
  roots: Array<{ agent_id: string; epoch: number; root: string }>;
  leaves: Array<{ agent_id: string; root_epoch: number; leaf_index: number; value: string; next: string; tombstoned: boolean }>;
  content: Array<{ agent_id: string; value: string; content: string; source_id: string; source_repid: number; hal_verdict: string; epoch: number }>;
}
const state: Db = { roots: [], leaves: [], content: [] };

function makeQuery(table: string) {
  const filters: Record<string, unknown> = {};
  const q: any = {};
  q.select = () => q;
  q.eq = (col: string, val: unknown) => {
    filters[col] = val;
    return q;
  };
  q.order = () => q;
  q.limit = () => q;
  q.maybeSingle = async () => {
    const rows = (state.roots as any[]).filter((r) => Object.entries(filters).every(([k, v]) => r[k] === v));
    rows.sort((a, b) => b.epoch - a.epoch);
    return { data: rows[0] ?? null, error: null };
  };
  q.then = (resolve: any) => {
    const source = table === 'agent_memory_leaves' ? state.leaves : table === 'agent_memory_leaf_content' ? state.content : [];
    const rows = (source as any[]).filter((r) => Object.entries(filters).every(([k, v]) => r[k] === v));
    return resolve({ data: rows, error: null });
  };
  return q;
}

jest.mock('../src/db', () => ({ db: { from: (t: string) => makeQuery(t) } }));

// eslint-disable-next-line import/first
import memoryRetrieveRouter from '../src/routes/memory-retrieve';

function makeApp(agentId?: string) {
  const app = express();
  app.use((req: any, _res, next) => {
    if (agentId) req.agent_id = agentId;
    next();
  });
  app.use('/api/v1', memoryRetrieveRouter);
  return app;
}

function entry(content: string): MemoryEntry {
  return { content, source_id: 'agent-1', source_repid: 1200, hal_verdict: 'clean', epoch: 3 };
}

beforeEach(() => {
  state.roots = [];
  state.leaves = [];
  state.content = [];
});

describe('GET /api/v1/memory/retrieve', () => {
  it('403s a caller with no bound agent identity (env-allowlist key)', async () => {
    const res = await request(makeApp(undefined)).get('/api/v1/memory/retrieve');
    expect(res.status).toBe(403);
  });

  it('returns an empty result when the agent has no committed root yet', async () => {
    const res = await request(makeApp(AGENT_ID)).get('/api/v1/memory/retrieve');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ root: null, entries: [] });
  });

  it('returns verified entries with witnesses for a real committed epoch', async () => {
    const tree = new LeanIMTPlus();
    const entryA = entry('the sky is blue');
    const entryB = entry('water is wet');
    const valueA = poseidon2LeafHash(encodeEntry(entryA));
    const valueB = poseidon2LeafHash(encodeEntry(entryB));
    tree.insert(BigInt(valueA));
    tree.insert(BigInt(valueB));

    state.roots.push({ agent_id: AGENT_ID, epoch: 1, root: tree.root() });
    tree.leafSet().forEach((l, i) => {
      state.leaves.push({ agent_id: AGENT_ID, root_epoch: 1, leaf_index: i, value: l.value.toString(), next: l.next.toString(), tombstoned: l.tombstoned });
    });
    state.content.push({ agent_id: AGENT_ID, value: valueA, ...entryA });
    state.content.push({ agent_id: AGENT_ID, value: valueB, ...entryB });

    const res = await request(makeApp(AGENT_ID)).get('/api/v1/memory/retrieve');
    expect(res.status).toBe(200);
    expect(res.body.root).toBe(tree.root());
    expect(res.body.entries).toHaveLength(2);
    expect(res.body.entries.map((e: any) => e.entry.content).sort()).toEqual(['the sky is blue', 'water is wet']);
    // wire format: bigint leaf fields travel as decimal strings
    expect(typeof res.body.entries[0].inclusionProof.leaf.value).toBe('string');
  });

  it('never reads an agent id off the request itself — only the auth-attached identity is used', async () => {
    const tree = new LeanIMTPlus();
    const entryA = entry('victim secret');
    const valueA = poseidon2LeafHash(encodeEntry(entryA));
    tree.insert(BigInt(valueA));
    state.roots.push({ agent_id: 'victim-agent', epoch: 1, root: tree.root() });
    tree.leafSet().forEach((l, i) => {
      state.leaves.push({ agent_id: 'victim-agent', root_epoch: 1, leaf_index: i, value: l.value.toString(), next: l.next.toString(), tombstoned: l.tombstoned });
    });
    state.content.push({ agent_id: 'victim-agent', value: valueA, ...entryA });

    const app = makeApp(AGENT_ID);
    const res = await request(app).get('/api/v1/memory/retrieve').query({ agent_id: 'victim-agent' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ root: null, entries: [] });
  });
});
