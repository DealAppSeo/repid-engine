/**
 * dispatch-packet.ts — the task packet a dispatched agent receives, and the check that decides
 * whether it may be claimed.
 *
 * A packet is stored with its ticket so an agent restarted from nothing but a task id can resume
 * from it. Pure: the only clock is the `now` passed in.
 *
 * Three outcomes, kept apart on purpose:
 *  - problems: the packet is unusable and is refused (a missing field, reviewer == author, ...).
 *  - flags: usable, but a reader must know (a SUPERSEDED or stale reference). Never a refusal.
 *  - operatorBlocked: valid, but a gate only the operator can open is still shut. Not claimable,
 *    and each entry names the exact action that opens it.
 */

export const PACKET_FIELDS = [
  'task_id', 'objective', 'who_benefits', 'why_now', 'expected_artifact', 'repo_and_base_sha',
  'exact_read_and_write_paths', 'allowed_environment_and_write_mode', 'prerequisite_gates',
  'authoritative_refs', 'related_failures_and_lessons', 'known_good_baseline', 'implementation_constraints',
  'verification_commands', 'positive_and_negative_controls', 'expected_results', 'lease_heartbeat_and_checkpoint',
  'retry_budget_and_stop_conditions', 'reviewer_requirements', 'handoff_and_next_action',
] as const;

export type RefStatus = 'LIVE' | 'SUPERSEDED' | 'PROPOSED';
export type RefRelationship = 'depends_on' | 'implements' | 'verified_by' | 'contradicts' | 'supersedes';
const REF_STATUSES: readonly string[] = ['LIVE', 'SUPERSEDED', 'PROPOSED'];
const RELATIONSHIPS: readonly string[] = ['depends_on', 'implements', 'verified_by', 'contradicts', 'supersedes'];

export interface AuthoritativeRef {
  source: string;
  locator: string;
  version: string;
  /** ISO date or timestamp of the last time someone checked this reference against the thing it describes. */
  last_verified: string;
  owner: string;
  status: RefStatus;
  why_it_matters: string;
  relationship?: RefRelationship;
}

export type GateStatus = 'verified' | 'blocked' | 'pending_operator';
export interface PrerequisiteGate {
  gate: string;
  /** Who can open it. `operator` (or the operator's name in OPERATOR_OWNERS) means no agent can. */
  owner: string;
  status: GateStatus;
  /** The exact action that opens the gate. Required while the gate is shut. */
  action?: string;
}

export interface ReviewerRequirements {
  author: string;
  reviewers: string[];
}

export type TaskPacket = Record<(typeof PACKET_FIELDS)[number], unknown> & {
  task_id: string;
  prerequisite_gates: PrerequisiteGate[];
  authoritative_refs: AuthoritativeRef[];
  reviewer_requirements: ReviewerRequirements;
  /** Version of this packet format; the capability ledger keys on it. */
  packet_version?: string;
};

export interface PacketCheck {
  ok: boolean;
  claimable: boolean;
  problems: string[];
  flags: string[];
  operatorBlocked: Array<{ gate: string; action: string }>;
}

/** Owners only a human can act for. Prefix match on purpose: an exact list fails open for 'sean (owner)'. */
const OPERATOR_OWNERS = ['operator', 'sean', 'owner', 'human'];
const isOperator = (owner: string) => OPERATOR_OWNERS.some((o) => owner.trim().toLowerCase().startsWith(o));
const filled = (v: unknown): boolean =>
  typeof v === 'string' ? v.trim().length > 0 : Array.isArray(v) ? v.length > 0 : !!v && typeof v === 'object' && Object.keys(v).length > 0;
const norm = (s: string) => s.trim().toLowerCase();

export const DEFAULT_STALE_DAYS = 14;

