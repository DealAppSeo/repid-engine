export const BUILDER_FLOOR = 5000;

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
  // Demo builders use the Flywheel (Gyroscope) math (round-numbers progression).
  // See docs/FLYWHEEL_SPEC.md for the eventual full three-input rewrite.
  if (args.isDemoBuilder) {
    const repidOverBase = Math.max(0, args.builderRepId - 100);
    const authority = 50_000_000n + BigInt(repidOverBase) * 62_500n;
    return {
      authority,
      breakdown: {
        stakeAmount: args.stakeAmount.toString(),
        stakeSqrt: '0',
        combinedScore: '0',
        builderFloorPassed: true,
      }
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
  const w = isFreshDemo ? 800n : BigInt(args.agentWisdom);
  const c = isFreshDemo ? 600n : BigInt(args.agentCharacter);

  const combinedScore = r * w * c;
  const stakeSqrt = babylonianSqrt(args.stakeAmount);
  
  // For stake = 100_000_000 (100 USDC), stakeSqrt = 10_000.
  // combinedScore for defaults (5500 * 800 * 600) = 2,640,000,000.
  // Product = 26,400,000,000,000.
  // To get ~50,000,000 (50 USDC), divide by 528,000. We'll use 500,000n.
  const authority = (stakeSqrt * combinedScore) / 500_000n;
  
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
