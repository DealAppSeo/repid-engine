/**
 * CC WIRED gate — default runGovernanceLoop with session + spend window threaded.
 * Gate base: feat/cc-2026-06-24-r6-session @ 807537a
 * Wiring: governance-loop session integration [A: from cc-r7 uncommitted, pending CC commit]
 */
import { SessionRiskTracker } from '../../services/session-risk';
import { SpendTracker } from '../../services/spend-tracker';
import { runGovernanceLoop, type GovernanceVerdict } from '../../services/governance-loop';
import { type Action } from '../../services/consequence-classifier';

/** CC r6-session commit (session-risk + FP + trace). */
export const CC_SESSION_COMMIT = '807537a';

/**
 * Wired gate commit pin for XC reports.
 * [A] Full r7-wire commit not landed; wiring applied from cc-r7 worktree governance-loop.ts
 */
export const CC_WIRED_GATE_PIN = `${CC_SESSION_COMMIT}+wired`;

export interface CcWiredGateBundle {
  id: 'cc-wired';
  ccGateCommit: typeof CC_WIRED_GATE_PIN;
  ccSessionCommit: typeof CC_SESSION_COMMIT;
  label: string;
  source: string;
  createSession: (id: string) => SessionRiskTracker;
  runStep: (
    action: Action,
    session: SessionRiskTracker,
    spend: SpendTracker,
    repoRoot: string
  ) => GovernanceVerdict;
  resetSpend: () => SpendTracker;
}

export function createCcWiredGate(): CcWiredGateBundle {
  let spendTracker = new SpendTracker();
  let stepTs = 1_000_000;

  return {
    id: 'cc-wired',
    ccGateCommit: CC_WIRED_GATE_PIN,
    ccSessionCommit: CC_SESSION_COMMIT,
    label: 'CC wired gate (session default loop + spend window)',
    source: `session-risk @ ${CC_SESSION_COMMIT} + wired governance-loop [A]`,
    createSession: (id) => new SessionRiskTracker(id),
    runStep(action, session, spend, repoRoot) {
      const snap = spendTracker.snapshot(stepTs);
      const verdict = runGovernanceLoop(
        {
          action,
          proposer: {
            agentId: 'attacker',
            provider: 'anthropic',
            lineageProvider: 'anthropic',
            contextHash: 'ctx-attacker',
          },
          adversary: {
            agentId: 'defender',
            provider: 'groq',
            lineageProvider: 'groq',
            contextHash: 'ctx-defender',
          },
          objection: { summary: 'minor', citations: [{ kind: 'ci_run_id', value: '28080981450' }] },
        },
        { repoRoot, session, spendContext: snap }
      );
      if (typeof action.costUsd === 'number' && action.costUsd > 0) {
        spendTracker.record(action.costUsd, stepTs);
      }
      stepTs += 1_000;
      return verdict;
    },
    resetSpend() {
      spendTracker = new SpendTracker();
      stepTs = 1_000_000;
      return spendTracker;
    },
  };
}

export const CC_WIRED_GATE = createCcWiredGate();