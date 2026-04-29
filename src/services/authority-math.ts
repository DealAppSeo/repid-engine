export const BUILDER_FLOOR = 5000;

export interface AuthorityInput {
  stakeAmount: bigint;
  agentRepId: number;
  agentWisdom: number;
  agentCharacter: number;
  builderRepId: number;
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
  if (args.builderRepId < BUILDER_FLOOR) {
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
  const combinedScore = BigInt(args.agentRepId) * BigInt(args.agentWisdom) * BigInt(args.agentCharacter) / 1_000_000n;
  const stakeSqrt = babylonianSqrt(args.stakeAmount);
  const authority = (stakeSqrt * combinedScore) / 10_000n;
  return {
    authority,
    breakdown: {
      stakeAmount: args.stakeAmount.toString(),
      stakeSqrt: stakeSqrt.toString(),
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
