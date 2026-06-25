/**
 * TrustRails — installable governance guardrail. Public API barrel.
 *
 *   import { guard, loadTrustRailsConfig, fileTraceSink } from '@trustrails/guard';
 *   const result = guard(action, { ...loadedConfig, sink: fileTraceSink() });
 *   if (result.verdict === 'BLOCK') stop();
 */
export {
  guard,
  isAllowed,
  TRUSTRAILS_VERSION,
  type GuardResult,
  type GuardVerdict,
  type GuardOptions,
  type ChamberInputs,
  type DecisionTrace,
  type RuleTrace,
  type ChamberTrace,
} from './guard';
export {
  loadTrustRailsConfig,
  parseTrustRailsConfig,
  defaultConfigPath,
  type TrustRailsConfig,
} from './config';
export { fileTraceSink, readTraces, defaultTracePath } from './trace-sink';
// [0.7.0] sequence-aware entry — catches recon→credential chains (PocketOS) from the package.
export { SessionGuard, type SessionGuardResult } from './session-guard';
// [0.7.0] MITRE ATLAS / ATT&CK coverage map for the rules.
export { RULE_ATLAS, SESSION_ATLAS, CHAMBER_ATLAS, atlasForRule, type AtlasAnnotation } from '../src/services/atlas-map';
// Re-export the action shape so consumers can build typed actions without reaching into src/.
export { type Action, type Tier } from '../src/services/consequence-classifier';
