/**
 * Execution Floor — the "execution beats explanation" law.
 *
 *   THE LAW: when a claim is deterministically checkable AND was executed, the
 *   checker's result is AUTHORITATIVE. An LLM / HAL opinion about that specific
 *   claim is INADMISSIBLE — it cannot overturn a determined fact. Explanation
 *   never outranks execution.
 *
 * This is the primacy layer that sits in FRONT of HAL's probabilistic
 * cross-LLM machinery. HAL asks many models what they *believe*; the floor
 * first asks: is any of this simply CHECKABLE? If a claim is arithmetic, or an
 * on-chain fact, we compute the answer and stop arguing about it.
 *
 * SHADOW-FIRST: gated behind EXECUTION_FLOOR_ENABLED (default OFF). When OFF
 * (shadow), the floor still COMPUTES its verdicts and they can be logged, but
 * `applyToHal()` returns the HAL decision UNCHANGED — zero live behavior change
 * until the flag is deliberately flipped after measurement.
 *
 * SAFETY: only arithmetic (pure numeric parser, no eval) and on-chain reads
 * (existing ethers read path) are ACTUALLY executed. `code` and `db` claims are
 * recognized but marked `executed:false` / "executable-but-not-run" — we do not
 * run shell, arbitrary code, or unscoped queries. Honesty over faked execution.
 */

import { extractTypedClaims, type TypedClaim, type Relation } from './claim-typing';
import { safeEvalArithmetic } from './safe-arithmetic';

// ---------------------------------------------------------------------------
// Flag
// ---------------------------------------------------------------------------

/**
 * Master flag. Default OFF (shadow). When 'true', `applyToHal()` lets a
 * determined executable verdict OVERRIDE the HAL decision for that claim.
 * When OFF, verdicts are computed + returned for logging but never change the
 * live HAL decision.
 */
export function executionFloorEnabled(): boolean {
  return (process.env.EXECUTION_FLOOR_ENABLED || '').toLowerCase() === 'true';
}

// ---------------------------------------------------------------------------
// Verdict types
// ---------------------------------------------------------------------------

export type FloorChecker = 'arithmetic' | 'onchain' | 'db' | 'code' | 'none';

export interface FloorVerdict {
  /** The claim this verdict is about. */
  claim: TypedClaim;
  /** Which deterministic checker handled it. */
  checker: FloorChecker;
  /** True iff a checker actually RAN and produced a ground-truth result. */
  executed: boolean;
  /**
   * Checker result:
   *   - executed=true  → passed reflects whether the claim matched ground truth
   *   - executed=false → passed is null (undetermined; falls through to HAL)
   */
  passed: boolean | null;
  /** Human-readable checker output (the computed value / observed fact / reason not-run). */
  result: string;
  /**
   * THE LAW flag: true when this verdict is AUTHORITATIVE and an LLM/HAL opinion
   * on this specific claim is inadmissible. Only set when executed && passed!==null.
   */
  authoritative: boolean;
  /** Optional structured detail for logging. */
  detail?: Record<string, unknown>;
}

export interface FloorReport {
  enabled: boolean; // whether the flag is live (vs shadow)
  verdicts: FloorVerdict[];
  /** Convenience: any authoritative FAIL (a checkable claim that is provably wrong). */
  hasAuthoritativeFailure: boolean;
  /** Convenience: any authoritative verdict at all (something was actually determined). */
  hasAuthoritativeVerdict: boolean;
}

// ---------------------------------------------------------------------------
// Optional injectable on-chain read seam (keeps the module unit-testable
// without a live RPC — CI passes a mock).
// ---------------------------------------------------------------------------

export interface OnchainReader {
  /** Returns the balance in wei for an address, or throws. */
  getBalanceWei(address: string): Promise<bigint>;
  /** Returns bytecode at an address ('0x' if EOA/none), or throws. */
  getCode(address: string): Promise<string>;
  /** Returns true iff a tx hash is found + mined, false if not found; throws on rpc error. */
  txExists(txHash: string): Promise<boolean>;
}

let onchainReaderFactory: (() => OnchainReader) | null = null;

/** Test seam: inject a mock on-chain reader. Pass undefined to reset to the real ethers path. */
export function __setOnchainReader(f?: () => OnchainReader): void {
  onchainReaderFactory = f ?? null;
}

/**
 * Lazily build the real on-chain reader over the repo's existing failover RPC
 * path (src/clients/rpc-with-failover.ts → Base Sepolia). Imported lazily so
 * pure claim-typing/arithmetic paths never touch ethers/network at module load.
 */
function realOnchainReader(): OnchainReader {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { rpcCall } = require('../clients/rpc-with-failover') as typeof import('../clients/rpc-with-failover');
  const { ethers } = require('ethers') as typeof import('ethers');
  return {
    async getBalanceWei(address: string): Promise<bigint> {
      return rpcCall((p) => p.getBalance(ethers.getAddress(address)));
    },
    async getCode(address: string): Promise<string> {
      return rpcCall((p) => p.getCode(ethers.getAddress(address)));
    },
    async txExists(txHash: string): Promise<boolean> {
      const receipt = await rpcCall((p) => p.getTransactionReceipt(txHash));
      return receipt != null;
    },
  };
}

