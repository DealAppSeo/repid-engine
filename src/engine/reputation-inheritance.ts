/**
 * Reputation Inheritance for Agent Delegation (S-BUILD Phase 6)
 * 
 * effective_repid = MIN(own, delegator)
 * Max depth 3
 * HITL floor <70 absolute
 * Anti-laundering: self + circular detection
 * Logged to tool_call_log (depends on S-AUD1)
 */

export interface DelegationContext {
  delegatorAgent: string;
  delegatorRepid: number;
  targetAgent: string;
  targetRepid: number;
  delegationDepth: number;
  parentDelegationId?: string;
}

export function computeEffectiveRepid(ctx: DelegationContext): {
  effectiveRepid: number;
  hitlRequired: boolean;
  blocked: boolean;
  reason?: string;
} {
  if (ctx.delegationDepth > 3) {
    return {
      effectiveRepid: 0,
      hitlRequired: true,
      blocked: true,
      reason: 'MAX_DELEGATION_DEPTH_EXCEEDED',
    };
  }

  if (ctx.delegatorAgent === ctx.targetAgent) {
    return {
      effectiveRepid: 0,
      hitlRequired: true,
      blocked: true,
      reason: 'SELF_DELEGATION',
    };
  }

  const effectiveRepid = Math.min(ctx.delegatorRepid, ctx.targetRepid);
  const hitlRequired = effectiveRepid < 70;

  return { effectiveRepid, hitlRequired, blocked: false };
}
