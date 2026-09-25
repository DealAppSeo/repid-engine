/**
 * After-create capability card.
 *
 * can_bind uses the same exact-string rule as GET /readiness (`=== 'true'`).
 * can_stake is false. This card does not read REAL_STAKING_ENABLED into a
 * permission and does not change that gate.
 * can_rate_models is true only after the Honesty A route recorded status
 * counted. A fixture and NOT_CHECKED stay false.
 * can_stake is always false. This card does not read REAL_STAKING_ENABLED.
 * has_agent is false: this card does not look up a row.
 */

import { TRUTHY } from '../config/flag-readiness';
import { lastHonestyAStatus } from './honesty-a-last';

export interface AfterCreateCard {
  has_agent: false;
  can_verify: true;
  can_bind: boolean;
  can_stake: false;
  can_rate_models: boolean;
}

export function afterCreateCard(env: Record<string, string | undefined>): AfterCreateCard {
  return {
    has_agent: false,
    can_verify: true,
    can_bind: env.HUMAN_AGENT_BIND_ENABLED === TRUTHY,
    can_stake: false,
    can_rate_models: lastHonestyAStatus() === 'counted',
  };
}
