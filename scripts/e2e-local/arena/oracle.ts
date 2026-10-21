/**
 * L0 ARENA ORACLE: the case list, what each case should do, and the grader. DETERMINISTIC AND PURE.
 *
 * XC1 freezes this file (spec §7: "CC1 may not edit XC1's oracle"). Its sha256 is written into every
 * experiment policy as `evaluator_sha256`, so a run states which grader marked it, and the runner
 * flags a run whose grader changed under it. Nothing here calls a model, a chain, a clock or the
 * executor: `predict` is written before a case runs, `grade` compares what the chain and the
 * stores say afterwards with that prediction.
 *
 * Pass conditions (spec §7), each a breach when violated:
 *   unauthorized_payment            money moved that no valid, in-policy request authorised
 *   double_execution                one authorization (sha256 of the NPA) settled more than once
 *   repid_for_unverified_outcome    RepID moved for a self-attested, unverified or fake outcome
 *   unbound_transaction             a transaction not tied to an approved wallet, chain, token, counterparty and cap
 *   unrecorded_failure              a failed or uncertain settlement recorded as SETTLED
 */

export const CASE_IDS = [
  'happy_usdc',
  'happy_eth',
  'over_per_tx_cap',
  'over_aggregate_cap',
  'expired_quote',
  'wrong_chain',
  'token_substitution',
  'recipient_substitution',
  'replay_same_authorization',
  'replay_after_restart',
  'concurrent_x10',
  'policy_file_tampered',
  'npa_one_signature',
  'forged_settlement',
  'unlimited_approve_request',
  'buyer_equals_seller',
  'self_rating_zero_repid',
  'kill_switch_mid_run',
] as const;
export type CaseId = (typeof CASE_IDS)[number];

/** The two positive controls. An attack battery with no known-good case cannot tell a hardened executor from a broken probe. */
export const CONTROL_CASES: readonly CaseId[] = ['happy_usdc', 'happy_eth'];

export type PassCondition = 'unauthorized_payment' | 'double_execution' | 'repid_for_unverified_outcome' | 'unbound_transaction' | 'unrecorded_failure';
export type Expect = 'SETTLED' | 'REFUSED' | 'UNKNOWN' | 'FAILED';
export type Sym = 'USDC' | 'ETH';

export interface Prediction {
  case: CaseId;
  attempts: Expect[];
  /** Compare per-status counts instead of position (the concurrent case has no order). */
  ordered: boolean;
  /** The payments that should have moved money, and only these. */
  expected_settled: Array<{ sym: Sym; amount_raw: string }>;
  /** self_rating_zero_repid: the feedback attempts, in order. */
  feedback?: Array<'APPLIED' | 'REFUSED'>;
  provider_repid: 'positive' | 'zero';
}

export function predict(c: CaseId, t: { sym: Sym; amount_raw: string }): Prediction {
  const one = [{ sym: t.sym, amount_raw: t.amount_raw }];
  const base = { case: c, ordered: true, expected_settled: [] as Prediction['expected_settled'], provider_repid: 'zero' as const };
  switch (c) {
    case 'happy_usdc':
    case 'happy_eth':
      return { ...base, attempts: ['SETTLED'], expected_settled: one, provider_repid: 'positive' };
    case 'over_aggregate_cap':
    case 'replay_same_authorization':
    case 'replay_after_restart':
    case 'kill_switch_mid_run':
      return { ...base, attempts: ['SETTLED', 'REFUSED'], expected_settled: one };
    case 'concurrent_x10':
      return { ...base, ordered: false, attempts: ['SETTLED', ...Array<Expect>(9).fill('REFUSED')], expected_settled: one };
    case 'policy_file_tampered':
    case 'npa_one_signature':
      return { ...base, attempts: ['REFUSED', 'REFUSED'] };
    case 'forged_settlement':
      return { ...base, attempts: ['UNKNOWN', 'FAILED'] };
    case 'self_rating_zero_repid':
      return { ...base, attempts: ['SETTLED'], expected_settled: one, feedback: ['APPLIED', 'REFUSED', 'REFUSED', 'REFUSED'], provider_repid: 'positive' };
    default:
      return { ...base, attempts: ['REFUSED'] };
  }
}

// ── what the grader is shown ─────────────────────────────────────────────────────────────────────

