/**
 * experimental-repid.ts — the EXPERIMENTAL RepID namespace (D-124 revised, Sean 2026-11-02).
 *
 * T12 agents earn and lose durable RepID from real, measured outcomes, but inside a labelled domain
 * ('t12-exp-v1', table repid_experimental_events) that can never be read as independent-counterparty
 * reputation. Canonical repid_agents.current_repid and repid_score_events are never written from here:
 * the only table this module inserts into is repid_experimental_events, and it only reads repid_agents.
 *
 * ANTI-FORGERY, in the order settleExperimental checks them (each refusal writes nothing):
 *   wrong_domain          evidence for any other domain.
 *   unknown_version       scoring version not in SCORING_VERSIONS, or for another evidence kind.
 *   hash_mismatch         the evidence hash is sha256 over EVERYTHING scored and recorded (content,
 *                         subject, oracle, counterparty); edit any of it and the hash no longer matches.
 *   subject_mismatch      settling for an agent that is not the evidence's subject, or a subject id that
 *                         does not belong to the source row's own agent (trinity_tasks.claimed_by).
 *   unknown_agent         subject not in repid_agents.
 *   self_dealing          the oracle is the subject (by uuid, agent_id or name).
 *   oracle_not_answer_key a known answer graded by anything but the answer key: a model quorum is not
 *                         ground truth (hal_test_cases.expected_decision is).
 *   already_consumed      the DB's unique (domain, dimension, evidence_id|evidence_hash, mode) refused it.
 * Eligibility is never an input: eligibilityFor decides it, and only a POSITIVE different-owner answer
 * from partyIndependence (#1484/#1489) can produce 'independent_counterparty'. A known answer has no
 * counterparty, so it is always 'same_controller_measured' (the migration's CHECK says so too).
 *
 * TWO ANSWER KEYS (2026-11-14). A known answer is graded by one of exactly two oracles:
 *   KNOWN_ANSWER_ORACLE   hal_test_cases.expected_decision, read from the database (pass | veto).
 *   COMMIT_REVEAL_ORACLE  a key the conductor committed to BEFORE dispatch, as
 *                         sha256("<expected>|<nonce>") stored in the task's own metadata
 *                         (answer_commitment_sha256), and revealed after the run (pass | veto | abstain).
 *                         The reveal arrives from outside, so it counts only when it recomputes the
 *                         commitment that was written at dispatch: a changed answer or nonce does not.
 *                         Settles in SHADOW ONLY until ratified ('shadow_only_oracle' refuses active).
 * Any other oracle is refused. The scoring rules are the same functions for both keys.
 *
 * MODE (EXPERIMENTAL_REPID_MODE): unset/off = nothing read or written; shadow = rows with mode 'shadow';
 * active = rows with mode 'active'; anything else = loud + shadow. Shadow and active run the same
 * evidence through the same pure scoring functions; only active rows may ever feed experimentalTier.
 */
import { createHash } from 'node:crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import { db } from '../db';
import { partyIndependence } from './same-owner-settlement';
import type { PartyIndependence } from '../scoring/grounding';

export const EXPERIMENTAL_DOMAIN = 't12-exp-v1';
export const EXPERIMENTAL_TABLE = 'repid_experimental_events';
export const EXPERIMENTAL_SCORES_VIEW = 'repid_experimental_scores';
export const KNOWN_ANSWER_ORACLE = 'answer_key:hal_test_cases.expected_decision';
export const COMMIT_REVEAL_ORACLE = 'answer_key:commit_reveal_sha256';

/** The conductor's commitment: sha256 of "<expected>|<nonce>", UTF-8, no newline, lowercase hex. */
export function answerCommitment(expected: string, nonce: string): string {
  return createHash('sha256').update(`${expected}|${nonce}`, 'utf8').digest('hex');
}
export const KNOWN_ANSWER_SPRINT_TAG = 't12-known-answer-v2';
export const EXPERIMENTAL_LABEL =
  'EXPERIMENTAL: same-controller measured evidence (domain t12-exp-v1). Not independent-counterparty reputation and not canonical RepID.';

