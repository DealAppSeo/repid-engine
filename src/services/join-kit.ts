/**
 * Join kit capability card.
 *
 * can_verify is true. can_bind follows the readiness exact-string rule.
 * can_stake is false on this card even when REAL_STAKING_ENABLED is the exact
 * string true. This card does not read that variable into a permission and
 * does not change the stake gate.
 */

import { TRUTHY } from '../config/flag-readiness';

export interface JoinKitCard {
  can_verify: true;
  can_bind: boolean;
  can_stake: false;
}

export function joinKit(env: Record<string, string | undefined>): JoinKitCard {
  return {
    can_verify: true,
    can_bind: env.HUMAN_AGENT_BIND_ENABLED === TRUTHY,
    can_stake: false,
  };
}
