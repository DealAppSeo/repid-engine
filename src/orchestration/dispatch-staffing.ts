/**
 * dispatch-staffing.ts — how many workers to run next planning pass, and why.
 *
 * Start with one builder and one independent verifier. A third only when ready work holds a lease
 * disjoint from what is held. Above three, grow by one only on sustained, absorbable demand. Shrink
 * by one when the system is already behind. Every answer carries its reason. Pure.
 *
 * I/O saturation is a shrink reason, not a hold: on 2026-11-18 seven lanes on one external disk
 * starved three checkouts for 35 minutes, so more workers there made all of them slower.
 */

export const MIN_WORKERS = 2;
export const BASE_CAP = 3;

export interface StaffingInput {
  current: number;
  /** Ready tickets whose leases are disjoint from every held lease. */
  readyIndependent: number;
  /** Ready independent tickets at the previous planning pass; fewer now means demand is shrinking. */
  readyIndependentPrevious: number;
  /** Consecutive planning passes in which independent tickets sat ready with no worker. */
  waitedPasses: number;
  /** Provider quota / rate headroom is healthy. */
  headroomHealthy: boolean;
  /** Shared disk or other I/O is saturated (checkouts stalling, installs timing out). */
  ioSaturated: boolean;
  reviewBacklog: number;
  /** How many items reviewers can absorb per pass. */
  reviewCapacity: number;
  /** Failures (retries, crashes, not-checked) are using a worker's worth of capacity. */
  failuresConsumingCapacity: boolean;
}

export interface StaffingDecision {
  next: number;
  change: -1 | 0 | 1;
  reason: string;
}

export function decideStaffing(i: StaffingInput): StaffingDecision {
  if (i.current < MIN_WORKERS) {
    return { next: MIN_WORKERS, change: 1, reason: `start: ${MIN_WORKERS} workers, one builder and one independent verifier` };
  }

  const shed: string[] = [];
  if (i.reviewBacklog > i.reviewCapacity) shed.push(`reviews backed up (${i.reviewBacklog} > ${i.reviewCapacity} per pass)`);
  if (i.readyIndependent < i.readyIndependentPrevious) shed.push(`ready independent work shrank (${i.readyIndependentPrevious} -> ${i.readyIndependent})`);
  if (i.failuresConsumingCapacity) shed.push('failures are consuming capacity');
  if (i.ioSaturated) shed.push('I/O is saturated');
  if (shed.length) {
    return i.current > MIN_WORKERS
      ? { next: i.current - 1, change: -1, reason: `shed one: ${shed.join('; ')}` }
      : { next: i.current, change: 0, reason: `hold at the floor of ${MIN_WORKERS}: ${shed.join('; ')}` };
  }

  if (i.current < BASE_CAP) {
    return i.readyIndependent > 0
      ? { next: i.current + 1, change: 1, reason: `add one: ${i.readyIndependent} ready ticket(s) hold a disjoint lease` }
      : { next: i.current, change: 0, reason: 'hold: no ready work with a disjoint lease' };
  }

  const missing: string[] = [];
  if (i.readyIndependent <= 0) missing.push('no ready independent work');
  if (i.waitedPasses < 2) missing.push(`independent work waited ${i.waitedPasses} of 2 planning passes`);
  if (!i.headroomHealthy) missing.push('headroom is not healthy');
  if (i.reviewBacklog >= i.reviewCapacity) missing.push(`review backlog ${i.reviewBacklog} leaves no room under capacity ${i.reviewCapacity}`);
  return missing.length
    ? { next: i.current, change: 0, reason: `hold at ${i.current}: ${missing.join('; ')}` }
    : { next: i.current + 1, change: 1, reason: `add one: independent work waited ${i.waitedPasses} passes, headroom healthy, reviews can absorb` };
}

export interface WorkerObservation {
  leaseValid: boolean;
  /** Last heartbeat, epoch ms. */
  heartbeatAt: number | null;
  runningTask: boolean;
  producedArtifact: boolean;
}

/** Active means all three: a valid lease, a current heartbeat, and a running task or produced artifact. A branch and a worktree are not a lease. */
export function isActiveWorker(w: WorkerObservation, nowMs: number, heartbeatTtlMs: number): { active: boolean; reason: string } {
  if (!w.leaseValid) return { active: false, reason: 'no valid lease' };
  if (w.heartbeatAt === null || nowMs - w.heartbeatAt > heartbeatTtlMs) return { active: false, reason: 'heartbeat is not current' };
  if (!w.runningTask && !w.producedArtifact) return { active: false, reason: 'holds a lease but is running nothing and produced nothing' };
  return { active: true, reason: 'valid lease, current heartbeat, and work' };
}
