/**
 * CC Sprint 10 Phase 3.3 — Unit tests for the edge inference engine.
 *
 * Pure-function tests: no DB; uses synthetic NodeForInference objects.
 * The persistEdges-against-DB path is exercised by the CLI dry-run + by the
 * full-substrate-loop integration test from Sprint 9 (which actually inserts
 * an edge against real Supabase).
 */

import {
  inferMentions,
  inferResponseTo,
  inferReferences,
  inferReinforces,
  inferContradicts,
  inferEdgesFromNodes,
  cosineSimilarity,
  persistEdges,
  extractTokens,
  type NodeForInference,
  type InferredEdge,
} from '../../src/services/graph-rag-edge-inference';

const AGENT_A = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const AGENT_B = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';

function n(id: string, opts: Partial<NodeForInference> = {}): NodeForInference {
  return {
    id,
    agent_id: AGENT_A,
    node_type: 'observation',
    content: '',
    embedding: null,
    source_event_id: null,
    importance: 0.5,
    created_at: '2026-05-12T00:00:00Z',
    ...opts,
  };
}

describe('extractTokens', () => {
  it('returns tokens of length >= 6 excluding stopwords', () => {
    const toks = extractTokens('The Pythagorean Comma BFT veto triggers consensus');
    expect(toks.has('Pythagorean')).toBe(true);
    expect(toks.has('consensus')).toBe(true);
    expect(toks.has('triggers')).toBe(true);
    expect(toks.has('The')).toBe(false); // too short
    expect(toks.has('veto')).toBe(false); // too short
  });
});

describe('inferMentions', () => {
  it('detects shared 6+-char token', () => {
    const a = n('A', { content: 'HyperDAG x402 mesh protocol' });
    const b = n('B', { content: 'The HyperDAG facilitator routes via Base Sepolia' });
    const e = inferMentions(a, b);
    expect(e).not.toBeNull();
    expect(e!.edge_type).toBe('mentions');
    expect(e!.from_node_id).toBe('A');
    expect(e!.to_node_id).toBe('B');
    expect((e!.metadata as any).shared_tokens).toContain('HyperDAG');
  });
  it('returns null when no shared tokens', () => {
    const a = n('A', { content: 'apples oranges bananas peaches' });
    const b = n('B', { content: 'matrix vector pgvector cosine' });
    expect(inferMentions(a, b)).toBeNull();
  });
  it('returns null when comparing node to itself', () => {
    const a = n('A', { content: 'pythagorean comma' });
    expect(inferMentions(a, a)).toBeNull();
  });
});

describe('inferResponseTo', () => {
  it('fires when B follows A within 5 min same agent', () => {
    const a = n('A', { created_at: '2026-05-12T00:00:00Z', agent_id: AGENT_A });
    const b = n('B', { created_at: '2026-05-12T00:03:00Z', agent_id: AGENT_A });
    const e = inferResponseTo(a, b);
    expect(e).not.toBeNull();
    expect(e!.edge_type).toBe('response_to');
    expect((e!.metadata as any).delta_ms).toBe(3 * 60 * 1000);
  });
  it('does not fire across agents', () => {
    const a = n('A', { agent_id: AGENT_A });
    const b = n('B', { agent_id: AGENT_B, created_at: '2026-05-12T00:01:00Z' });
    expect(inferResponseTo(a, b)).toBeNull();
  });
  it('does not fire when B is before A', () => {
    const a = n('A', { created_at: '2026-05-12T00:05:00Z' });
    const b = n('B', { created_at: '2026-05-12T00:00:00Z' });
    expect(inferResponseTo(a, b)).toBeNull();
  });
  it('does not fire outside 5-min window', () => {
    const a = n('A', { created_at: '2026-05-12T00:00:00Z' });
    const b = n('B', { created_at: '2026-05-12T00:10:00Z' });
    expect(inferResponseTo(a, b)).toBeNull();
  });
});

describe('inferReferences', () => {
  it('detects shared UUID', () => {
    const uuid = 'f3ef0bf8-5cdc-4fad-bce8-5144f01dc271';
    const a = n('A', { content: `SOPHIA ${uuid} canonical` });
    const b = n('B', { content: `Spokesperson ${uuid} active` });
    const e = inferReferences(a, b);
    expect(e).not.toBeNull();
    expect((e!.metadata as any).matches).toContain(uuid);
  });
  it('detects shared URL', () => {
    const url = 'https://facilitator.x402.io/settle';
    const a = n('A', { content: `route through ${url}` });
    const b = n('B', { content: `${url} returned 200` });
    expect(inferReferences(a, b)).not.toBeNull();
  });
  it('returns null when no shared refs', () => {
    expect(inferReferences(n('A', { content: 'no refs here' }), n('B', { content: 'still none' }))).toBeNull();
  });
});