export function checkPacket(p: unknown, now: Date, staleDays: number = DEFAULT_STALE_DAYS): PacketCheck {
  const problems: string[] = [];
  const flags: string[] = [];
  const operatorBlocked: PacketCheck['operatorBlocked'] = [];
  if (!p || typeof p !== 'object' || Array.isArray(p)) {
    return { ok: false, claimable: false, problems: ['packet is not an object'], flags, operatorBlocked };
  }
  const o = p as Record<string, unknown>;

  for (const f of PACKET_FIELDS) {
    if (!(f in o)) problems.push(`missing field ${f}`);
    // "No gates" is a real answer and is written as an empty list; every other field must say something.
    else if (f !== 'prerequisite_gates' && !filled(o[f])) problems.push(`field ${f} is empty`);
  }
  const known: readonly string[] = [...PACKET_FIELDS, 'packet_version'];
  for (const k of Object.keys(o)) if (!known.includes(k)) flags.push(`unknown field ${k}: not part of the packet format, ignored`);

  const rr = o.reviewer_requirements as Partial<ReviewerRequirements> | undefined;
  if (rr && typeof rr === 'object') {
    if (typeof rr.author !== 'string' || !rr.author.trim()) problems.push('reviewer_requirements.author is missing');
    if (!Array.isArray(rr.reviewers) || rr.reviewers.length === 0) problems.push('reviewer_requirements names no reviewer');
    else if (typeof rr.author === 'string' && rr.reviewers.some((r) => typeof r !== 'string' || norm(r) === norm(rr.author!))) {
      problems.push('a reviewer is the author: self-review is not review');
    }
  }

  const gates = o.prerequisite_gates;
  if ('prerequisite_gates' in o && !Array.isArray(gates)) problems.push('prerequisite_gates is not a list');
  for (const [i, g] of (Array.isArray(gates) ? gates : []).entries()) {
    const gate = g as Partial<PrerequisiteGate>;
    const name = typeof gate?.gate === 'string' && gate.gate ? gate.gate : `#${i}`;
    if (typeof gate?.gate !== 'string' || !gate.gate.trim()) problems.push(`gate ${name} has no name`);
    if (typeof gate?.owner !== 'string' || !gate.owner.trim()) problems.push(`gate ${name} has no owner`);
    if (!['verified', 'blocked', 'pending_operator'].includes(String(gate?.status))) problems.push(`gate ${name} status ${String(gate?.status)} is not verified|blocked|pending_operator`);
    if (gate?.status === 'verified') continue;
    if (typeof gate?.action !== 'string' || !gate.action.trim()) {
      problems.push(`gate ${name} is shut and names no action that opens it`);
      continue;
    }
    // A shut gate an agent owns is work, not a block. Only an operator-owned one stops the claim.
    if (typeof gate.owner === 'string' && isOperator(gate.owner)) operatorBlocked.push({ gate: name, action: gate.action });
  }

  const refs = o.authoritative_refs;
  if (Array.isArray(refs)) {
    for (const [i, r] of refs.entries()) {
      const ref = r as Partial<AuthoritativeRef>;
      const name = typeof ref?.source === 'string' && ref.source ? ref.source : `#${i}`;
      for (const k of ['source', 'locator', 'version', 'last_verified', 'owner', 'why_it_matters'] as const) {
        if (typeof ref?.[k] !== 'string' || !String(ref[k]).trim()) problems.push(`ref ${name} is missing ${k}`);
      }
      if (!REF_STATUSES.includes(String(ref?.status))) problems.push(`ref ${name} status ${String(ref?.status)} is not LIVE|SUPERSEDED|PROPOSED`);
      if (ref?.relationship !== undefined && !RELATIONSHIPS.includes(String(ref.relationship))) problems.push(`ref ${name} relationship ${String(ref.relationship)} is unknown`);
      if (ref?.status === 'SUPERSEDED') flags.push(`ref ${name} is SUPERSEDED: find what replaced it before relying on it`);
      if (typeof ref?.last_verified === 'string' && ref.last_verified.trim()) {
        const t = Date.parse(ref.last_verified);
        if (Number.isNaN(t)) problems.push(`ref ${name} last_verified ${ref.last_verified} is not a date`);
        else if (now.getTime() - t > staleDays * 86_400_000) flags.push(`ref ${name} last verified ${ref.last_verified}, over ${staleDays} days ago: re-verify`);
        else if (t > now.getTime() + 86_400_000) problems.push(`ref ${name} last_verified ${ref.last_verified} is in the future`);
      }
    }
  } else if ('authoritative_refs' in o) problems.push('authoritative_refs is not a list');

  const ok = problems.length === 0;
  return { ok, claimable: ok && operatorBlocked.length === 0, problems, flags, operatorBlocked };
}

/**
 * Split packets before they reach the lane pool. The lane store has NO gate concept: a spec in the
 * pool is claimable whatever its packet says (measured by the restart drill, 2026-11-18). So this
 * check, run before `replenish`, is the only thing keeping an operator-gated ticket unclaimable.
 */
export function partitionForEnqueue<T extends { packet: unknown }>(items: readonly T[], now: Date) {
  const enqueue: Array<T & { check: PacketCheck }> = [];
  const operatorBlocked: Array<T & { check: PacketCheck }> = [];
  const refused: Array<T & { check: PacketCheck }> = [];
  for (const it of items) {
    const check = checkPacket(it.packet, now);
    (check.claimable ? enqueue : check.ok ? operatorBlocked : refused).push({ ...it, check });
  }
  return { enqueue, operatorBlocked, refused };
}
