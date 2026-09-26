/**
 * Shadow spend rule for the human walk. It decides nothing live.
 *
 *   human cap → agent cap → deny unbound or missing stake → deny over the minimum.
 *
 * Fail closed, and `applied` is the constant false:
 *   - the human cap is read before the agent cap
 *   - an unbound agent cannot spend (linked is not bound)
 *   - no stake, or stake nobody checked, cannot spend
 *   - an amount over min(human cap, agent cap) cannot spend
 *
 * `decideAuthority` in x402-gate.ts is not called from here and is not changed.
 * That function still ignores the owner ceiling. repid_agents has no stake_amount
 * column; this module does not invent one. Stake is an argument the caller
 * already measured, or the absence of that measurement.
 */

import { attenuateCeiling } from './attenuate-ceiling';

export interface HumanSpendShadowInput {
  amountUsdc: number;
  /** Agent tier per-transaction ceiling, USDC. */
  agentCapUsdc: number;
  /**
   * Owner per-transaction cap, USDC. `null` means a lookup found no tighter
   * cap. Omit the field when nobody looked — that is not "no cap".
   */
  ownerCapUsdc?: number | null;
  /** True only when a signature binding names this agent. */
  bound: boolean;
  /**
   * Collateral already measured, USDC. `null` or `0` means none was found.
   * Omit the field when nobody looked.
   */
  stakeAvailableUsdc?: number | null;
}

export type HumanSpendReason =
  | 'unbound_agent'
  | 'stake_not_checked'
  | 'owner_cap_not_checked'
  | 'no_stake'
  | 'over_cap'
  | 'under_cap';

export interface HumanSpendShadow {
  mode: 'shadow';
  applied: false;
  enforced: false;
  spend: 'deny' | 'would_allow';
  reason: HumanSpendReason;
  human_cap_usdc: number | null;
  agent_cap_usdc: number | null;
  /** min(human, agent). Null when the cap was not computed. */
  effective_cap_usdc: number | null;
  detail: string;
}

const CLOSED = {
  mode: 'shadow' as const,
  applied: false as const,
  enforced: false as const,
};

export function shadowHumanSpend(input: HumanSpendShadowInput): HumanSpendShadow {
  if (input.ownerCapUsdc === undefined) {
    return {
      ...CLOSED,
      spend: 'deny',
      reason: 'owner_cap_not_checked',
      human_cap_usdc: null,
      agent_cap_usdc: input.agentCapUsdc,
      effective_cap_usdc: null,
      detail: 'Human cap was not checked, so the agent cap is not applied. No spend.',
    };
  }

  const attenuated = attenuateCeiling(input.agentCapUsdc, input.ownerCapUsdc);
  const visible = {
    human_cap_usdc: input.ownerCapUsdc,
    agent_cap_usdc: input.agentCapUsdc,
    effective_cap_usdc: attenuated.ceiling,
  };

  if (input.bound !== true) {
    return {
      ...CLOSED,
      spend: 'deny',
      reason: 'unbound_agent',
      ...visible,
      detail: 'Human cap, then agent cap. An unbound agent cannot spend. A linked account is not a signature. Nothing was applied.',
    };
  }

  if (input.stakeAvailableUsdc === undefined) {
    return {
      ...CLOSED,
      spend: 'deny',
      reason: 'stake_not_checked',
      ...visible,
      detail: 'Human cap, then agent cap. Stake was not checked. A missing measurement is not zero. Nothing was applied.',
    };
  }

  if (input.stakeAvailableUsdc === null || input.stakeAvailableUsdc <= 0) {
    return {
      ...CLOSED,
      spend: 'deny',
      reason: 'no_stake',
      ...visible,
      detail: 'Human cap, then agent cap. No stake means no spend. Nothing was applied.',
    };
  }

  if (!(input.amountUsdc > 0) || input.amountUsdc > attenuated.ceiling) {
    return {
      ...CLOSED,
      spend: 'deny',
      reason: 'over_cap',
      ...visible,
      detail: `Amount is over the effective cap ${attenuated.ceiling} (human cap, then agent cap, the minimum). Fail closed. Nothing was applied.`,
    };
  }

  return {
    ...CLOSED,
    spend: 'would_allow',
    reason: 'under_cap',
    ...visible,
    detail: `Under the effective cap ${attenuated.ceiling}. Recorded only. The live gate was not asked.`,
  };
}
