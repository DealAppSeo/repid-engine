/**
 * proof-carrying-emit-route.test.ts — HTTP contract for POST /proof-carrying/emit (backlog
 * item 4's persisted-retrieval emit gate). Exercises the route the way a real caller would:
 * no import of bindAnswerFromRetrieval directly, just a mocked `db` and an `agent_id` the
 * same way middleware/auth.ts attaches it — same fixture shape as memory-retrieve-route.test.ts.
 */
import express from 'express';
import request from 'supertest';
import { LeanIMTPlus } from '../src/memory/leanimt-plus';
import { verifyProofCarryingAnswer, encodeEntry, type MemoryEntry } from '../src/memory/proof-carrying-memory';
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
import proofCarryingEmitRouter from '../src/routes/proof-carrying-emit';

function makeApp(agentId?: string) {
  const app = express();
  app.use(express.json());
  app.use((req: any, _res, next) => {
    if (agentId) req.agent_id = agentId;
    next();
  });
  app.use('/api/v1/proof-carrying', proofCarryingEmitRouter);
  return app;
}

function entry(content: string): MemoryEntry {
  return { content, source_id: 'agent-1', source_repid: 1200, hal_verdict: 'clean', epoch: 3 };
}

function seedCommittedEntries(agentId: string, entries: MemoryEntry[]): { root: string; values: string[] } {
  const tree = new LeanIMTPlus();
  const values = entries.map((e) => poseidon2LeafHash(encodeEntry(e)));
  values.forEach((v) => tree.insert(BigInt(v)));
  state.roots.push({ agent_id: agentId, epoch: 1, root: tree.root() });
  tree.leafSet().forEach((l, i) => {
    state.leaves.push({ agent_id: agentId, root_epoch: 1, leaf_index: i, value: l.value.toString(), next: l.next.toString(), tombstoned: l.tombstoned });
  });
  entries.forEach((e, i) => state.content.push({ agent_id: agentId, value: values[i]!, ...e }));
  return { root: tree.root(), values };
}

beforeEach(() => {
  state.roots = [];
  state.leaves = [];
  state.content = [];
});

describe('POST /api/v1/proof-carrying/emit', () => {
  it('403s a caller with no bound agent identity (env-allowlist key)', async () => {
    const res = await request(makeApp(undefined))
      .post('/api/v1/proof-carrying/emit')
      .send({ answer: 'claim', cited_values: ['x'] });
    expect(res.status).toBe(403);
  });

  it('400s when the answer or cited_values are missing/malformed', async () => {
    const res = await request(makeApp(AGENT_ID)).post('/api/v1/proof-carrying/emit').send({ answer: 'claim', cited_values: [] });
    expect(res.status).toBe(400);
  });

  it('abstains with 409 when the agent has no committed memory root yet', async () => {
    const res = await request(makeApp(AGENT_ID))
      .post('/api/v1/proof-carrying/emit')
      .send({ answer: 'claim', cited_values: ['x'] });
    expect(res.status).toBe(409);
  });

  it('emits a bound, verifiable answer when every cited value is a real committed entry', async () => {
    const { values } = seedCommittedEntries(AGENT_ID, [entry('the sky is blue'), entry('water is wet')]);
    const res = await request(makeApp(AGENT_ID))
      .post('/api/v1/proof-carrying/emit')
      .send({ answer: 'the sky is blue and water is wet', cited_values: values });
    expect(res.status).toBe(200);
    expect(res.body.citations).toHaveLength(2);
    // wire format: bigint leaf fields travel as decimal strings
    expect(typeof res.body.citations[0].witness.leaf.value).toBe('string');
    const revived = {
      ...res.body,
      citations: res.body.citations.map((c: any) => ({
        ...c,
        witness: { ...c.witness, leaf: { ...c.witness.leaf, value: BigInt(c.witness.leaf.value), next: BigInt(c.witness.leaf.next) } },
      })),
    };
    expect(verifyProofCarryingAnswer(revived).grounded).toBe(true);
  });

  it('abstains with 409 when a cited value is not among this agent\'s verified entries', async () => {
    seedCommittedEntries(AGENT_ID, [entry('the sky is blue')]);
    const res = await request(makeApp(AGENT_ID))
      .post('/api/v1/proof-carrying/emit')
      .send({ answer: 'a fabricated claim', cited_values: ['not-a-real-value'] });
    expect(res.status).toBe(409);
  });

  it('never binds against another agent\'s committed memory, even if that root is cited', async () => {
    const { values } = seedCommittedEntries('victim-agent', [entry('victim secret')]);
    const res = await request(makeApp(AGENT_ID))
      .post('/api/v1/proof-carrying/emit')
      .send({ answer: 'leaked claim', cited_values: values });
    expect(res.status).toBe(409); // caller agent has no committed root of its own
  });
});
