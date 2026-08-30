/**
 * Cached `ownerOf()` cross-check, so the passport can resolve UNVERIFIED without doing a chain
 * round trip on every read — and without ever hanging on one.
 *
 * TWO DESIGN DECISIONS HERE ARE LOAD-BEARING, and both come from measurements rather than taste.
 *
 * 1. A HARD TIMEOUT, because ethers does not have one that helps.
 *    MEASURED 2026-08-30: `JsonRpcProvider` against an unreachable endpoint does not fail — it
 *    logs "failed to detect network and cannot start up; retry in 1s" and retries indefinitely.
 *    A probe left running took two minutes and was still going. Dropped unguarded into a request
 *    path, one RPC outage becomes every passport request hanging until its own socket dies. So
 *    the call is raced against a deadline and a timeout is NOT_CHECKED — the honest verdict, and
 *    the one `resolveIdentityState` refuses to act on.
 *
 * 2. A FAILURE IS CACHED FAR MORE BRIEFLY THAN AN ANSWER.
 *    Caching NOT_CHECKED for the same two hours as a real result would pin every agent at
 *    UNVERIFIED long after the RPC recovered — turning a transient outage into a lasting wrong
 *    answer, which is the failure mode a cache is most likely to introduce and least likely to
 *    show. A short TTL still bounds the retry rate against a chain that is genuinely down.
 *
 * Follows this directory's convention: `cacheGet`/`cacheSet` over Dragonfly, degrading to a
 * graceful always-miss when Redis is absent. An always-miss is correct here — every read then
 * does its own bounded, timeout-guarded check.
 */
import { cacheGet, cacheSet } from './dragonfly';
import type { OnChainCheck } from '../services/erc8004-minter';

/** How long a real chain answer is trusted. OWNER_FOUND / REVERTED / NO_TOKEN. */
const ANSWER_TTL = Number(process.env.ONCHAIN_IDENTITY_TTL ?? 7200); // 2h
/** How long a non-answer is remembered. Deliberately short — see note 2 above. */
const NOT_CHECKED_TTL = Number(process.env.ONCHAIN_IDENTITY_FAIL_TTL ?? 30); // 30s
/** Deadline for the chain call itself. See note 1 — ethers will not impose one. */
const DEFAULT_TIMEOUT_MS = Number(process.env.ONCHAIN_IDENTITY_TIMEOUT_MS ?? 1500);

const VALID: readonly OnChainCheck[] = ['NO_TOKEN', 'OWNER_FOUND', 'REVERTED', 'NOT_CHECKED'];

function key(agentId: string): string {
  return `onchain-identity:${agentId}`;
}

/**
 * Resolve the on-chain check for an agent, from cache when possible.
 *
 * `verify` is injected rather than constructed here: it keeps this module free of ethers and of
 * env-var plumbing, and it is what makes the timeout and TTL behaviour testable without a chain.
 *
 * This function does not throw. Every failure path — a rejected call, a timeout, a malformed
 * cache entry — yields NOT_CHECKED, because the alternative is asserting something about the
 * chain from a failure to reach it.
 */
export async function resolveOnChainCheck(
  agentId: string,
  verify: (agentId: string) => Promise<{ check: OnChainCheck }>,
  opts: { timeoutMs?: number } = {},
): Promise<{ check: OnChainCheck; cached: boolean }> {
  try {
    const hit = await cacheGet(key(agentId));
    // A cache entry we cannot recognise is not a result. Fall through and re-check rather than
    // coercing an unknown string into a verdict about the chain.
    if (hit && (VALID as readonly string[]).includes(hit)) {
      return { check: hit as OnChainCheck, cached: true };
    }
  } catch {
    // A cache read failure must never decide an identity. Fall through to the live check.
  }

  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  let timer: NodeJS.Timeout | undefined;
  let check: OnChainCheck;
  try {
    check = await Promise.race([
      verify(agentId).then((r) => r.check),
      new Promise<OnChainCheck>((resolve) => {
        timer = setTimeout(() => resolve('NOT_CHECKED'), timeoutMs);
        // Do not hold the process open for a cache refresh.
        if (typeof timer.unref === 'function') timer.unref();
      }),
    ]);
  } catch {
    check = 'NOT_CHECKED';
  } finally {
    if (timer) clearTimeout(timer);
  }

  try {
    await cacheSet(key(agentId), check, check === 'NOT_CHECKED' ? NOT_CHECKED_TTL : ANSWER_TTL);
  } catch {
    // Caching is an optimisation; failing to cache must not change the answer.
  }
  return { check, cached: false };
}

/** Exposed for tests and for operators reasoning about staleness windows. */
export const ONCHAIN_IDENTITY_TTLS = {
  answer: ANSWER_TTL,
  notChecked: NOT_CHECKED_TTL,
  timeoutMs: DEFAULT_TIMEOUT_MS,
} as const;