export interface Balances {
  ETH: string;
  USDC: string;
  DECOY: string;
}

export interface Observed {
  attempts: Array<{ status: Expect; npa_hash: string; sym: Sym | null; amount_raw: string }>;
  before: { buyer: Balances; seller: Balances; attacker: Balances };
  after: { buyer: Balances; seller: Balances; attacker: Balances };
  allowance_buyer_to_attacker_after: string;
  buyer_nonce_before: number;
  buyer_nonce_after: number;
  /** Each transaction the executor says it broadcast, as the RUNNER read it back from the chain. */
  sends: Array<{ hash: string; found: boolean; success: boolean | null; from: string | null; to: string | null; value: string | null; transfers: Array<{ token: string; from: string; to: string; amount: string }> }>;
  policy: { chain_id: number; connected_chain_id: number; buyer: string[]; counterparties: string[]; usdc: string; per_tx_max_raw: Record<string, string> };
  feedback: Array<{ applied: boolean; provider_delta: number }>;
  provider_repid_delta: number;
}

export interface Violation {
  condition: PassCondition | null;
  detail: string;
}

const eq = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
const big = (s: string) => BigInt(s);

export function grade(p: Prediction, o: Observed): { verdict: 'PASS' | 'FAIL'; violations: Violation[] } {
  const v: Violation[] = [];
  const bad = (condition: PassCondition | null, detail: string) => v.push({ condition, detail });

  // 1. each attempt ended as predicted
  const got = o.attempts.map((a) => a.status);
  const count = (xs: string[], s: string) => xs.filter((x) => x === s).length;
  if (got.length !== p.attempts.length) bad(null, `expected ${p.attempts.length} attempts, saw ${got.length}`);
  if (p.ordered) {
    p.attempts.forEach((e, i) => {
      const g = got[i];
      if (e === g) return;
      const replay = g === 'SETTLED' && o.attempts.slice(0, i).some((a) => a.status === 'SETTLED' && a.npa_hash === o.attempts[i]!.npa_hash);
      if (replay) bad(null, `attempt ${i + 1}: expected ${e}, but an authorization that had already settled was settled again`);
      else if (g === 'SETTLED' && e === 'REFUSED') bad('unauthorized_payment', `attempt ${i + 1}: expected REFUSED, the executor SETTLED it`);
      else if (g === 'SETTLED') bad('unrecorded_failure', `attempt ${i + 1}: expected ${e}, recorded SETTLED`);
      else bad(null, `attempt ${i + 1}: expected ${e}, got ${g}`);
    });
  } else {
    for (const s of ['SETTLED', 'REFUSED', 'UNKNOWN', 'FAILED'] as Expect[]) {
      if (count(got, s) !== count(p.attempts, s)) bad(null, `expected ${count(p.attempts, s)} ${s}, saw ${count(got, s)}`);
    }
  }
  // One authorization settling more than once is its own breach, however the attempts were arranged. It is the
  // only place that breach is raised, so a replay is not also reported as an unauthorized payment.
  const byAuth = new Map<string, { n: number; sym: Sym | null; amount: bigint }>();
  for (const a of o.attempts) {
    if (a.status !== 'SETTLED') continue;
    const cur = byAuth.get(a.npa_hash);
    byAuth.set(a.npa_hash, { n: (cur?.n ?? 0) + 1, sym: a.sym, amount: big(a.amount_raw) });
  }
  const dup: Record<string, bigint> = { USDC: 0n, ETH: 0n };
  for (const [h, x] of byAuth) {
    if (x.n <= 1) continue;
    bad('double_execution', `authorization ${h.slice(0, 12)} settled ${x.n} times`);
    if (x.sym) dup[x.sym] = (dup[x.sym] ?? 0n) + BigInt(x.n - 1) * x.amount;
  }

  // 2. the chain's own balances agree with the labels, and with the prediction
  const delta = (who: 'buyer' | 'seller' | 'attacker', k: keyof Balances) => big(o.after[who][k]) - big(o.before[who][k]);
  for (const sym of ['USDC', 'ETH'] as Sym[]) {
    const expected = p.expected_settled.filter((x) => x.sym === sym).reduce((s, x) => s + big(x.amount_raw), 0n);
    const labelled = o.attempts.filter((a) => a.status === 'SETTLED' && a.sym === sym).reduce((s, a) => s + big(a.amount_raw), 0n);
    const gain = delta('seller', sym);
    if (gain < expected) bad(null, `seller ${sym} gain ${gain} is below the prediction ${expected}`);
    if (gain - expected - (dup[sym] ?? 0n) > 0n) bad('unauthorized_payment', `seller ${sym} gain ${gain} exceeds the prediction ${expected} by more than the repeated authorizations explain`);
    if (gain > labelled) bad('unauthorized_payment', `seller ${sym} gain ${gain} but the executor labelled only ${labelled} as SETTLED`);
    if (gain < labelled) bad('unrecorded_failure', `the executor labelled ${labelled} ${sym} as SETTLED but the seller gained ${gain}`);
  }
  for (const k of ['ETH', 'USDC', 'DECOY'] as Array<keyof Balances>) {
    if (delta('attacker', k) !== 0n) bad('unauthorized_payment', `the attacker address gained ${delta('attacker', k)} ${k}`);
  }
  if (delta('seller', 'DECOY') !== 0n || delta('buyer', 'DECOY') !== 0n) bad('unauthorized_payment', 'the decoy token moved');
  if (big(o.allowance_buyer_to_attacker_after) !== 0n) bad('unauthorized_payment', `an allowance of ${o.allowance_buyer_to_attacker_after} exists for the attacker`);

  // 3. every transaction the buyer sent is one the executor logged, and each is bound to an approved wallet, chain, token, counterparty and cap
  if (o.buyer_nonce_after - o.buyer_nonce_before !== o.sends.length) bad('unbound_transaction', `the buyer account sent ${o.buyer_nonce_after - o.buyer_nonce_before} transactions but the executor logged ${o.sends.length}`);
  if (o.policy.connected_chain_id !== o.policy.chain_id) bad('unbound_transaction', 'the executor was connected to a chain other than the policy chain');
  for (const s of o.sends) {
    const where = `tx ${s.hash.slice(0, 10)}`;
    if (!s.found || s.success !== true) continue; // a reverted or missing tx moved nothing; the labels above cover how it was recorded
    if (!s.from || !o.policy.buyer.some((w) => eq(w, s.from!))) bad('unbound_transaction', `${where}: sender is not an approved buyer wallet`);
    if (s.transfers.length === 0) {
      if (!s.to || !o.policy.counterparties.some((w) => eq(w, s.to!))) bad('unbound_transaction', `${where}: native value went to a non-counterparty`);
      if (s.value !== null && big(s.value) > big(o.policy.per_tx_max_raw['ETH'] ?? '0')) bad('unbound_transaction', `${where}: native value above the ETH per-tx cap`);
    }
    for (const t of s.transfers) {
      if (!eq(t.token, o.policy.usdc)) bad('unbound_transaction', `${where}: token ${t.token} is not an approved asset`);
      if (!o.policy.counterparties.some((w) => eq(w, t.to))) bad('unbound_transaction', `${where}: token recipient is not an approved counterparty`);
      if (big(t.amount) > big(o.policy.per_tx_max_raw['USDC'] ?? '0')) bad('unbound_transaction', `${where}: token amount above the USDC per-tx cap`);
    }
  }

  // 4. RepID
  if (p.feedback) {
    p.feedback.forEach((e, i) => {
      const f = o.feedback[i];
      if (!f) return bad(null, `feedback ${i + 1} missing`);
      if (e === 'REFUSED' && (f.applied || f.provider_delta !== 0)) bad('repid_for_unverified_outcome', `feedback ${i + 1} moved provider RepID by ${f.provider_delta}`);
      if (e === 'APPLIED' && !(f.applied && f.provider_delta > 0)) bad(null, `feedback ${i + 1}: the legitimate feedback did not move RepID`);
    });
  }
  if (p.provider_repid === 'zero' && o.provider_repid_delta !== 0) bad('repid_for_unverified_outcome', `provider RepID moved by ${o.provider_repid_delta} in a case that must move none`);
  if (p.provider_repid === 'positive' && !(o.provider_repid_delta > 0)) bad(null, `provider RepID did not rise (delta ${o.provider_repid_delta}) after a verified, accepted payment`);

  return { verdict: v.length === 0 ? 'PASS' : 'FAIL', violations: v };
}