export type Dimension = 'producer' | 'validator' | 'redteam' | 'calibration' | 'reliability' | 'safety';
export type Eligibility = 'same_controller_measured' | 'independent_counterparty';
export type ExperimentalMode = 'off' | 'shadow' | 'active';

export function experimentalRepidMode(raw: string | undefined = process.env.EXPERIMENTAL_REPID_MODE): ExperimentalMode {
  const v = (raw ?? '').trim().toLowerCase();
  if (v === '' || v === 'off') return 'off';
  if (v === 'shadow' || v === 'active') return v;
  console.error(`[experimental-repid] EXPERIMENTAL_REPID_MODE=${JSON.stringify(raw)} is not off|shadow|active; behaving as 'shadow'`);
  return 'shadow';
}

// ── evidence ────────────────────────────────────────────────────────────────────────────────
/** What a known-answer evidence row scores, and nothing else. All of it is hashed. */
export interface KnownAnswerContent {
  task_id: string; case_id: string; claimed_by: string; result: string; expected: string;
  /** Commit-reveal key only: the commitment written at dispatch, and the revealed nonce. */
  commitment?: string; nonce?: string;
}

export interface ExperimentalEvidence {
  domain: string;
  kind: 'known_answer';
  content: KnownAnswerContent;
  /** repid_agents.id of the agent the evidence is about. */
  subjectAgentId: string;
  /** Who graded it. For a known answer, the answer key. */
  oracleId: string;
  counterpartyAgentId?: string | null;
  ref: string;
  hash: string;
}

/** A known-answer child task joined to its answer key and its agent's repid_agents.id. */
export interface KnownAnswerRow {
  task_id: string; claimed_by: string; case_id: string; result: string; expected: string; subject_agent_id: string;
  /** Present only for a commit-reveal key (see loadCommitRevealRows); absent = hal_test_cases key. */
  commitment?: string; nonce?: string;
}

const evidenceId = (e: ExperimentalEvidence) => `trinity_tasks:${e.content.task_id}`;

function evidenceHash(e: Omit<ExperimentalEvidence, 'hash'>): string {
  const c = e.content;
  const canonical: unknown[] = [e.domain, e.kind, c.task_id, c.case_id, c.claimed_by, c.result, c.expected, e.subjectAgentId, e.oracleId, e.counterpartyAgentId ?? null];
  // Appended only when present, so every hal_test_cases-keyed hash already stored is unchanged.
  if (c.commitment !== undefined || c.nonce !== undefined) canonical.push(c.commitment ?? null, c.nonce ?? null);
  return createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
}

/** (Re)compute the hash. Anything that can call this can also only produce evidence the checks accept. */
export function sealEvidence(e: Omit<ExperimentalEvidence, 'hash'> & { hash?: string }): ExperimentalEvidence {
  return { ...e, hash: evidenceHash(e) };
}

export function knownAnswerEvidence(r: KnownAnswerRow): ExperimentalEvidence {
  const task_id = String(r.task_id);
  if (r.commitment !== undefined || r.nonce !== undefined) {
    return sealEvidence({
      domain: EXPERIMENTAL_DOMAIN,
      kind: 'known_answer',
      content: {
        task_id, case_id: String(r.case_id), claimed_by: r.claimed_by, result: r.result, expected: r.expected,
        commitment: r.commitment ?? '', nonce: r.nonce ?? '',
      },
      subjectAgentId: r.subject_agent_id,
      oracleId: COMMIT_REVEAL_ORACLE,
      ref: `trinity_tasks/${task_id};answer_commitment_sha256/${r.commitment ?? ''}`,
    });
  }
  return sealEvidence({
    domain: EXPERIMENTAL_DOMAIN,
    kind: 'known_answer',
    content: { task_id, case_id: String(r.case_id), claimed_by: r.claimed_by, result: r.result, expected: r.expected },
    subjectAgentId: r.subject_agent_id,
    oracleId: KNOWN_ANSWER_ORACLE,
    ref: `trinity_tasks/${task_id};hal_test_cases/${r.case_id}`,
  });
}

