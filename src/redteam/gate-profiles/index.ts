import { type ClassifyFn } from '../../services/governance-loop';
import { classifyAction } from '../../services/consequence-classifier';
import { CC_ACTUAL_GATE, createCcActualGate } from './cc-actual-gate';
export { CC_ACTUAL_GATE, CC_GATE_COMMIT, createCcActualGate } from './cc-actual-gate';
import {
  classifyActionHardened,
  createHardenedContext,
  type HardenedContext,
} from './hardened-reference';

export interface GateProfile {
  id: string;
  label: string;
  source: string;
  createClassifyFn: () => { classifyFn: ClassifyFn; reset: () => void; ctx?: HardenedContext };
}

export const PRE_HARDEN_PROFILE: GateProfile = {
  id: 'pre-harden',
  label: 'Round-3/4 classifier (raw string match)',
  source: 'src/services/consequence-classifier.ts @ integration',
  createClassifyFn: () => ({
    classifyFn: classifyAction,
    reset: () => {},
  }),
};

/** Reference shim until feat/cc-2026-06-24-r5-harden lands [A]. */
export const HARDENED_REFERENCE_PROFILE: GateProfile = {
  id: 'hardened-reference',
  label: 'CC r5-harden reference (canonicalize + aggregate)',
  source: 'src/redteam/gate-profiles/hardened-reference.ts (NOT CC branch)',
  createClassifyFn: () => {
    const ctx = createHardenedContext(1.0);
    return {
      classifyFn: (action) => classifyActionHardened(action, ctx),
      reset: () => {
        ctx.cumulativeSpendUsd = 0;
      },
      ctx,
    };
  },
};

/** Round-6+ parity: single source of truth. */
export const PARITY_GATE_PROFILE = CC_ACTUAL_GATE;

export const GATE_PROFILES = [PRE_HARDEN_PROFILE, HARDENED_REFERENCE_PROFILE];