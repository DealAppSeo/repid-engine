/**
 * A KEY RESOLVED IS NOT A KEY PASSED.
 *
 * `src/hal/config.ts` resolves a set of per-provider enable keys from
 * `repid_config` (DB → env → default). That resolution decides NOTHING on its
 * own: the live scoring path at `src/scoring/pipeline.ts` builds the quorum from
 * a hand-written object literal, and a provider reaches the fact-check quorum
 * only if that literal passes it.
 *
 * WHAT THIS COST, 2026-09-23. `HAL_S2_ENABLE_ZAI` was in NEITHER list. zai
 * (the `glm` family) reached the quorum solely through HAL_QUORUM_AUTOBACKFILL,
 * which includes any provider whose API key is present. Setting
 * HAL_QUORUM_AUTOBACKFILL=false — the documented way to make the enable flags
 * authoritative — therefore DELETED a working family, and setting
 * HAL_S2_ENABLE_ZAI=true did not bring it back, because nothing read that name.
 * Two opposite settings, the same outcome, no error and no log either time.
 * The operator's reasonable conclusion was that the env vars were ignored.
 *
 * The failure is silent and points the safe-looking way: a provider that is
 * absent reduces the quorum, and a reduced quorum still returns a verdict — it
 * just quietly rests on fewer independent families than anyone believes.
 * MIN_QUORUM_FOR_VETO is 2, so losing one family of three is one step from
 * losing the gate entirely.
 *
 * So this test pins the correspondence. A key added to PROVIDER_ENABLE_KEYS but
 * not passed by the pipeline now fails the build instead of going unnoticed.
 *
 * NOT_PASSED_ON_PURPOSE is an escape hatch that must state WHY, per entry. It is
 * a ratchet in one direction: removing a name from it (wiring the provider up) is
 * always allowed; adding one is a decision that has to be written down here.
 */
import * as fs from 'fs';
import * as path from 'path';
import { PROVIDER_ENABLE_KEYS } from '../src/hal/config';

/**
 * Keys deliberately NOT passed by the strictness-2 pipeline map, each with the
 * reason. These are real gaps, recorded rather than fixed: wiring them up changes
 * which hosts the load-bearing quorum dials, which is a measurement question, not
 * a cleanup. Documented 2026-09-24 when zai was wired.
 */
const NOT_PASSED_ON_PURPOSE: Record<string, string> = {
  HAL_S2_ENABLE_ANTHROPIC:
    'escalation tier, paid. Enabling it from config would let a DB row put a paid ' +
    'frontier model on the live scoring path with no cost review.',
  HAL_S2_ENABLE_GLOO:
    'router, never auto-backfilled and never measured in this quorum. Its own ' +
    'provider block calls it opt-in until its quorum effect has been measured.',
  HAL_S2_ENABLE_NVIDIA_NIM:
    'opt-in, default OFF by explicit decision in PROVIDER_DEFAULTS: it must not ' +
    'join the load-bearing quorum before its effect has been measured.',
};

const PIPELINE = path.join(__dirname, '..', 'src', 'scoring', 'pipeline.ts');

describe('hal config keys vs the pipeline provider map', () => {
  const src = fs.readFileSync(PIPELINE, 'utf8');

  it('passes every resolved provider key, or records why it does not', () => {
    const unpassed = PROVIDER_ENABLE_KEYS.filter(
      (k) => !src.includes(`halConfig.providers.${k}`),
    );
    const undocumented = unpassed.filter((k) => !(k in NOT_PASSED_ON_PURPOSE));

    expect(undocumented).toEqual([]);
  });

  it('keeps zai wired — the family whose absence started this', () => {
    // Named explicitly rather than left to the generic check above: the generic
    // check would go green again if someone ALSO added zai to the exemption map,
    // which is exactly the regression this file exists to prevent.
    expect(PROVIDER_ENABLE_KEYS).toContain('HAL_S2_ENABLE_ZAI');
    expect(src).toContain('halConfig.providers.HAL_S2_ENABLE_ZAI');
    expect(NOT_PASSED_ON_PURPOSE).not.toHaveProperty('HAL_S2_ENABLE_ZAI');
  });

  it('does not exempt a key that is not resolved at all', () => {
    // Keeps the exemption map honest: a stale entry naming a key nobody resolves
    // any more is dead weight that makes the list look more considered than it is.
    const stale = Object.keys(NOT_PASSED_ON_PURPOSE).filter(
      (k) => !(PROVIDER_ENABLE_KEYS as readonly string[]).includes(k),
    );
    expect(stale).toEqual([]);
  });
});