// ── versioned scoring (pure) ────────────────────────────────────────────────────────────────
interface Outcome { decision: 'pass' | 'veto' | 'abstain' | null; expected: 'pass' | 'veto' | 'abstain' | null; confidence: number | null }

/** Same parse as E:\dev\sprints\2026-11-01\T12_KNOWN_ANSWER_GRADER_V2.sql. */
export function parseKnownAnswer(c: KnownAnswerContent): Outcome {
  const text = (c.result ?? '').toLowerCase();
  const d = /"decision"\s*:\s*"(pass|veto|abstain)"/.exec(text)?.[1] as Outcome['decision'] | undefined;
  const conf = /"confidence"\s*:\s*"?([0-9]*\.?[0-9]+)/.exec(text)?.[1];
  const n = conf === undefined ? NaN : Number(conf);
  // 'abstain' is a valid KEY only for a commit-reveal key: a task can name "skipped" or "no output" as
  // grounds to abstain. hal_test_cases holds pass|veto only, and its parse is unchanged. The rules
  // below are unchanged too: an abstain still scores 0, and answering an abstain item is wrong.
  const keyAllowsAbstain = c.commitment !== undefined;
  const expected = c.expected === 'pass' || c.expected === 'veto' || (keyAllowsAbstain && c.expected === 'abstain') ? c.expected : null;
  return { decision: d ?? null, expected, confidence: Number.isFinite(n) ? Math.min(Math.max(n, 0), 1) : null };
}

export interface ScoringVersion { dimension: Dimension; kind: 'known_answer'; score: (c: KnownAnswerContent) => number | null }

/** null = not scorable (unparseable reply, or no answer key): no movement, no row. */
export const SCORING_VERSIONS: Record<string, ScoringVersion> = {
  // The precommitted grader rule: correct +1, abstain 0, wrong -(1 + confidence), missing confidence = 1.
  'ka-v2-precommitted': {
    dimension: 'validator',
    kind: 'known_answer',
    score: (c) => {
      const o = parseKnownAnswer(c);
      if (!o.decision || !o.expected) return null;
      if (o.decision === 'abstain') return 0;
      return o.decision === o.expected ? 1 : -(1 + (o.confidence ?? 1));
    },
  },
  // A/B comparator: confidence ignored.
  'ka-v1-symmetric': {
    dimension: 'validator',
    kind: 'known_answer',
    score: (c) => {
      const o = parseKnownAnswer(c);
      if (!o.decision || !o.expected) return null;
      if (o.decision === 'abstain') return 0;
      return o.decision === o.expected ? 1 : -1;
    },
  },
  // Calibration, a separate dimension: 0.25 - (confidence - correct)^2. A 0.5 coin flip earns 0, a sure
  // right answer +0.25, a sure wrong one -0.75. Abstain says nothing about calibration.
  'brier-v1': {
    dimension: 'calibration',
    kind: 'known_answer',
    score: (c) => {
      const o = parseKnownAnswer(c);
      if (!o.decision || !o.expected || o.decision === 'abstain') return null;
      return 0.25 - ((o.confidence ?? 1) - (o.decision === o.expected ? 1 : 0)) ** 2;
    },
  },
};

/** Versions the settle path writes today, one per dimension. */
export const ACTIVE_VERSIONS = ['ka-v2-precommitted', 'brier-v1'] as const;

// ── eligibility ─────────────────────────────────────────────────────────────────────────────
type Independence = (a: string, b: string) => Promise<PartyIndependence>;

/** The ONLY function that may return 'independent_counterparty'. Unknown, same owner or a failed lookup = not. */
export async function eligibilityFor(subjectId: string, counterpartyId: string | null, independence: Independence = (a, b) => partyIndependence(a, b)): Promise<Eligibility> {
  if (!counterpartyId || counterpartyId === subjectId) return 'same_controller_measured';
  try {
    return (await independence(subjectId, counterpartyId)) === 'independent' ? 'independent_counterparty' : 'same_controller_measured';
  } catch {
    return 'same_controller_measured';
  }
}