function getOnchainReader(): OnchainReader {
  return onchainReaderFactory ? onchainReaderFactory() : realOnchainReader();
}

// ---------------------------------------------------------------------------
// Checkers
// ---------------------------------------------------------------------------

function compareRelation(rel: Relation, lhs: number, rhs: number): boolean {
  // Approx tolerance: relative epsilon, floored to an absolute epsilon for values near zero.
  const approxEps = Math.max(1e-9, Math.abs(rhs) * 1e-6);
  switch (rel) {
    case 'eq':
      return Math.abs(lhs - rhs) <= approxEps;
    case 'neq':
      return Math.abs(lhs - rhs) > approxEps;
    case 'lt':
      return lhs < rhs;
    case 'lte':
      return lhs <= rhs;
    case 'gt':
      return lhs > rhs;
    case 'gte':
      return lhs >= rhs;
    case 'approx':
      // "approximately equal" — 0.5% relative tolerance (looser than eq)
      return Math.abs(lhs - rhs) <= Math.max(1e-9, Math.abs(rhs) * 5e-3);
    default:
      return false;
  }
}

function checkArithmetic(claim: TypedClaim): FloorVerdict {
  const lhsExpr = String(claim.parsed?.lhs ?? '');
  const rhsExpr = String(claim.parsed?.rhs ?? '');
  const relation = (claim.parsed?.relation as Relation) ?? 'eq';
  const lhs = safeEvalArithmetic(lhsExpr);
  const rhs = safeEvalArithmetic(rhsExpr);

  if (!lhs.ok || !rhs.ok) {
    return {
      claim,
      checker: 'arithmetic',
      executed: false,
      passed: null,
      authoritative: false,
      result: `could not evaluate (${lhs.ok ? '' : `lhs: ${lhs.error}`}${rhs.ok ? '' : ` rhs: ${rhs.error}`})`.trim(),
    };
  }

  const passed = compareRelation(relation, lhs.value!, rhs.value!);
  return {
    claim,
    checker: 'arithmetic',
    executed: true,
    passed,
    authoritative: true, // THE LAW: computed arithmetic is authoritative
    result: `${lhs.value} ${relation} ${rhs.value} → ${passed ? 'TRUE' : 'FALSE'}`,
    detail: { lhs: lhs.value, rhs: rhs.value, relation },
  };
}

async function checkOnchain(claim: TypedClaim): Promise<FloorVerdict> {
  const kind = String(claim.parsed?.kind ?? '');
  const reader = getOnchainReader();
  try {
    if (kind === 'tx') {
      const txHash = String(claim.parsed?.txHash ?? '');
      const exists = await reader.txExists(txHash);
      return {
        claim,
        checker: 'onchain',
        executed: true,
        // The claim asserts the tx is real/exists; passed = it does.
        passed: exists,
        authoritative: true,
        result: `tx ${txHash} ${exists ? 'FOUND on chain' : 'NOT FOUND on chain'}`,
        detail: { txHash, exists },
      };
    }
    const address = String(claim.parsed?.address ?? '');
    if (kind === 'balance') {
      const wei = await reader.getBalanceWei(address);
      // We can VERIFY the balance but the claim's asserted number isn't parsed
      // out reliably; report the observed fact authoritatively. A downstream
      // consumer can compare it to the claimed figure. passed=true means "we
      // determined the on-chain value" (the fact is established), not a match.
      return {
        claim,
        checker: 'onchain',
        executed: true,
        passed: true,
        authoritative: true,
        result: `balance(${address}) = ${wei.toString()} wei`,
        detail: { address, balanceWei: wei.toString() },
      };
    }
    // address 'code' sub-kind: is there bytecode (contract) at the address?
    const code = await reader.getCode(address);
    const isContract = code != null && code !== '0x' && code.length > 2;
    return {
      claim,
      checker: 'onchain',
      executed: true,
      passed: isContract,
      authoritative: true,
      result: `${address} is ${isContract ? 'a CONTRACT' : 'an EOA / no code'}`,
      detail: { address, isContract, codeLen: code?.length ?? 0 },
    };
  } catch (e: unknown) {
    // RPC failure → undetermined; DO NOT fabricate a verdict. Falls through to HAL.
    const msg = e instanceof Error ? e.message : String(e);
    return {
      claim,
      checker: 'onchain',
      executed: false,
      passed: null,
      authoritative: false,
      result: `on-chain read failed (undetermined): ${msg}`,
    };
  }
}