describe('cosineSimilarity + inferReinforces', () => {
  it('cosine of identical vectors is 1', () => {
    expect(cosineSimilarity([1, 0, 1], [1, 0, 1])).toBeCloseTo(1, 6);
  });
  it('cosine of orthogonal vectors is 0', () => {
    expect(cosineSimilarity([1, 0], [0, 1])).toBeCloseTo(0, 6);
  });
  it('reinforces fires when same node_type + cosine > 0.85', () => {
    const a = n('A', { node_type: 'fact', embedding: [1, 0, 0] });
    const b = n('B', { node_type: 'fact', embedding: [0.95, 0.1, 0.1] });
    const e = inferReinforces(a, b);
    expect(e).not.toBeNull();
    expect(e!.edge_type).toBe('reinforces');
  });
  it('reinforces does not fire across node_types', () => {
    const a = n('A', { node_type: 'fact', embedding: [1, 0, 0] });
    const b = n('B', { node_type: 'observation', embedding: [1, 0, 0] });
    expect(inferReinforces(a, b)).toBeNull();
  });
  it('reinforces skips when either embedding is NULL', () => {
    const a = n('A', { embedding: [1, 0, 0] });
    const b = n('B', { embedding: null });
    expect(inferReinforces(a, b)).toBeNull();
  });
});

describe('inferContradicts', () => {
  it('fires when high cosine + exactly one HAL veto', () => {
    const a = n('A', { embedding: [1, 0, 0], hal_veto_flag: true });
    const b = n('B', { embedding: [0.95, 0.1, 0.1], hal_veto_flag: false });
    const e = inferContradicts(a, b);
    expect(e).not.toBeNull();
    expect(e!.weight).toBeLessThan(0.5);
  });
  it('does not fire when both veto or neither veto', () => {
    const a = n('A', { embedding: [1, 0, 0], hal_veto_flag: true });
    const b = n('B', { embedding: [0.95, 0.1, 0.1], hal_veto_flag: true });
    expect(inferContradicts(a, b)).toBeNull();
  });
});

describe('inferEdgesFromNodes', () => {
  it('returns empty array when no nodes', () => {
    expect(inferEdgesFromNodes([])).toEqual([]);
  });
  it('high-importance nodes generate edges first (ordering)', () => {
    const high = n('high', { importance: 0.9, content: 'pythagorean comma' });
    const low  = n('low',  { importance: 0.1, content: 'pythagorean structure' });
    const edges = inferEdgesFromNodes([low, high]);
    // first mentions-type edge should originate from the high-importance node
    const firstMention = edges.find((e) => e.edge_type === 'mentions');
    expect(firstMention?.from_node_id).toBe('high');
  });
  it('symmetric edges (reinforces) emitted only once per pair', () => {
    const a = n('aaa', { node_type: 'fact', embedding: [1, 0] });
    const b = n('bbb', { node_type: 'fact', embedding: [0.95, 0.1] });
    const edges = inferEdgesFromNodes([a, b]);
    const reinforces = edges.filter((e) => e.edge_type === 'reinforces');
    expect(reinforces).toHaveLength(1);
  });
});

describe('persistEdges (dry-run path)', () => {
  it('rejects edge_type not in CHECK whitelist', async () => {
    const bad: InferredEdge = {
      from_node_id: 'X', to_node_id: 'Y', edge_type: 'bogus' as any,
      weight: 0.5, metadata: {}, confidence: 0.5,
    };
    const r = await persistEdges([bad], { dryRun: true });
    expect(r.rejected_by_check).toBe(1);
    expect(r.persisted).toBe(0);
  });
  it('rejects self-edge', async () => {
    const bad: InferredEdge = {
      from_node_id: 'X', to_node_id: 'X', edge_type: 'mentions',
      weight: 0.5, metadata: {}, confidence: 0.5,
    };
    const r = await persistEdges([bad], { dryRun: true });
    expect(r.rejected_by_check).toBe(1);
  });
  it('rejects out-of-range weight', async () => {
    const bad: InferredEdge = {
      from_node_id: 'X', to_node_id: 'Y', edge_type: 'mentions',
      weight: 1.5, metadata: {}, confidence: 1.0,
    };
    const r = await persistEdges([bad], { dryRun: true });
    expect(r.rejected_by_check).toBe(1);
  });
  it('returns inferred=0 persisted=0 for empty input', async () => {
    const r = await persistEdges([], { dryRun: true });
    expect(r).toEqual({ inferred: 0, persisted: 0, deduplicated: 0, rejected_by_check: 0 });
  });
});