// ── store ───────────────────────────────────────────────────────────────────────────────────
export interface AgentRow { id: string; agent_id: string | null; agent_name: string | null }
export interface ExperimentalEventRow {
  domain: string; agent_id: string; dimension: Dimension; evidence_kind: string; evidence_id: string; evidence_ref: string;
  evidence_hash: string; oracle_id: string; counterparty_agent_id: string | null; eligibility: Eligibility;
  scoring_version: string; mode: 'shadow' | 'active'; delta: number; metadata: Record<string, unknown>;
}
type InsertResult = { ok: true; score_after: number } | { ok: false; duplicate: boolean; error: string };
export interface ExperimentalStore {
  getAgent(id: string): Promise<AgentRow | null>;
  insert(row: ExperimentalEventRow): Promise<InsertResult>;
}

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function supabaseExperimentalStore(client: Pick<SupabaseClient, 'from'> = db): ExperimentalStore {
  return {
    async getAgent(id) {
      if (!UUID_RE.test(id)) return null;
      const { data, error } = await client.from('repid_agents').select('id, agent_id, agent_name').eq('id', id).maybeSingle();
      if (error) throw new Error(`repid_agents read failed: ${error.message}`);
      return (data as AgentRow | null) ?? null;
    },
    async insert(row) {
      // score_after is assigned by the table's trigger; the writer never sends one.
      const { data, error } = await client.from(EXPERIMENTAL_TABLE).insert(row).select('score_after').single();
      if (error) return { ok: false, duplicate: (error as { code?: string }).code === '23505', error: error.message };
      return { ok: true, score_after: Number((data as { score_after: unknown }).score_after) };
    },
  };
}

/** Evidence kinds that involve a second party. None yet: a known answer is graded by a key, not a counterparty. */
const KINDS_WITH_COUNTERPARTY = new Set<string>();

// ── settlement ──────────────────────────────────────────────────────────────────────────────
export type RefuseReason =
  | 'wrong_domain' | 'unknown_version' | 'hash_mismatch' | 'subject_mismatch' | 'unknown_agent'
  | 'self_dealing' | 'oracle_not_answer_key' | 'already_consumed' | 'store_error'
  /** A commit-reveal key whose answer and nonce do not recompute the commitment. */
  | 'reveal_mismatch'
  /** A commit-reveal key in active mode: not ratified, so shadow only. */
  | 'shadow_only_oracle';
export type SettleResult =
  | { status: 'off' }
  | { status: 'not_scorable' }
  | { status: 'refused'; reason: RefuseReason; detail?: string }
  | { status: 'settled'; mode: 'shadow' | 'active'; dimension: Dimension; delta: number; score_after: number; eligibility: Eligibility; scoring_version: string };

