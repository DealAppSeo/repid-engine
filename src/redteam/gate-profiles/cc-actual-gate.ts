/**
 * CC ACTUAL hardened gate — parity profile for round-6+ red-team.
 * Sources classifier + spend tracker from feat/cc-2026-06-24-r6-session @ pinned commit.
 * NO hardened-reference shim.
 */
import {
  classifyAction,
  type Action,
  type Classification,
  type ClassifierConfig,
} from '../../services/consequence-classifier';
import { SpendTracker, type SpendWindowSnapshot } from '../../services/spend-tracker';
import { type ClassifyFn } from '../../services/governance-loop';

/** Pinned CC gate commit — reproducibility anchor for XC reports. */
export const CC_GATE_COMMIT = '5718d16';

export interface CcGateBundle {
  id: 'cc-actual';
  ccGateCommit: typeof CC_GATE_COMMIT;
  label: string;
  source: string;
  classifyFn: ClassifyFn;
  /** Call after each classified step to advance session state (spend window, etc.). */
  afterStep: (action: Action, classification: Classification) => void;
  reset: () => void;
  spendSnapshot: () => SpendWindowSnapshot;
}

export function createCcActualGate(config?: Partial<ClassifierConfig>): CcGateBundle {
  let tracker = new SpendTracker();
  let stepTs = 1_000_000;

  const classifyFn: ClassifyFn = (action, opts) => {
    const snap = tracker.snapshot(stepTs);
    return classifyAction(action, {
      config: opts?.config ?? config,
      spendContext: snap,
    });
  };

  return {
    id: 'cc-actual',
    ccGateCommit: CC_GATE_COMMIT,
    label: 'CC hardened gate (r5 canonicalize + spend window)',
    source: `src/services/consequence-classifier.ts @ ${CC_GATE_COMMIT}`,
    classifyFn,
    afterStep(action) {
      if (typeof action.costUsd === 'number' && action.costUsd > 0) {
        tracker.record(action.costUsd, stepTs);
      }
      stepTs += 1_000;
    },
    reset() {
      tracker = new SpendTracker();
      stepTs = 1_000_000;
    },
    spendSnapshot() {
      return tracker.snapshot(stepTs);
    },
  };
}

export const CC_ACTUAL_GATE = createCcActualGate();