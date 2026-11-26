/**
 * Which queued work goes next. Order only: no database, no model, no clock.
 *
 * Ported from the conductor prototype (next-cards.mjs, 2026-11-24). In its trial, agents filtered
 * eligible work 24 of 24 times but put failed work first in only 5 of 11 plans, so order is code.
 * Only the rules the lane feeder lacked are here. Dedup by spec id, the claim limit and "never
 * invent filler" already live in replenish() and claimMake() and are not repeated.
 *
 * Callers: replenish() and claimMake() in t12-lane-store.ts.
 *
 * Rules, in this order:
 *  1. Work in a frozen work lane is not offered, failed or new. (The prototype let a failed card
 *     through a freeze; here a freeze holds.)
 *  2. Horizons are scanned in order on every call: immediate, near, long.
 *  3. Inside a horizon, work whose last attempt failed comes back first as a fix, oldest failure
 *     first; then new work in input order, so the caller's own order (priority, age, file order)
 *     still decides ties. (The prototype put every failed card ahead of all horizons. The owner's
 *     rule, 2026-11-24, is failed first within each horizon: a failed long-term card does not
 *     jump an immediate one.)
 *  4. No id twice. Everything not picked is in `skipped` with a reason.
 */

import vm from 'node:vm';

export const HORIZONS = ['immediate', 'near', 'long'] as const;
export type Horizon = (typeof HORIZONS)[number];

export interface FeedItem {
  id: string;
  /** Absent ranks as `near`, so specs written before horizons existed keep their order. */
  horizon?: Horizon;
  /** A topic such as `outreach`. Not a worker lane (`trinity-lane-1`). */
  workLane?: string;
  /** ISO time of the failure, when the last attempt at this work failed. */
  failedAt?: string | null;
  /** Why this may not be offered now, decided by the caller (already queued, owner is a person). */
  blocked?: string | null;
}

export interface FeedPick {
  id: string;
  kind: 'fix' | 'new';
  reason: string;
}

export interface FeedOrder {
  picks: FeedPick[];
  skipped: Array<{ id: string; reason: string }>;
}

export function orderFeed(items: readonly FeedItem[], opts: { frozen?: readonly string[]; limit?: number } = {}): FeedOrder {
  const frozen = new Set(opts.frozen ?? []);
  const limit = opts.limit ?? Infinity;
  if (!(limit >= 0)) throw new Error(`orderFeed: limit must be 0 or more, got ${String(opts.limit)}`);

  const skipped: FeedOrder['skipped'] = [];
  const seen = new Set<string>();
  const fixes: Record<Horizon, Array<FeedPick & { t: number }>> = { immediate: [], near: [], long: [] };
  const fresh: Record<Horizon, FeedPick[]> = { immediate: [], near: [], long: [] };

  for (const it of items) {
    if (seen.has(it.id)) {
      skipped.push({ id: it.id, reason: 'listed twice; the first entry stands' });
      continue;
    }
    seen.add(it.id);
    if (it.workLane !== undefined && frozen.has(it.workLane)) skipped.push({ id: it.id, reason: `work lane ${it.workLane} is frozen` });
    else if (it.blocked) skipped.push({ id: it.id, reason: it.blocked });
    else {
      const h = it.horizon ?? 'near';
      if (!HORIZONS.includes(h)) throw new Error(`orderFeed: ${it.id} has horizon ${String(h)}; use ${HORIZONS.join(', ')}`);
      if (it.failedAt) {
        const t = Date.parse(it.failedAt);
        // A fix queue ordered on an unreadable time would be a guess.
        if (Number.isNaN(t)) throw new Error(`orderFeed: ${it.id} has an unreadable failure time: ${it.failedAt}`);
        fixes[h].push({ id: it.id, kind: 'fix', reason: `last attempt failed at ${it.failedAt}, horizon ${h}`, t });
      } else fresh[h].push({ id: it.id, kind: 'new', reason: `eligible, horizon ${h}` });
    }
  }

  const queue: FeedPick[] = HORIZONS.flatMap((h) => [...fixes[h].sort((a, b) => a.t - b.t).map(({ t: _t, ...p }) => p), ...fresh[h]]);
  const picks = queue.slice(0, limit);
  for (const q of queue.slice(picks.length)) skipped.push({ id: q.id, reason: `${q.reason}; not picked, limit of ${limit} reached` });
  return { picks, skipped };
}

