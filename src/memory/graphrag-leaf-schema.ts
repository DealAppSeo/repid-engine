/**
 * graphrag-leaf-schema.ts — GraphRAG-native leaf schemas for Patent #3
 * (backlog item 12, reports/2026-07-26/PATENT_ALIGNED_BUILD_BACKLOG.md).
 *
 * Four node types that sit as leaves in a LeanIMTPlus tree:
 *   EntityLeaf    — a named entity (person, org, concept, event)
 *   RelationLeaf  — a directed edge between two entity leaf commitments
 *   EpisodeLeaf   — a time-stamped multi-participant memory episode
 *   SkillLeaf     — a learned skill with a capability descriptor
 *
 * Each type has a canonical encode → `poseidon2LeafHash` pipeline matching the
 * `pcr.entry.v0` convention from `proof-carrying-memory.ts`, so a single
 * `LeanIMTPlus` tree can hold all four types and produce inclusion witnesses
 * that chain across node types (the multi-hop walk the acceptance test names).
 *
 * This module is SCHEMA ONLY — pure types + encode functions, no I/O, no DB
 * reads. Wiring into `ProofCarryingMemory` or a retrieval route is a follow-up.
 *
 * EDGE HASHING
 * ------------
 * An authenticated subgraph walk (hop-by-hop against the root) requires that
 * each directed edge be itself committed. `encodeGraphEdge` / `graphEdgeHash`
 * produce a commitment over (from_value, to_value, relation_type) so a verifier
 * can confirm an edge traversal without trusting the caller's path description.
 */

import { poseidon2LeafHash } from '../zkp/poseidon2-leaf';

// ── Entity ─────────────────────────────────────────────────────────────────────

/**
 * A named entity. `embedding_hash` is a hex-encoded SHA-256 of the embedding
 * vector — included in the commitment so the vector cannot be silently swapped.
 */
export interface EntityLeaf {
  entity_id: string;
  entity_type: 'person' | 'organization' | 'concept' | 'event' | string;
  name: string;
  description: string;
  embedding_hash: string; // SHA-256(embedding_bytes), hex
  epoch: number;
}

export function encodeEntityLeaf(e: EntityLeaf): string {
  return `pcr.graphrag.entity.v0|${e.entity_id}|${e.entity_type}|${e.name}|${e.description}|${e.embedding_hash}|${e.epoch}`;
}

export function entityLeafValue(e: EntityLeaf): string {
  return poseidon2LeafHash(encodeEntityLeaf(e));
}

// ── Relation ────────────────────────────────────────────────────────────────────

/**
 * A directed semantic relation from one entity leaf to another.
 * `from_value` and `to_value` are the leaf commitment strings from
 * `entityLeafValue()`, so a changed entity invalidates any relation citing it.
 */
export interface RelationLeaf {
  relation_id: string;
  from_value: string; // entityLeafValue() of the source entity
  relation_type: string; // e.g. 'is_a', 'part_of', 'authored_by', 'precedes'
  to_value: string;   // entityLeafValue() of the target entity
  confidence: number; // [0, 1]
  epoch: number;
}

export function encodeRelationLeaf(r: RelationLeaf): string {
  return `pcr.graphrag.relation.v0|${r.relation_id}|${r.from_value}|${r.relation_type}|${r.to_value}|${r.confidence}|${r.epoch}`;
}

export function relationLeafValue(r: RelationLeaf): string {
  return poseidon2LeafHash(encodeRelationLeaf(r));
}

// ── Episode ──────────────────────────────────────────────────────────────────────

/**
 * A time-bounded multi-participant memory episode. `participant_values` are
 * entityLeafValue() strings so participants are cryptographically bound to the
 * episode without re-hashing their full content.
 */
export interface EpisodeLeaf {
  episode_id: string;
  content: string;
  participant_values: readonly string[]; // entityLeafValue() strings
  timestamp_ms: number;
  hal_verdict: string; // clean | flagged | vetoed | …
  epoch: number;
}

export function encodeEpisodeLeaf(e: EpisodeLeaf): string {
  const parts = [...e.participant_values].sort().join(','); // stable regardless of insertion order
  return `pcr.graphrag.episode.v0|${e.episode_id}|${e.content}|${parts}|${e.timestamp_ms}|${e.hal_verdict}|${e.epoch}`;
}

export function episodeLeafValue(e: EpisodeLeaf): string {
  return poseidon2LeafHash(encodeEpisodeLeaf(e));
}

// ── Skill ─────────────────────────────────────────────────────────────────────

/**
 * A learned skill. `capability_vector_hash` is SHA-256(capability_vector_bytes)
 * so the vector can be stored off-chain without weakening the commitment.
 */
export interface SkillLeaf {
  skill_id: string;
  description: string;
  capability_vector_hash: string; // SHA-256(capability_bytes), hex
  proficiency_score: number; // [0, 1]
  epoch: number;
}

export function encodeSkillLeaf(s: SkillLeaf): string {
  return `pcr.graphrag.skill.v0|${s.skill_id}|${s.description}|${s.capability_vector_hash}|${s.proficiency_score}|${s.epoch}`;
}

export function skillLeafValue(s: SkillLeaf): string {
  return poseidon2LeafHash(encodeSkillLeaf(s));
}

// ── Authenticated graph edge ──────────────────────────────────────────────────

/**
 * A directed graph edge committed over (from_value, relation_type, to_value).
 * Used during a multi-hop walk: a verifier re-derives this hash from the
 * claimed from/to leaf values and the claimed relation_type, then checks it
 * against the edge commitment included in the walk proof.
 * Neither `from_value` nor `to_value` must be a RelationLeaf — any leaf type works.
 */
export interface GraphEdge {
  from_value: string;
  relation_type: string;
  to_value: string;
}

export function encodeGraphEdge(e: GraphEdge): string {
  return `pcr.graphrag.edge.v0|${e.from_value}|${e.relation_type}|${e.to_value}`;
}

export function graphEdgeHash(e: GraphEdge): string {
  return poseidon2LeafHash(encodeGraphEdge(e));
}

/**
 * A single step in a multi-hop subgraph walk.
 * The walk is valid iff every step's edge_hash matches a re-derived hash over
 * its (from_value, relation_type, to_value), AND every from_value / to_value
 * has a valid inclusion witness against the committed memory root.
 */
export interface WalkStep {
  from_value: string;
  relation_type: string;
  to_value: string;
  edge_hash: string; // graphEdgeHash({ from_value, relation_type, to_value })
}

/**
 * Verify a single walk step without a live tree: re-derive the edge hash and
 * compare it to the committed hash. Returns true iff consistent.
 * Full walk verification (each from/to has an inclusion witness) requires a
 * live or hydrated LeanIMTPlus and is a follow-up route concern.
 */
export function verifyWalkStep(step: WalkStep): boolean {
  const derived = graphEdgeHash({
    from_value: step.from_value,
    relation_type: step.relation_type,
    to_value: step.to_value,
  });
  return derived === step.edge_hash;
}
