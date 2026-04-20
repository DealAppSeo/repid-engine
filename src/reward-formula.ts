const PHI = 1.618033988749895;

export interface RewardParams {
  baseDelta: number;
  isValidator: boolean;
  phi?: number;
  impactUSDC?: number;
  domainAccuracy?: number;
  alignmentExponent?: number;
  challengerRepID?: number;
  targetRepID?: number;
  collusionRisk?: number;
  isExploration?: boolean;
  isGenesis?: boolean;
  wisdomScore?: number;
  informationParity?: number;
  daysAsNewDBT?: number;
  vdrCount?: number;
  latencyPenalty?: number;
  keystoneFactor?: number;
  mentorshipBonus?: number;
  confessionFactor?: number;
  isHuman?: boolean;
}

export interface RewardResult {
  reward: number;
  breakdown: {
    alignmentMult: number;
    impactFactor: number;
    courageBonus: number;
    downwardDampener: number;
    explorationFactor: number;
    genesisFactor: number;
    wisdomFactor: number;
    parityFactor: number;
    vdrFactor: number;
    latencyPenalty: number;
    ecosystemFactor: number;
    humanFactor: number;
    riskFactor: number;
  };
}

export function calculateFullReward(
  params: RewardParams,
  configPhi: number = PHI,
  impactCap: number = 5.0
): RewardResult {
  const {
    baseDelta,
    isValidator,
    impactUSDC = 0,
    domainAccuracy = 1.0,
    alignmentExponent = 1.0,
    challengerRepID = 0,
    targetRepID = 0,
    collusionRisk = 0,
    isExploration = false,
    isGenesis = false,
    wisdomScore = 1.0,
    informationParity = 1.0,
    daysAsNewDBT = 999,
    vdrCount = 0,
    latencyPenalty = 1.0,
    keystoneFactor = 1.0,
    mentorshipBonus = 1.0,
    confessionFactor = 1.0,
    isHuman = false,
  } = params;

  const phi = configPhi;

  const alignmentMult = Math.pow(phi, alignmentExponent);
  const impactFactor = Math.min(1 + impactUSDC / 1000, impactCap);
  const riskFactor = 1 + Math.min(collusionRisk, 2.0);

  const gap = Math.max(targetRepID - challengerRepID, 0);
  const courageBonus = Math.pow(phi, gap / 5000);
  const downwardDampener =
    challengerRepID > targetRepID ? 1 / phi : 1.0;

  const explorationFactor = isExploration ? 0.5 : 1.0;
  const genesisFactor =
    isGenesis && daysAsNewDBT <= 30 ? 1.5 : 1.0;

  const wisdomFactor = Math.pow(phi, wisdomScore - 1.0);
  const parityFactor = Math.min(informationParity, 1.0);
  const vdrFactor = Math.pow(phi, Math.min(vdrCount / 1000, 2));
  const humanFactor = isHuman ? 1.1 : 1.0;
  const ecosystemFactor =
    keystoneFactor * mentorshipBonus * confessionFactor;

  let reward: number;

  if (isValidator) {
    reward =
      baseDelta *
      phi *
      alignmentMult *
      impactFactor *
      domainAccuracy *
      courageBonus *
      downwardDampener *
      explorationFactor *
      genesisFactor *
      wisdomFactor *
      parityFactor *
      vdrFactor *
      latencyPenalty *
      ecosystemFactor *
      humanFactor /
      riskFactor;
  } else {
    reward =
      -baseDelta /
      phi *
      impactFactor *
      riskFactor /
      wisdomFactor;
  }

  return {
    reward: Math.round(reward * 100) / 100,
    breakdown: {
      alignmentMult,
      impactFactor,
      courageBonus,
      downwardDampener,
      explorationFactor,
      genesisFactor,
      wisdomFactor,
      parityFactor,
      vdrFactor,
      latencyPenalty,
      ecosystemFactor,
      humanFactor,
      riskFactor,
    },
  };
}

export function calculateRequiredStake(
  repid: number,
  transactionValue: number
): number {
  const FLOOR = 0.05;
  if (repid < 1000) {
    return transactionValue * 1.0;
  } else if (repid < 5000) {
    const progress = (repid - 1000) / 4000;
    return transactionValue * (1.0 - progress * 0.70);
  } else {
    const progress = (repid - 5000) / 5000;
    const rate = 0.30 - progress * 0.25;
    return transactionValue * Math.max(rate, FLOOR);
  }
}

export function calculateChallengerCourageBonus(
  challengerRepID: number,
  targetRepID: number,
  phi: number = PHI
): number {
  const gap = Math.max(targetRepID - challengerRepID, 0);
  return Math.pow(phi, gap / 5000);
}
