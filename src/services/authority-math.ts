import { getTierForRepId } from '../config/tier-limits';

export const BUILDER_FLOOR = 500;

export interface AuthorityInput {
  stakeAmount: bigint;
  agentRepId: number;
  agentWisdom: number;
  agentCharacter: number;
  builderRepId: number;
  isDemoBuilder?: boolean;
}

/**
 * Whether `BUILDER_FLOOR` was actually evaluated, and what it said.
 *
 * THREE OUTCOMES, BECAUSE A BOOLEAN CANNOT HOLD THIS. `computeAuthority` has three routes to a
 * non-zero authority and only ONE of them consults the floor; the other two used to report
 * `builderFloorPassed: true` regardless, which wrote a PASS into the audit trail for a check
 * that never ran. "The floor rejected you" and "the floor was never applied" are different
 * claims, and collapsing them into one `false`/`true` is how a not-checked becomes a verdict.
 */
export type FloorCheck = 'PASSED' | 'FAILED' | 'NOT_APPLIED';

export interface AuthorityResult {
  authority: bigint;
  breakdown: {
    stakeAmount: string;
    stakeSqrt: string;
    combinedScore: string;
    /**
     * AUTHORITATIVE. Persisted to the snapshot; read this, not the boolean below.
     */
    floorCheck: FloorCheck;
    /**
     * LEGACY AND LOSSY — kept only so existing readers do not change behaviour. It is exactly
     * `floorCheck !== 'FAILED'`, so it reports `true` for a bypass that never checked anything.
     * Do not decide anything with it.
     */
    builderFloorPassed: boolean;
    reason?: string;
  };
}

export function computeAuthority(args: AuthorityInput): AuthorityResult {
  if (args.isDemoBuilder) {
    const { current } = getTierForRepId(args.builderRepId);
    // authority = stakeAmount * pctOfStake
    // e.g. 100_000_000n * 0.5 = 50_000_000n
    const authority = (args.stakeAmount * BigInt(Math.floor(current.pctOfStake * 100))) / 100n;
    return {
      authority,
      breakdown: {
        stakeAmount: args.stakeAmount.toString(),
        stakeSqrt: '0',
        combinedScore: '0',
        // NOT_APPLIED, not PASSED: this branch returns before BUILDER_FLOOR is ever compared.
        // The bypass itself is unchanged and this authority value is exactly what it always was
        // — what changes is that the record no longer claims a check that did not happen.
        floorCheck: 'NOT_APPLIED',
        builderFloorPassed: true,
        reason:
          'builder floor NOT APPLIED: token_only (demo) builder takes the stake x pctOfStake ' +
          'path, which returns before BUILDER_FLOOR is evaluated',
      },
    };
  }

  // If builder is below floor, they get 0 authority, UNLESS they are a fresh demo builder
  // (we assume a fresh demo builder with 0 RepID and no agents is bootstrapping).
  const isFreshDemo = args.builderRepId === 0 && args.agentRepId === 0;
  
  if (args.builderRepId < BUILDER_FLOOR && !isFreshDemo) {
    return {
      authority: 0n,
      breakdown: {
        stakeAmount: args.stakeAmount.toString(),
        stakeSqrt: '0',
        combinedScore: '0',
        floorCheck: 'FAILED',
        builderFloorPassed: false,
        reason: `builder below floor ${BUILDER_FLOOR}`,
      },
    };
  }

  // Use realistic demo defaults if it's a fresh demo builder
  const r = isFreshDemo ? 5500n : BigInt(args.agentRepId);
  const w = isFreshDemo ? 800n : BigInt(args.agentWisdom || 800);
  const c = isFreshDemo ? 600n : BigInt(args.agentCharacter || 600);

  const combinedScore = r * w * c;

  // Anti-whale Synthesis formula: A = min(R, 100 * sqrt(S_usd))
  // S_usd is calculated by converting the micro-USDC stake to USD (dividing by 10^6),
  // taking the square root, multiplying by 100, and scaling back to micro-units (multiplying by 10^6).
  // Formula: A_micro = min(R * 10^6, 100 * sqrt(S_usd) * 10^6)
  const rScaled = r * 1_000_000n;
  const stakeUSD = Number(args.stakeAmount) / 1_000_000;
  const stakeSqrtUSD = Math.sqrt(stakeUSD);
  const scaledAuthorityUSD = 100 * stakeSqrtUSD;
  const sScaled = BigInt(Math.floor(scaledAuthorityUSD * 1_000_000));
  const authority = rScaled < sScaled ? rScaled : sScaled;
  
  return {
    authority,
    breakdown: {
      stakeAmount: args.stakeAmount.toString(),
      stakeSqrt: stakeSqrtUSD.toString(),
      combinedScore: combinedScore.toString(),
      // A fresh demo reaches here WITHOUT the floor having been compared — the guard above is
      // `builderRepId < BUILDER_FLOOR && !isFreshDemo`, so isFreshDemo short-circuits it. It
      // then runs on r/w/c that were SUBSTITUTED rather than measured, which the reason says
      // out loud so nobody reads the resulting combinedScore as real reputation.
      floorCheck: isFreshDemo ? 'NOT_APPLIED' : 'PASSED',
      builderFloorPassed: true,
      ...(isFreshDemo
        ? {
            reason:
              'builder floor NOT APPLIED: fresh demo (builderRepId 0 and agentRepId 0) ' +
              'short-circuits the floor comparison; agent scores below are SUBSTITUTED ' +
              'bootstrap defaults, not measured values',
          }
        : {}),
    },
  };
}

/**
 * Integer Babylonian (Newton's method) sqrt.
 */
export function babylonianSqrt(n: bigint): bigint {
  if (n < 0n) return 0n;
  if (n === 0n) return 0n;
  if (n < 4n) return 1n;
  let bits = 0n;
  let tmp = n;
  while (tmp > 0n) { bits++; tmp >>= 1n; }
  let y = 1n << ((bits + 1n) / 2n);
  while (true) {
    const next = (y + n / y) / 2n;
    if (next >= y) return y;
    y = next;
  }
}
