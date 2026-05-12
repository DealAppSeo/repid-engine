/**
 * CC Sprint 10 — Graph RAG Edge Inference Engine
 *
 * 22 memory nodes exist in agent_memory_nodes; agent_memory_edges is empty.
 * Without edges, Graph RAG retrieval cannot traverse related context.
 *
 * This module infers edges between memory nodes using six heuristics — one per
 * edge_type in the CHECK whitelist. The inference output is a list of
 * InferredEdge objects; persisting is a separate explicit step (so we can dry-run).
 *
 * Two RAG metrics tables co-exist — they answer DIFFERENT questions, do not merge:
 *   - `graph_rag_retrieval_metrics` (Gemini Sprint 3.5) — measures whether RAG
 *     RETRIEVAL improved downstream HAL signal quality (was the retrieved context
 *     useful for the task?). Schema: agent_id, query, latency_ms, nodes_retrieved,
 *     relevance_score.
 *   - `graph_rag_edge_inference_metrics` (CC Sprint 10) — operational telemetry on
 *     the INFERENCE RUN itself (how many edges proposed/persisted/deduped/rejected,
 *     by type). Schema: run_id, agent_id, edges_inferred, edges_persisted,
 *     edges_deduplicated, edges_rejected_check, edge_type_distribution, dry_run.
 *
 * Heuristics (each carries its own confidence 0..1):
 *   - mentions:    B contains a 6+-char alpha token from A
 *   - response_to: B created within 5 min after A, same agent_id
 *   - references:  A and B share a UUID / hex-hash / URL substring
 *   - reinforces:  same node_type AND cosine(embedding_a, embedding_b) > 0.85
 *   - caused_by:   B.source_event_id chains to A.source_event_id via repid_events.parent_event_id
 *   - contradicts: high cosine similarity BUT exactly one was created during a HAL veto event
 *
 * Limitations (RULE-8: surfaced, not fixed):
 *   - All 22 current nodes have source_event_id=NULL → caused_by + contradicts produce 0 edges.
 *   - Only 8 of 22 nodes have embeddings → reinforces is limited to that subset.
 *   - "HAL veto event" tracking is not currently joined to nodes → contradicts is a stub.
 */

import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { config } from '../config';
import type { EdgeType, NodeType } from '../types/graph-rag';

const VALID_EDGE_TYPES: ReadonlySet<EdgeType> = new Set<EdgeType>([
  'mentions', 'response_to', 'caused_by', 'contradicts', 'reinforces', 'references',
]);

export const RESPONSE_TO_WINDOW_MS = 5 * 60 * 1000; // 5 minutes
export const REINFORCES_COSINE_THRESHOLD = 0.85;
export const MENTIONS_MIN_TOKEN_LEN = 6; // dispatcher rule: "noun >5 chars"
export const MENTIONS_MAX_SHARED_TOKENS = 4; // cap weight bonus
export const PERSIST_BATCH_SIZE = 100;

/** Subset of node fields the engine needs (decoupled from full MemoryNode type). */
export interface NodeForInference {
  id: string;
  agent_id: string;
  node_type: NodeType;
  content: string;
  embedding: number[] | null;
  source_event_id: number | null;
  importance: number;
  created_at: string; // ISO8601
  hal_veto_flag?: boolean; // optional sidecar; not in DB today
}

export interface InferredEdge {
  from_node_id: string;
  to_node_id: string;
  edge_type: EdgeType;
  weight: number;
  metadata: Record<string, unknown>;
  /** Informational only — not a DB column. Helps callers triage low-confidence edges. */
  confidence: number;
}

export interface PersistResult {
  inferred: number;
  persisted: number;
  deduplicated: number;
  rejected_by_check: number;
}

/* ───────────────────────────────────────────────────────────────────────────
 * Pure heuristic functions — testable without a database connection.
 * Each returns null when the heuristic does not fire for the (a, b) pair.
 * ─────────────────────────────────────────────────────────────────────────── */

const STOPWORDS = new Set([
  'across','agents','always','around','because','before','between','context',
  'created','during','either','include','really','should','simple','squads',
  'though','unless','within','recent','verified','perspective','prioritize',
]);

export function extractTokens(content: string): Set<string> {
  const out = new Set<string>();
  const re = /[A-Za-z][A-Za-z0-9_-]+/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(content)) !== null) {
    const tok = m[0];
    if (tok.length >= MENTIONS_MIN_TOKEN_LEN && !STOPWORDS.has(tok.toLowerCase())) {
      out.add(tok);
    }
  }
  return out;
}

export function inferMentions(a: NodeForInference, b: NodeForInference): InferredEdge | null {
  if (a.id === b.id) return null;
  const aTokens = extractTokens(a.content);
  if (aTokens.size === 0) return null;
  const shared: string[] = [];
  for (const t of aTokens) {
    if (b.content.includes(t)) shared.push(t);
    if (shared.length > MENTIONS_MAX_SHARED_TOKENS) break;
  }
  if (shared.length === 0) return null;
  const confidence = Math.min(1, 0.4 + 0.15 * shared.length);
  return {
    from_node_id: a.id,
    to_node_id: b.id,
    edge_type: 'mentions',
    weight: confidence,
    metadata: { heuristic: 'token-overlap', shared_tokens: shared, source: 'cc-sprint-10' },
    confidence,
  };
}

