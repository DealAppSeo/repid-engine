/**
 * After-create capability card.
 *
 * can_bind uses the same exact-string rule as GET /readiness (`=== 'true'`).
 * can_stake is false. This card does not read REAL_STAKING_ENABLED into a
 * permission and does not change that gate.
 * can_rate_models is false: Honesty A is not a counted live source here.
 * has_agent is false: this card does not look up a row.
 */

import { TRUTHY } from '../config/flag-readiness';

export interface AfterCreateCard {
  has_agent: false;
  can_verify: true;
  can_bind: boolean;
  can_stake: false;
  can_rate_models: false;
}

export function afterCreateCard(env: Record<string, string | undefined>): AfterCreateCard {
  return {
    has_agent: false,
    can_verify: true,
    can_bind: env.HUMAN_AGENT_BIND_ENABLED === TRUTHY,
    can_stake: false,
    can_rate_models: false,
  };
}
