/**
 * t12-lane-runner.ts — N concurrent lanes over the durable store: claim → make → check → integrate
 * → replenish, then the next task. All state is in the database, so a fresh process continues where
 * a dead one stopped; nothing here is remembered between runs.
 *
 * Each lane does whatever is due, in the order that frees capacity first: finish verified work,
 * check someone else's, then start new work. It stops when nothing can move, when the stop switch
 * is set, or at `maxSteps`. It does not schedule itself; arming a schedule is an owner decision.
 */
import {
  PublishRefused, acquireWake, checkoutBelt, claimMake, claimStage, heartbeat, recordIntegration, recordVerdict, recoverStages, refuseIntegration, releaseMake, releaseWake, replenish, submit, waitForCapacity,
  type Handle, type ReceiptOrigin, type LaneSpec, type ReplenishReport, type Submission, type TxDb, type Verdict,
} from './t12-lane-store';
import { randomUUID } from 'node:crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import { shouldParkForHalt } from '../services/emergency-halt';
import { HEARTBEAT_TTL_MS } from './write-lease';

/** Read in one place so a flag cannot be spelled two ways. Each is off unless exactly `true`. */
export function laneFlags(): { enabled: boolean; allowExec: boolean; publish: boolean; allowPrivilegedDb: boolean } {
  return {
    allowPrivilegedDb: process.env.T12_LANES_ALLOW_PRIVILEGED_DB === 'true',
    enabled: process.env.T12_LANES_ENABLED === 'true',
    allowExec: process.env.T12_LANES_ALLOW_EXEC === 'true',
    publish: process.env.T12_LANES_PUBLISH === 'true',
  };
}

export type MakeOutcome =
  | { ok: true; submission: Submission }
  | { ok: false; kind: 'rate_limited' | 'route_failed' | 'infra' | 'maker_failed'; reason: string }
  | { ok: false; kind: 'no_capacity'; until: string; reason: string };

export interface LaneAdapters {
  make(h: Handle, signal: AbortSignal): Promise<MakeOutcome>;
  check(h: Handle): Promise<Verdict>;
  /** Must be idempotent per branch: a crash after publishing re-runs this. */
  publish(h: Handle): Promise<{ url: string }>;
}

/** Which stages a run may claim. Roles on separate machines hold separate credentials. */
export type LaneRole = 'all' | 'maker' | 'checker' | 'integrator';

export interface RunLanesOptions {
  db: TxDb;
  /** Defaults to 'all', one process doing every stage. */
  role?: LaneRole;
  /** Reads the global emergency halt, which every lane obeys before taking any step. */
  haltClient: Pick<SupabaseClient, 'from'>;
  /** What started this run. The first decision each lane makes is attributed to it. */
  wake?: Extract<ReceiptOrigin, 'human_prompt' | 'scheduled'>;
  lanes: readonly string[];
  adapters: LaneAdapters;
  /** Without this, verified work waits at `approved` and nothing is published. */
  publishEnabled: boolean;
  /** False on a host that may not run model-written code: submissions wait for one that may. */
  checkEnabled?: boolean;
  idleMs?: number;
  specs: () => readonly LaneSpec[];
  readyTarget: number;
  stop?: () => boolean;
  log?: (line: string) => void;
  heartbeatMs?: number;
  dailyCap?: number;
  maxSteps?: number;
}

export interface RunReport {
  made: number;
  approved: number;
  rejected: number;
  notChecked: number;
  integrated: number;
  waiting: number;
  fenceRefused: string[];
  duplicateWakes: string[];
  errors: string[];
  paused: string | null;
  replenish: ReplenishReport | null;
  stoppedBy: 'idle' | 'stop_switch' | 'max_steps' | 'errors' | 'emergency_halt';
}

type Did = 'worked' | 'idle';
const MAX_ERRORS = 10;
/** A route that keeps failing without cooling would otherwise loop. Real routes cool, so this is the backstop. */
const MAX_ROUTE_RETRIES = 12;
const WAKE_TTL_SECONDS = 180;
const WAKE_RENEW_MS = 60_000;