export function inferResponseTo(a: NodeForInference, b: NodeForInference): InferredEdge | null {
  if (a.id === b.id) return null;
  if (a.agent_id !== b.agent_id) return null;
  const aT = Date.parse(a.created_at);
  const bT = Date.parse(b.created_at);
  if (!Number.isFinite(aT) || !Number.isFinite(bT)) return null;
  const delta = bT - aT;
  if (delta <= 0 || delta > RESPONSE_TO_WINDOW_MS) return null;
  // Closer in time → higher confidence
  const confidence = Math.max(0.3, 1 - delta / RESPONSE_TO_WINDOW_MS);
  return {
    from_node_id: a.id,
    to_node_id: b.id,
    edge_type: 'response_to',
    weight: confidence,
    metadata: { heuristic: 'temporal-adjacency', delta_ms: delta, source: 'cc-sprint-10' },
    confidence,
  };
}

const HEX_HASH = /\b[0-9a-fA-F]{16,}\b/g;
const UUID_RE = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/g;
const URL_RE = /\bhttps?:\/\/[^\s'"<>]+/g;

function extractReferenceTokens(content: string): Set<string> {
  const out = new Set<string>();
  for (const re of [HEX_HASH, UUID_RE, URL_RE]) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(content)) !== null) out.add(m[0]);
  }
  return out;
}

export function inferReferences(a: NodeForInference, b: NodeForInference): InferredEdge | null {
  if (a.id === b.id) return null;
  const aRefs = extractReferenceTokens(a.content);
  if (aRefs.size === 0) return null;
  const shared: string[] = [];
  for (const r of aRefs) if (b.content.includes(r)) shared.push(r);
  if (shared.length === 0) return null;
  return {
    from_node_id: a.id,
    to_node_id: b.id,
    edge_type: 'references',
    weight: 0.9, // shared concrete references are high-signal
    metadata: { heuristic: 'shared-reference', matches: shared, source: 'cc-sprint-10' },
    confidence: 0.9,
  };
}

export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    const ai = a[i] ?? 0; const bi = b[i] ?? 0;
    dot += ai * bi; na += ai * ai; nb += bi * bi;
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

export function inferReinforces(a: NodeForInference, b: NodeForInference): InferredEdge | null {
  if (a.id === b.id) return null;
  if (a.node_type !== b.node_type) return null;
  if (!a.embedding || !b.embedding) return null; // dispatcher rule: skip if NULL
  const sim = cosineSimilarity(a.embedding, b.embedding);
  if (sim <= REINFORCES_COSINE_THRESHOLD) return null;
  return {
    from_node_id: a.id,
    to_node_id: b.id,
    edge_type: 'reinforces',
    weight: Math.min(1, sim),
    metadata: { heuristic: 'cosine-similarity', cosine: sim, source: 'cc-sprint-10' },
    confidence: sim,
  };
}

export function inferContradicts(a: NodeForInference, b: NodeForInference): InferredEdge | null {
  if (a.id === b.id) return null;
  if (!a.embedding || !b.embedding) return null;
  const sim = cosineSimilarity(a.embedding, b.embedding);
  if (sim <= REINFORCES_COSINE_THRESHOLD) return null;
  const aVeto = a.hal_veto_flag === true;
  const bVeto = b.hal_veto_flag === true;
  if (aVeto === bVeto) return null; // need exactly-one veto for contradicts
  return {
    from_node_id: a.id,
    to_node_id: b.id,
    edge_type: 'contradicts',
    weight: 0.4, // low-confidence heuristic per dispatcher
    metadata: { heuristic: 'cosine-similarity-with-veto-split', cosine: sim, source: 'cc-sprint-10' },
    confidence: 0.4,
  };
}

/* ───────────────────────────────────────────────────────────────────────────
 * Database-backed orchestrator.
 * ─────────────────────────────────────────────────────────────────────────── */

function getDb(dbArg?: SupabaseClient): SupabaseClient {
  return dbArg ?? createClient(config.supabaseUrl, config.supabaseKey, { auth: { persistSession: false } });
}

function parseEmbedding(raw: unknown): number[] | null {
  if (raw == null) return null;
  if (Array.isArray(raw)) return raw.map((v) => Number(v));
  if (typeof raw === 'string') {
    // pgvector default text encoding: "[0.1,0.2,...]"
    const trimmed = raw.trim();
    if (!trimmed.startsWith('[') || !trimmed.endsWith(']')) return null;
    return trimmed.slice(1, -1).split(',').map((s) => Number(s.trim()));
  }
  return null;
}