/**
 * Spec fields that ride in `context` as `meta:` entries, so the spec format does not fork
 * (WORK_CASCADE_2026-11-16 section 2). `context` is otherwise a list of files read from disk and
 * sent to the model; a `meta:` entry is never read as a file.
 *
 *   meta:horizon=immediate|near|long
 *   meta:work_lane=<topic>
 *   meta:breaker                             a second agent on another model family must check the maker's answer
 *   meta:delivery_contract.pattern=<regex>   a JavaScript regular expression, no flags
 *   meta:delivery_contract.min_lines=<n>     how many lines must match; 1 when absent
 *
 * The contract has the shape trinity-symphony-shared reads from metadata.delivery_contract.
 * INERT in the lane runner: lanes check a commit with a test runner, and the checker stage is a
 * test run, not a second model. The reader today is scripts/t12/delivery-check.ts.
 */
export const META_PREFIX = 'meta:';
export const MAX_PATTERN_CHARS = 200;
const WORK_LANE = /^[a-z0-9][a-z0-9_-]{0,39}$/;

export interface DeliveryContract {
  pattern: string;
  min_lines: number;
}

export interface SpecMeta {
  horizon?: Horizon;
  workLane?: string;
  breaker: boolean;
  deliveryContract?: DeliveryContract;
}

export const isMetaEntry = (p: unknown): p is string => typeof p === 'string' && p.startsWith(META_PREFIX);

/** The `meta:` fields of a spec's context, and why any of them cannot be used. Never throws. */
export function specMeta(context: unknown): { meta: SpecMeta; problems: string[] } {
  const meta: SpecMeta = { breaker: false };
  const problems: string[] = [];
  const seen = new Set<string>();
  let pattern: string | undefined;
  let minLines: number | undefined;
  for (const entry of Array.isArray(context) ? context.filter(isMetaEntry) : []) {
    const body = entry.slice(META_PREFIX.length);
    const eq = body.indexOf('=');
    const key = eq === -1 ? body : body.slice(0, eq);
    const value = eq === -1 ? undefined : body.slice(eq + 1);
    if (seen.has(key)) {
      problems.push(`meta ${key} is given twice`);
      continue;
    }
    seen.add(key);
    if (key === 'breaker') {
      if (value !== undefined) problems.push('meta breaker takes no value');
      else meta.breaker = true;
    } else if (key === 'horizon') {
      if (HORIZONS.includes(value as Horizon)) meta.horizon = value as Horizon;
      else problems.push(`meta horizon must be ${HORIZONS.join(', ')}`);
    } else if (key === 'work_lane') {
      if (value !== undefined && WORK_LANE.test(value)) meta.workLane = value;
      else problems.push('meta work_lane must be a short lower-case name');
    } else if (key === 'delivery_contract.pattern') {
      if (!value) problems.push('meta delivery_contract.pattern is empty');
      else if (value.length > MAX_PATTERN_CHARS) problems.push(`meta delivery_contract.pattern is longer than ${MAX_PATTERN_CHARS} characters`);
      else {
        // Compiled where it is later run (t12-delivery-check.ts): in a separate context under a time
        // limit, never in this one. The pattern is data from a spec or a task row.
        try {
          vm.runInNewContext('new RegExp(pattern); true', { pattern: value }, { timeout: 250 });
          pattern = value;
        } catch {
          problems.push('meta delivery_contract.pattern is not a valid regular expression');
        }
      }
    } else if (key === 'delivery_contract.min_lines') {
      const n = Number(value);
      if (value && Number.isInteger(n) && n >= 1) minLines = n;
      else problems.push('meta delivery_contract.min_lines must be a whole number of at least 1');
    } else problems.push(`meta ${key} is not a known field`);
  }
  if (pattern !== undefined) meta.deliveryContract = { pattern, min_lines: minLines ?? 1 };
  else if (seen.has('delivery_contract.min_lines') && !seen.has('delivery_contract.pattern')) problems.push('meta delivery_contract.min_lines needs a delivery_contract.pattern');
  return { meta, problems };
}
