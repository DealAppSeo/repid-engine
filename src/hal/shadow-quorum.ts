/**
 * Shadow planner for the HAL 6-provider claim.
 *
 * Live `factCheck` stops a cost-ordered run at 2 distinct families
 * (`MIN_QUORUM_FOR_VETO` in fact-check.ts) so it does not spend the rest of
 * the card. This module does not fetch, does not change that live stop, and
 * does not read env. It names who live WOULD call vs who a 6-slot shadow
 * would still dial.
 */
import { costTierOf } from './fact-check';

export const CLAIMED_PROVIDER_SLOTS = 6;
export const LIVE_STOP_AT_FAMILIES = 2;

export type ShadowProvider = { name: string; family?: string };

export type ShadowPlan = {
  claimedSlots: typeof CLAIMED_PROVIDER_SLOTS;
  liveStopAtFamilies: typeof LIVE_STOP_AT_FAMILIES;
  liveWouldCall: string[];
  liveFamilies: Set<string>;
  shadowWouldCall: string[];
  gap: string[];
};

function rank(p: ShadowProvider): 0 | 1 | 2 {
  return { free: 0, cheap: 1, escalation: 2 }[costTierOf(p)];
}

function familyOf(p: ShadowProvider): string {
  return p.family ?? p.name;
}

export function planQuorum(opts: {
  providers: ShadowProvider[];
  wouldSucceed: Set<string>;
}): ShadowPlan {
  const waves = ([0, 1, 2] as const)
    .map((r) => opts.providers.filter((p) => rank(p) === r))
    .filter((w) => w.length > 0);

  const liveWouldCall: string[] = [];
  const liveFamilies = new Set<string>();
  for (const wave of waves) {
    for (const p of wave) liveWouldCall.push(p.name);
    for (const p of wave) {
      if (opts.wouldSucceed.has(p.name)) liveFamilies.add(familyOf(p));
    }
    if (liveFamilies.size >= LIVE_STOP_AT_FAMILIES) break;
  }

  const shadowWouldCall: string[] = [];
  let shadowHits = 0;
  for (const p of opts.providers) {
    shadowWouldCall.push(p.name);
    if (opts.wouldSucceed.has(p.name)) shadowHits += 1;
    if (shadowHits >= CLAIMED_PROVIDER_SLOTS) break;
  }

  const liveSet = new Set(liveWouldCall);
  const gap = shadowWouldCall.filter((n) => !liveSet.has(n));

  return {
    claimedSlots: CLAIMED_PROVIDER_SLOTS,
    liveStopAtFamilies: LIVE_STOP_AT_FAMILIES,
    liveWouldCall,
    liveFamilies,
    shadowWouldCall,
    gap,
  };
}