/** code / db → recognized but NOT run. Honest "executable-but-not-run". */
function checkNotRun(claim: TypedClaim, checker: 'code' | 'db'): FloorVerdict {
  const reason = String(claim.parsed?.reason ?? 'executable-but-not-run');
  return {
    claim,
    checker,
    executed: false,
    passed: null,
    authoritative: false, // not run ⇒ not authoritative ⇒ HAL still decides
    result: `not executed (${reason})`,
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Run the execution floor over a single already-typed claim.
 * Deterministic dispatch by executableKind; non-executable claims get a
 * pass-through (executed:false) verdict so callers see the full picture.
 */
export async function checkClaim(claim: TypedClaim): Promise<FloorVerdict> {
  if (claim.type !== 'executable') {
    return {
      claim,
      checker: 'none',
      executed: false,
      passed: null,
      authoritative: false,
      result: `non-executable (${claim.type}) — falls through to HAL`,
    };
  }
  switch (claim.executableKind) {
    case 'arithmetic':
      return checkArithmetic(claim);
    case 'onchain':
      return checkOnchain(claim);
    case 'code':
      return checkNotRun(claim, 'code');
    case 'db':
      return checkNotRun(claim, 'db');
    default:
      return {
        claim,
        checker: 'none',
        executed: false,
        passed: null,
        authoritative: false,
        result: 'unknown executable kind',
      };
  }
}

/**
 * Extract, type, and run the floor over a full output/claim string.
 * Returns a FloorReport with per-claim verdicts.
 */
export async function runExecutionFloor(output: string): Promise<FloorReport> {
  const claims = extractTypedClaims(output);
  const verdicts = await Promise.all(claims.map(checkClaim));
  return buildReport(verdicts);
}

function buildReport(verdicts: FloorVerdict[]): FloorReport {
  const authoritative = verdicts.filter((v) => v.authoritative && v.executed && v.passed !== null);
  return {
    enabled: executionFloorEnabled(),
    verdicts,
    hasAuthoritativeVerdict: authoritative.length > 0,
    hasAuthoritativeFailure: authoritative.some((v) => v.passed === false),
  };
}

// ---------------------------------------------------------------------------
// THE LAW applied to a HAL decision (the primacy override)
// ---------------------------------------------------------------------------

export interface HalDecisionLike {
  /** HAL's decision for the output. */
  decision: 'vetoed' | 'flagged' | 'clean' | 'abstain';
  /** Whatever HAL's own reason string was. */
  decision_reason?: string;
}

export interface FloorApplication<T extends HalDecisionLike> {
  /** The (possibly overridden) decision the caller should honor. */
  decision: T;
  /** The floor report (always computed, even in shadow). */
  floor: FloorReport;
  /** True iff the floor OVERRODE HAL (only possible when the flag is live). */
  overridden: boolean;
  /** Explanation of what the floor did — for audit logging. */
  note: string;
}

/**
 * Apply the execution-floor primacy law to a HAL decision.
 *
 *   - SHADOW (flag OFF): decision is returned UNCHANGED. The floor report is
 *     attached for logging. `overridden=false`. This is the default — nothing
 *     about live HAL behavior changes.
 *
 *   - LIVE (flag ON): if the floor found an AUTHORITATIVE FAILURE (a checkable
 *     claim that is provably false), the decision is forced to 'vetoed' and
 *     HAL's opinion on that claim is marked inadmissible. If the floor found
 *     authoritative verdicts that all PASSED and HAL wanted to veto on grounds
 *     the floor determined true, we do NOT auto-clear — a passing checkable
 *     claim doesn't license the rest of the output; the floor only OVERRIDES to
 *     be MORE conservative (veto a proven-false claim), never less. (Failing
 *     safe: execution can catch a hallucination HAL missed, but a clean
 *     arithmetic line can't launder an otherwise-vetoed output.)
 */
export async function applyExecutionFloor<T extends HalDecisionLike>(
  output: string,
  halDecision: T,
): Promise<FloorApplication<T>> {
  const floor = await runExecutionFloor(output);

  if (!floor.enabled) {
    return {
      decision: halDecision,
      floor,
      overridden: false,
      note: `shadow: floor computed ${floor.verdicts.length} verdict(s) ` +
        `(authoritative=${floor.hasAuthoritativeVerdict}, ` +
        `authoritative-failure=${floor.hasAuthoritativeFailure}); HAL decision unchanged`,
    };
  }

  if (floor.hasAuthoritativeFailure) {
    const failed = floor.verdicts.filter((v) => v.authoritative && v.passed === false);
    return {
      decision: {
        ...halDecision,
        decision: 'vetoed',
        decision_reason:
          `EXECUTION FLOOR OVERRIDE — ${failed.length} deterministically-checkable claim(s) ` +
          `FAILED execution; LLM/HAL opinion on them is inadmissible. ` +
          failed.map((f) => `[${f.checker}] ${f.result}`).join('; ') +
          (halDecision.decision_reason ? ` | (HAL had: ${halDecision.decision})` : ''),
      },
      floor,
      overridden: true,
      note: `live: floor forced VETO on ${failed.length} authoritative failure(s)`,
    };
  }

  return {
    decision: halDecision,
    floor,
    overridden: false,
    note: `live: floor found no authoritative failures; HAL decision honored`,
  };
}
