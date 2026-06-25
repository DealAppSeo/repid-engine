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
// Re-export the action shape so consumers can build typed actions without reaching into src/.
export { type Action, type Tier } from '../src/services/consequence-classifier';
