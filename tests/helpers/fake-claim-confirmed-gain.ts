/**
 * In-memory model of public.claim_confirmed_gain
 * (migrations/2026-10-14-confirmed-gain-atomic-reservation.sql), for the suites that drive a
 * confirmed GAIN through the real updateRepId.
 *
 * The body is SYNCHRONOUS on purpose: nothing can interleave between reading the spend and booking
 * it, which is what the SQL's row lock guarantees. If the engine reintroduced a read outside this
 * call, an `await` would appear between read and write again, and the concurrency case in
 * confirmed-outcome-atomic-cap.test.ts would go red.
 *
 * It models the SQL step for step: invalid_input → lock + grant → capped_to_zero → claim (subject +
 * VERIFIED + unconsumed; the partial unique content index → content_already_claimed) →
 * receipt_not_claimable → book → granted. It proves the engine agrees with this model, NOT that the
 * .sql runs on Postgres. That is checked after apply (see the file's POST-APPLY block).
 */
export type Row = Record<string, any>;

export interface ClaimGainArgs {
  p_receipt_id: string;
  p_agent_id: string;
  p_domain: string;
  p_gain: number;
  p_day_cap: number;
  p_domain_cap: number;
}

export interface ClaimGainResultRow {
  outcome: 'invalid_input' | 'capped_to_zero' | 'content_already_claimed' | 'receipt_not_claimable' | 'granted';
  granted: number;
  day_spent: number | null;
  domain_spent: number | null;
}

/** Budget rows keyed `${agent}|${utcDay}|${budgetDomain}`; budgetDomain '' is the whole-day row. */
export type GainBudget = Map<string, number>;

export function fakeClaimConfirmedGain(
  receipts: Row[],
  budget: GainBudget,
  a: ClaimGainArgs,
  nowMs: number = Date.now(),
): ClaimGainResultRow {
  const blank = (s: unknown) => typeof s !== 'string' || s.trim() === '';
  if (blank(a.p_receipt_id) || blank(a.p_agent_id) || blank(a.p_domain) ||
      !(a.p_gain > 0) || !(a.p_day_cap >= 0) || !(a.p_domain_cap >= 0)) {
    return { outcome: 'invalid_input', granted: 0, day_spent: null, domain_spent: null };
  }
  const day = new Date(nowMs).toISOString().slice(0, 10); // (now() AT TIME ZONE 'UTC')::date
  const dayKey = `${a.p_agent_id}|${day}|`;
  const domKey = `${a.p_agent_id}|${day}|${a.p_domain}`;
  const daySpent = budget.get(dayKey) ?? 0;
  const domSpent = budget.get(domKey) ?? 0;

  const grant = Math.max(0, Math.min(a.p_gain, a.p_day_cap - daySpent, a.p_domain_cap - domSpent));
  if (grant === 0) return { outcome: 'capped_to_zero', granted: 0, day_spent: daySpent, domain_spent: domSpent };

  const r = receipts.find((x) =>
    x['receipt_id'] === a.p_receipt_id && x['subject_agent_id'] === a.p_agent_id &&
    x['verification_status'] === 'VERIFIED' && x['consumed_at'] == null);
  if (r) {
    // kernel_receipts_one_gain_per_content: (subject_agent_id, args_hash) WHERE consumed_at IS NOT NULL
    // AND verification_status = 'VERIFIED' → 23505, caught by the function.
    const dup = receipts.some((o) => o !== r && o['consumed_at'] != null && o['verification_status'] === 'VERIFIED' &&
      o['subject_agent_id'] === r['subject_agent_id'] && o['args_hash'] === r['args_hash']);
    if (dup) return { outcome: 'content_already_claimed', granted: 0, day_spent: daySpent, domain_spent: domSpent };
  } else {
    return { outcome: 'receipt_not_claimable', granted: 0, day_spent: daySpent, domain_spent: domSpent };
  }

  r['consumed_at'] = new Date(nowMs).toISOString();
  budget.set(dayKey, daySpent + grant);
  budget.set(domKey, domSpent + grant);
  return { outcome: 'granted', granted: grant, day_spent: daySpent, domain_spent: domSpent };
}

/** A supabase-js style `rpc` that serves claim_confirmed_gain from the model; anything else errors. */
export function fakeRpc(receipts: () => Row[], budget: GainBudget, onCall?: (args: ClaimGainArgs) => void) {
  return async (fn: string, args: ClaimGainArgs) => {
    if (fn !== 'claim_confirmed_gain') return { data: null, error: { code: 'PGRST202', message: `function ${fn} not found` } };
    onCall?.(args);
    return { data: [fakeClaimConfirmedGain(receipts(), budget, args)], error: null };
  };
}