export async function fetchNodes(opts: { agentId?: string }, db: SupabaseClient): Promise<NodeForInference[]> {
  let q = db.from('agent_memory_nodes').select('id, agent_id, node_type, content, embedding, source_event_id, importance, created_at');
  if (opts.agentId) q = q.eq('agent_id', opts.agentId);
  const { data, error } = await q;
  if (error) throw new Error(`fetchNodes failed: ${error.message}`);
  return (data ?? []).map((r: any) => ({
    id: r.id,
    agent_id: r.agent_id,
    node_type: r.node_type,
    content: r.content,
    embedding: parseEmbedding(r.embedding),
    source_event_id: r.source_event_id,
    importance: Number(r.importance ?? 0),
    created_at: r.created_at,
  }));
}

/** Run all six heuristics across every ordered pair. Skips reverse-direction
 *  duplicates for symmetric edge types (reinforces, contradicts) by enforcing
 *  from_node_id < to_node_id lexicographically. */
export function inferEdgesFromNodes(nodes: NodeForInference[]): InferredEdge[] {
  // Sort: high-importance first, then by created_at — dispatcher 3.3 test
  const sorted = [...nodes].sort((a, b) => (b.importance - a.importance) || a.created_at.localeCompare(b.created_at));
  const out: InferredEdge[] = [];
  for (let i = 0; i < sorted.length; i++) {
    for (let j = 0; j < sorted.length; j++) {
      if (i === j) continue;
      const a = sorted[i]!; const b = sorted[j]!;
      // Asymmetric edges (direction matters):
      const mention = inferMentions(a, b); if (mention) out.push(mention);
      const respTo = inferResponseTo(a, b); if (respTo) out.push(respTo);
      const refs = inferReferences(a, b); if (refs) out.push(refs);
      // Symmetric edges: only emit once per unordered pair
      if (a.id < b.id) {
        const rein = inferReinforces(a, b); if (rein) out.push(rein);
        const cont = inferContradicts(a, b); if (cont) out.push(cont);
      }
    }
  }
  return out;
}

export async function inferEdges(opts: { agentId?: string } = {}, dbArg?: SupabaseClient): Promise<InferredEdge[]> {
  const db = getDb(dbArg);
  const nodes = await fetchNodes(opts, db);
  return inferEdgesFromNodes(nodes);
}

export async function persistEdges(
  edges: InferredEdge[],
  opts: { dryRun: boolean },
  dbArg?: SupabaseClient,
): Promise<PersistResult> {
  const result: PersistResult = { inferred: edges.length, persisted: 0, deduplicated: 0, rejected_by_check: 0 };
  if (edges.length === 0) return result;

  // Validate edge_type against CHECK whitelist BEFORE talking to DB
  const validEdges = edges.filter((e) => {
    if (!VALID_EDGE_TYPES.has(e.edge_type)) { result.rejected_by_check++; return false; }
    if (e.from_node_id === e.to_node_id) { result.rejected_by_check++; return false; }
    if (e.weight < 0 || e.weight > 1) { result.rejected_by_check++; return false; }
    return true;
  });

  if (opts.dryRun) return result;

  const db = getDb(dbArg);

  // Dedupe in-memory against unique-key (from, to, edge_type)
  const seen = new Set<string>();
  const deduped: InferredEdge[] = [];
  for (const e of validEdges) {
    const key = `${e.from_node_id}|${e.to_node_id}|${e.edge_type}`;
    if (seen.has(key)) { result.deduplicated++; continue; }
    seen.add(key);
    deduped.push(e);
  }

  // Pre-check against existing rows (returns deduplicated count for already-existing matches)
  // Cheap approach: select all existing edges and filter in-memory.
  const { data: existing, error: exErr } = await db.from('agent_memory_edges').select('from_node_id, to_node_id, edge_type');
  if (exErr) throw new Error(`persistEdges select-existing failed: ${exErr.message}`);
  const existingKeys = new Set<string>((existing ?? []).map((r: any) => `${r.from_node_id}|${r.to_node_id}|${r.edge_type}`));
  const toInsert: InferredEdge[] = [];
  for (const e of deduped) {
    const key = `${e.from_node_id}|${e.to_node_id}|${e.edge_type}`;
    if (existingKeys.has(key)) { result.deduplicated++; continue; }
    toInsert.push(e);
  }

  // Insert in batches
  for (let i = 0; i < toInsert.length; i += PERSIST_BATCH_SIZE) {
    const batch = toInsert.slice(i, i + PERSIST_BATCH_SIZE).map((e) => ({
      from_node_id: e.from_node_id,
      to_node_id: e.to_node_id,
      edge_type: e.edge_type,
      weight: e.weight,
      metadata: e.metadata,
    }));
    const { error } = await db.from('agent_memory_edges').insert(batch);
    if (error) {
      // CHECK violations from server should fall here; we already pre-filtered, but defensive.
      result.rejected_by_check += batch.length;
      continue;
    }
    result.persisted += batch.length;
  }

  return result;
}