export async function settleExperimental(
  input: { agentId: string; evidence: ExperimentalEvidence; version: string },
  deps: { store?: ExperimentalStore; mode?: ExperimentalMode; independence?: Independence } = {},
): Promise<SettleResult> {
  const mode = deps.mode ?? experimentalRepidMode();
  if (mode === 'off') return { status: 'off' };
  const { agentId, evidence: e, version } = input;
  const refuse = (reason: RefuseReason, detail?: string): SettleResult => {
    console.warn(JSON.stringify({ event: 'experimental_repid_refused', reason, evidence_id: e?.content ? evidenceId(e) : null, agent_id: agentId, version }));
    return detail ? { status: 'refused', reason, detail } : { status: 'refused', reason };
  };

  if (e.domain !== EXPERIMENTAL_DOMAIN) return refuse('wrong_domain');
  const scorer = SCORING_VERSIONS[version];
  if (!scorer || scorer.kind !== e.kind) return refuse('unknown_version');
  if (evidenceHash(e) !== e.hash) return refuse('hash_mismatch');
  if (e.subjectAgentId !== agentId) return refuse('subject_mismatch');

  const store = deps.store ?? supabaseExperimentalStore();
  let agent: AgentRow | null;
  try {
    agent = await store.getAgent(agentId);
  } catch (err) {
    return refuse('store_error', (err as Error).message);
  }
  if (!agent) return refuse('unknown_agent');
  if (agent.agent_id !== e.content.claimed_by) return refuse('subject_mismatch');
  if ([agent.id, agent.agent_id, agent.agent_name].includes(e.oracleId)) return refuse('self_dealing');
  if (e.kind === 'known_answer') {
    if (e.oracleId === COMMIT_REVEAL_ORACLE) {
      const c = e.content;
      if (!c.commitment || !c.nonce || answerCommitment(c.expected, c.nonce) !== c.commitment.toLowerCase()) return refuse('reveal_mismatch');
      if (mode === 'active') return refuse('shadow_only_oracle');
    } else if (e.oracleId !== KNOWN_ANSWER_ORACLE) {
      return refuse('oracle_not_answer_key');
    }
  }

  const delta = scorer.score(e.content);
  if (delta === null) return { status: 'not_scorable' };

  // A known answer has no counterparty, whatever the evidence says.
  const counterparty = KINDS_WITH_COUNTERPARTY.has(e.kind) ? e.counterpartyAgentId ?? null : null;
  const eligibility = await eligibilityFor(agent.id, counterparty, deps.independence);
  const o = parseKnownAnswer(e.content);
  const res = await store.insert({
    domain: EXPERIMENTAL_DOMAIN,
    agent_id: agent.id,
    dimension: scorer.dimension,
    evidence_kind: e.kind,
    evidence_id: evidenceId(e),
    evidence_ref: e.ref,
    evidence_hash: e.hash,
    oracle_id: e.oracleId,
    counterparty_agent_id: eligibility === 'independent_counterparty' ? counterparty : null,
    eligibility,
    scoring_version: version,
    mode,
    delta,
    metadata: { case_id: e.content.case_id, decision: o.decision, expected: o.expected, confidence: o.confidence, label: EXPERIMENTAL_LABEL },
  });
  if (!res.ok) return res.duplicate ? refuse('already_consumed') : refuse('store_error', res.error);
  return { status: 'settled', mode, dimension: scorer.dimension, delta, score_after: res.score_after, eligibility, scoring_version: version };
}

// ── known-answer source (read-only) ─────────────────────────────────────────────────────────
/**
 * Every answered child of the 't12-known-answer-v2' parent, joined to its answer key and its agent.
 * Reads trinity_tasks, hal_test_cases and repid_agents; writes nothing.
 */
export async function loadKnownAnswerRows(client: Pick<SupabaseClient, 'from'> = db): Promise<KnownAnswerRow[]> {
  const parents = await client.from('trinity_tasks').select('id').eq('sprint_tag', KNOWN_ANSWER_SPRINT_TAG);
  if (parents.error) throw new Error(`trinity_tasks parent read failed: ${parents.error.message}`);
  const parentIds = (parents.data ?? []).map((p: { id: number }) => p.id);
  if (!parentIds.length) return [];

  const tasks: { id: number; claimed_by: string | null; metadata: { case_id?: string } | null; result: string | null }[] = [];
  for (let from = 0; ; from += 1000) {
    const page = await client.from('trinity_tasks').select('id, claimed_by, metadata, result')
      .in('parent_task_id', parentIds).not('result', 'is', null).order('id').range(from, from + 999);
    if (page.error) throw new Error(`trinity_tasks read failed: ${page.error.message}`);
    tasks.push(...(page.data ?? []));
    if ((page.data ?? []).length < 1000) break;
  }

  const caseIds = [...new Set(tasks.map((t) => t.metadata?.case_id).filter((c): c is string => !!c))];
  const keys = new Map<string, string>();
  for (let i = 0; i < caseIds.length; i += 200) {
    const r = await client.from('hal_test_cases').select('id, expected_decision').in('id', caseIds.slice(i, i + 200));
    if (r.error) throw new Error(`hal_test_cases read failed: ${r.error.message}`);
    for (const c of r.data ?? []) keys.set(String(c.id), c.expected_decision);
  }

  const names = [...new Set(tasks.map((t) => t.claimed_by).filter((n): n is string => !!n))];
  const agents = names.length ? await client.from('repid_agents').select('id, agent_id').in('agent_id', names) : { data: [], error: null };
  if (agents.error) throw new Error(`repid_agents read failed: ${agents.error.message}`);
  const uuidOf = new Map((agents.data ?? []).map((a: { id: string; agent_id: string }) => [a.agent_id, a.id]));

  return tasks.flatMap((t) => {
    const case_id = t.metadata?.case_id;
    const expected = case_id ? keys.get(case_id) : undefined;
    const subject = t.claimed_by ? uuidOf.get(t.claimed_by) : undefined;
    if (!case_id || !expected || !subject || !t.claimed_by || t.result === null) return [];
    return [{ task_id: String(t.id), claimed_by: t.claimed_by, case_id, result: t.result, expected, subject_agent_id: subject }];
  });
}