export async function runLanes(o: RunLanesOptions): Promise<RunReport> {
  const log = o.log ?? (() => {});
  const report: RunReport = {
    made: 0, approved: 0, rejected: 0, notChecked: 0, integrated: 0, waiting: 0, fenceRefused: [], duplicateWakes: [], errors: [], paused: null, replenish: null, stoppedBy: 'idle',
  };
  const maxSteps = o.maxSteps ?? 200;
  let steps = 0;
  // A check that could not run says nothing about the work. Retrying at once would only burn the
  // task's not-checked allowance on one outage, so checks wait for the next run.
  let checksHeld = false;
  let routeRetries = 0;
  const wakeId = randomUUID();
  const role = o.role ?? 'all';
  const mayMake = role === 'all' || role === 'maker';
  const wake = o.wake ?? 'human_prompt';
  const firstStepDone = new Set<string>();
  /** The wake gets credit for each lane's first decision. Everything after, the lane chose itself. */
  const originFor = (lane: string): ReceiptOrigin => (firstStepDone.has(lane) ? 'autonomous' : wake);

  const refused = (where: string, reason: string) => {
    report.fenceRefused.push(`${where}: ${reason}`);
    log(`fence refused ${where}: ${reason}`);
  };

  async function makeOne(h: Handle): Promise<void> {
    const ac = new AbortController();
    const beat = setInterval(() => {
      heartbeat(o.db, h)
        .then((r) => {
          // Only a fence refusal stops the work: a transient database error is not a lost lease.
          if (!r.ok && r.fenced) ac.abort();
        })
        .catch((e) => log(`heartbeat failed for ${h.taskId}: ${String(e)}`));
    }, o.heartbeatMs ?? HEARTBEAT_TTL_MS / 3);
    try {
      let out: MakeOutcome;
      try {
        const belt = await checkoutBelt(o.db, h);
        if (!belt.ok) refused(`belt ${h.taskId}`, belt.reason);
        out = belt.ok ? await o.adapters.make(h, ac.signal) : { ok: false, kind: 'maker_failed', reason: `belt denied: ${belt.reason}` };
      } catch (e) {
        out = { ok: false, kind: 'infra', reason: `maker threw: ${e instanceof Error ? e.message : String(e)}` };
      }
      if (ac.signal.aborted) {
        refused(`make ${h.taskId}`, 'lease lost during execution; output discarded');
        return;
      }
      if (out.ok) {
        const r = await submit(o.db, h, out.submission);
        if (r.ok) report.made++;
        else refused(`submit ${h.taskId}`, r.reason);
        return;
      }
      if (out.kind === 'no_capacity') {
        const w = await waitForCapacity(o.db, h, out.until, out.reason);
        if (w.ok) report.waiting++;
        else refused(`wait ${h.taskId}`, w.reason);
        // Stops new makes only. Checks and publishes need no model and carry on.
        report.paused = `WAITING_FOR_CAPACITY until ${out.until}`;
        return;
      }
      // Without this, a broken host-independent fault loops straight back to the same row.
      if (out.kind === 'infra') report.paused = `infra: ${out.reason}`;
      // A rate limit is not a reason to stop: the route has cooled, so the next claim goes elsewhere.
      if ((out.kind === 'rate_limited' || out.kind === 'route_failed') && ++routeRetries >= MAX_ROUTE_RETRIES) {
        report.paused = `route retries exhausted: ${out.reason}`;
      }
      const r = await releaseMake(o.db, h, out.reason, out.kind !== 'maker_failed');
      if (!r.ok) refused(`release ${h.taskId}`, r.reason);
    } finally {
      clearInterval(beat);
    }
  }

  async function checkOne(h: Handle): Promise<void> {
    let v: Verdict;
    try {
      v = await o.adapters.check(h);
    } catch (e) {
      // A checker that could not run has said nothing about the work.
      v = { outcome: 'not_checked', reason: `checker threw: ${e instanceof Error ? e.message : String(e)}` };
    }
    const r = await recordVerdict(o.db, h, v);
    if (!r.ok) return refused(`verdict ${h.taskId}`, r.reason);
    if (v.outcome === 'approved') report.approved++;
    else if (v.outcome === 'rejected') report.rejected++;
    else {
      report.notChecked++;
      checksHeld = true;
    }
  }

  async function integrateOne(h: Handle): Promise<void> {
    let url: string;
    try {
      ({ url } = await o.adapters.publish(h));
    } catch (e) {
      if (!(e instanceof PublishRefused)) throw e;
      refused(`publish ${h.taskId}`, e.message);
      const ended = await refuseIntegration(o.db, h, e.message);
      if (!ended.ok) refused(`refuse ${h.taskId}`, ended.reason);
      return;
    }
    const r = await recordIntegration(o.db, h, url);
    if (r.ok) report.integrated++;
    else refused(`integrate ${h.taskId}`, r.reason);
  }

  async function step(lane: string): Promise<Did> {
    await recoverStages(o.db);
    if (o.publishEnabled && (role === 'all' || role === 'integrator')) {
      const h = await claimStage(o.db, 'approved', lane, originFor(lane));
      if (h) {
        // A publish failure leaves the claim to recoverStages, so it retries instead of stranding.
        await integrateOne(h).catch((e) => log(`publish failed for ${h.taskId}: ${String(e)}`));
        return 'worked';
      }
    }
    const mayCheck = role === 'all' || role === 'checker';
    const check = !mayCheck || o.checkEnabled === false || checksHeld ? null : await claimStage(o.db, 'awaiting_check', lane, originFor(lane));
    if (check) {
      await checkOne(check);
      return 'worked';
    }
    if (report.paused || !mayMake) return 'idle';
    const claim = await claimMake(o.db, lane, { dailyCap: o.dailyCap, origin: originFor(lane) });
    if (claim.kind === 'paused') {
      report.paused = claim.reason;
      return 'idle';
    }
    if (claim.kind === 'claimed') {
      await makeOne(claim.handle);
      return 'worked';
    }
    return 'idle';
  }

  // A lane cannot check its own work, so it must not leave while another lane may still produce
  // some. It exits only after a full idle pass in which nothing anywhere moved.
  let progress = 0;
  let busy = 0;

  async function laneLoop(lane: string): Promise<void> {
    if (!(await acquireWake(o.db, lane, wakeId, WAKE_TTL_SECONDS))) {
      report.duplicateWakes.push(lane);
      log(`lane ${lane} is already running; this wake leaves`);
      return;
    }
    held.add(lane);
    let seen = -1;
    for (;;) {
      if (o.stop?.()) {
        report.stoppedBy = 'stop_switch';
        return;
      }
      if (steps >= maxSteps) {
        report.stoppedBy = 'max_steps';
        return;
      }
      if (await shouldParkForHalt(o.haltClient, 'T12Lanes')) {
        report.stoppedBy = 'emergency_halt';
        return;
      }
      busy++;
      try {
        if ((await step(lane)) === 'worked') {
          firstStepDone.add(lane);
          steps++;
          progress++;
          continue;
        }
        if (!report.paused && mayMake) {
          // Automatic continuation: nothing to do, so refill from vetted specs and go again.
          const r = await replenish(o.db, o.specs(), o.readyTarget);
          report.replenish = r;
          if (r.underflow) log(r.underflow);
          if (r.inserted.length > 0) {
            progress++;
            continue;
          }
        }
      } catch (e) {
        // One dropped connection must not take the sibling lanes down mid-work.
        report.errors.push(e instanceof Error ? e.message : String(e));
        log(`lane ${lane}: ${report.errors.at(-1)}`);
        if (report.errors.length >= MAX_ERRORS) {
          report.stoppedBy = 'errors';
          return;
        }
      } finally {
        busy--;
      }
      if (busy === 0 && seen === progress) return;
      seen = progress;
      await new Promise((resolve) => setTimeout(resolve, o.idleMs ?? 2000));
    }
  }

  // One timer keeps every held wake alive through long model calls and checks. It also notices a
  // halt, so a long step ending finds it already recorded.
  const held = new Set<string>();
  let haltSeen = false;
  const renew = setInterval(() => {
    for (const lane of held) void acquireWake(o.db, lane, wakeId, WAKE_TTL_SECONDS).catch(() => undefined);
    void shouldParkForHalt(o.haltClient, 'T12LanesRenew').then((h) => { haltSeen = h; }, () => undefined);
  }, WAKE_RENEW_MS);
  try {
    await Promise.all(o.lanes.map(laneLoop));
  } finally {
    clearInterval(renew);
    await Promise.all([...held].map((lane) => releaseWake(o.db, lane, wakeId).catch(() => undefined)));
  }
  if (haltSeen && report.stoppedBy === 'idle') report.stoppedBy = 'emergency_halt';
  return report;
}
