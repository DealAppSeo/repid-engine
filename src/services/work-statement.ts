/**
 * work-statement.ts — ZK BIND T1: tie a proof to the work it certifies.
 *
 * THE GAP THIS CLOSES
 * -------------------
 * `repid_zkp_proofs.statement` is `{repid_score, threshold}` — a Plonky3 range
 * proof that an agent's RepID exceeds N. It is real, and it says nothing about
 * WHICH deliverable earned it. The same proof is equally "evidence" for every
 * contract that agent ever performed, which makes it portable reputation rather
 * than evidence about a piece of work.
 *
 * WHAT T1 DOES, AND WHAT IT HONESTLY DOES NOT
 * -------------------------------------------
 * DOES: commits the proof to ONE exchange. A canonical hash over the immutable
 * facts of that exchange is stored on the contract and carried in the proof's
 * statement. Anyone holding the public receipt can RECOMPUTE the hash and check
 * it matches, so a proof cannot be replayed as evidence for a different
 * deliverable, and the exchange's facts cannot be edited after the fact without
 * the hash disagreeing.
 *
 * DOES NOT: prove the work was correct. The circuit still proves a RepID range.
 * Binding makes the proof *about this exchange*; it does not make it *about
 * quality*. Anyone describing T1 as "ZK proves the work" is overclaiming — that
 * needs a circuit over the deliverable itself, which is T2 and is not built.
 *
 * DESIGN NOTES A RED-TEAM SHOULD ATTACK
 * -------------------------------------
 * - **Determinism.** Fields are serialised in a fixed order with explicit
 *   separators and lengths. No JSON key-order dependence, no locale, no floats.
 *   Two independent implementations must agree byte-for-byte or the whole
 *   mechanism is theatre.
 * - **Domain separation.** The preimage is prefixed so this hash can never
 *   collide with a Merkle leaf, a commitment, or another domain's digest.
 * - **Malleability.** The hash covers `result_digest`, not the result body, so
 *   a large deliverable cannot be reshaped to grind a collision cheaply — and
 *   the digest itself is over the canonical JSON of the result.
 * - **Immutability window.** Computed at SETTLE and stored. A later edit to the
 *   contract row changes the recomputation and no longer matches the stored
 *   value — which is the detection, not a bug.
 * - **Privacy.** Only digests of payload and result appear. The hash is safe to
 *   publish on a receipt; the work itself never is.
 */
import { createHash } from 'node:crypto';

/** Domain separator. Changing this invalidates every previously bound proof. */
export const WORK_STATEMENT_DOMAIN = 'hyperdag/work-statement/v1';

export interface WorkStatementInput {
  contract_id: string;
  service_id: string;
  buyer_agent_id: string;
  provider_agent_id: string;
  agreed_price_usdc_raw: number | string;
  /** The x402 transaction that paid for it. '' when not yet settled. */
  settlement_tx: string | null;
  /** Verdict recorded on the deliverable, e.g. 'PASS'. */
  verdict: string | null;
  /** Buyer's satisfaction score at acceptance. */
  satisfaction_score: number | null;
  /** The request. Digested, never included whole. */
  payload: unknown;
  /** The deliverable. Digested, never included whole. */
  result: unknown;
}

/**
 * Canonical JSON: object keys sorted, no whitespace, undefined dropped.
 * `JSON.stringify` alone is insertion-ordered and would make the hash depend on
 * how a row happened to be constructed.
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value ?? null);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
}

export function digest(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value), 'utf8').digest('hex');
}

/**
 * Length-prefixed field joining. Without lengths, ("ab","c") and ("a","bc")
 * serialise identically and two different exchanges could share a hash.
 */
function bind(...fields: string[]): string {
  return fields.map((f) => `${f.length}:${f}`).join('|');
}

/** The exact bytes hashed. Exported so a third party can reproduce it. */
export function workStatementPreimage(input: WorkStatementInput): string {
  return bind(
    WORK_STATEMENT_DOMAIN,
    String(input.contract_id),
    String(input.service_id),
    String(input.buyer_agent_id),
    String(input.provider_agent_id),
    String(input.agreed_price_usdc_raw),
    String(input.settlement_tx ?? ''),
    String(input.verdict ?? '').toUpperCase(),
    input.satisfaction_score === null || input.satisfaction_score === undefined
      ? ''
      : Number(input.satisfaction_score).toFixed(4),
    digest(input.payload ?? null),
    digest(input.result ?? null)
  );
}

/** The binding commitment. `0x`-prefixed sha256 of the preimage. */
export function workStatementHash(input: WorkStatementInput): string {
  return '0x' + createHash('sha256').update(workStatementPreimage(input), 'utf8').digest('hex');
}

export interface BindingCheck {
  matches: boolean;
  expected: string;
  actual: string | null;
  reason: string;
}

/**
 * Recompute and compare. This is what a third party runs to verify that a proof
 * belongs to the exchange it claims — and what a reconciliation sweep runs to
 * detect a contract edited after settlement.
 */
export function verifyWorkStatement(input: WorkStatementInput, storedHash: string | null): BindingCheck {
  const expected = workStatementHash(input);
  if (!storedHash) {
    return { matches: false, expected, actual: null, reason: 'no work_statement_hash recorded — this proof is NOT bound to any exchange' };
  }
  const matches = storedHash.toLowerCase() === expected.toLowerCase();
  return {
    matches,
    expected,
    actual: storedHash,
    reason: matches
      ? 'the recorded hash matches a recomputation from this exchange — the proof is bound to this work and no other'
      : 'MISMATCH — the exchange facts have changed since the hash was recorded, or this proof belongs to a different exchange',
  };
}