// ── replay (no writes) ──────────────────────────────────────────────────────────────────────
export interface ReplayLine { version: string; dimension: Dimension; agent: string; n: number; skipped: number; score: number; mean: number; ci95: [number, number] | null }

/** Score historical evidence under several versions for A/B comparison. Takes no store: it cannot write. */
export function replayKnownAnswers(rows: KnownAnswerRow[], versions: string[]): ReplayLine[] {
  const out: ReplayLine[] = [];
  for (const version of versions) {
    const v = SCORING_VERSIONS[version];
    if (!v) throw new Error(`unknown scoring version ${JSON.stringify(version)}; known: ${Object.keys(SCORING_VERSIONS).join(', ')}`);
    const byAgent = new Map<string, { xs: number[]; skipped: number }>();
    for (const r of rows) {
      for (const key of [r.claimed_by, 'ALL']) {
        const g = byAgent.get(key) ?? { xs: [], skipped: 0 };
        const s = v.score(knownAnswerEvidence(r).content);
        if (s === null) g.skipped++;
        else g.xs.push(s);
        byAgent.set(key, g);
      }
    }
    for (const [agent, { xs, skipped }] of [...byAgent].sort(([a], [b]) => a.localeCompare(b))) {
      const n = xs.length;
      const score = xs.reduce((a, b) => a + b, 0);
      const mean = n ? score / n : 0;
      // ponytail: normal-approx 95% interval on the per-answer mean; n of 7-20 per agent makes it rough.
      const sd = n > 1 ? Math.sqrt(xs.reduce((a, x) => a + (x - mean) ** 2, 0) / (n - 1)) : NaN;
      const half = 1.96 * sd / Math.sqrt(n);
      out.push({ version, dimension: v.dimension, agent, n, skipped, score: round(score), mean: round(mean), ci95: n > 1 ? [round(mean - half), round(mean + half)] : null });
    }
  }
  return out;
}

const round = (x: number) => Math.round(x * 1000) / 1000;

// ── tier (pure; wired to no permission yet: that is Sean's call) ───────────────────────────
export type ExperimentalTier = 'exp-unproven' | 'exp-probation' | 'exp-measured' | 'exp-proficient';
export const TIER_MIN_N = 30;
export const TIER_PROFICIENT = { n: 100, mean: 0.5 };

/** Only ACTIVE rows count. Shadow rows never change a tier. */
export function experimentalTier(scores: { dimension: string; mode: string; n: number; score: number }[]): ExperimentalTier {
  const active = scores.filter((s) => s.mode === 'active');
  const v = active.find((s) => s.dimension === 'validator');
  if (!v || v.n < TIER_MIN_N) return 'exp-unproven';
  if (active.some((s) => Number(s.score) < 0)) return 'exp-probation';
  return v.n >= TIER_PROFICIENT.n && Number(v.score) / v.n >= TIER_PROFICIENT.mean ? 'exp-proficient' : 'exp-measured';
}
