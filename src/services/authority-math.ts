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

export interface AuthorityResult {
  authority: bigint;
  breakdown: {
    stakeAmount: string;
    stakeSqrt: string;
    combinedScore: string;
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
        builderFloorPassed: true,
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
      builderFloorPassed: true,
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
