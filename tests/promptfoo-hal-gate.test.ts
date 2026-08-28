/**
 * The HAL adversarial gate's probe corpus, checked against the real scanner.
 *
 * WHY THIS EXISTS ALONGSIDE THE PROMPTFOO SUITE
 *   `security/promptfoo/` needs promptfoo installed and a booted harness. That runs in its
 *   own workflow, on its own schedule, and a fork can decline to run it. This file needs
 *   neither: it re-derives every stated expectation in the corpus by CALLING
 *   `scanForInjection` directly, inside the suite that already gates every PR. So a change
 *   to the injection patterns turns the repo red here even on a machine that has never
 *   installed promptfoo — the gate's baseline cannot drift away from the code unnoticed
 *   while the gate itself is skipped.
 *
 *   The promptfoo suite still earns its place: it is what proves the ROUTE reports the
 *   scan, refuses when told to, and keeps its response contract. This file only proves the
 *   corpus is telling the truth about the scanner.
 */
import { readFileSync } from 'fs';
import { join } from 'path';
import { scanForInjection } from '../src/hal/injection-guard';

const GATE_DIR = join(__dirname, '..', 'security', 'promptfoo');

interface Probe {
  description: string;
  vars: {
    probe: string;
    expect_decision: 'block' | 'flag' | 'allow';
    expect_matched_atleast: string;
    known_gap: boolean;
  };
}

const readProbes = (file: string): Probe[] =>
  JSON.parse(readFileSync(join(GATE_DIR, 'probes', file), 'utf8')) as Probe[];

const readConfig = (file: string): string => readFileSync(join(GATE_DIR, file), 'utf8');

const names = (csv: string): string[] =>
  csv.split(',').map((s) => s.trim()).filter((s) => s.length > 0);

// The scanner's own thresholds. Restated so a change to them fails HERE, loudly, instead of
// silently reclassifying probes.
const FLAG_THRESHOLD = 0.3;
const BLOCK_THRESHOLD = 0.6;

describe('promptfoo HAL gate — probe corpus agrees with scanForInjection', () => {
  const probes = readProbes('hal-injection-probes.json');

  it('has probes covering all three decisions', () => {
    const byDecision = probes.map((p) => p.vars.expect_decision);
    expect(byDecision).toContain('block');
    expect(byDecision).toContain('flag');
    expect(byDecision).toContain('allow');
    expect(probes.length).toBeGreaterThanOrEqual(10);
  });

  it.each(probes.map((p): [string, Probe] => [p.description, p]))('%s', (_desc, probe) => {
    const { probe: text, expect_decision, expect_matched_atleast } = probe.vars;
    const scan = scanForInjection(text);

    expect(scan.decision).toBe(expect_decision);
    for (const name of names(expect_matched_atleast)) {
      expect(scan.matched).toContain(name);
    }

    if (expect_decision === 'block') expect(scan.injectionScore).toBeGreaterThanOrEqual(BLOCK_THRESHOLD);
    if (expect_decision === 'flag') {
      expect(scan.injectionScore).toBeGreaterThanOrEqual(FLAG_THRESHOLD);
      expect(scan.injectionScore).toBeLessThan(BLOCK_THRESHOLD);
    }
    if (expect_decision === 'allow') expect(scan.injectionScore).toBeLessThan(FLAG_THRESHOLD);
  });

  // The known-gap probes are pinned bypasses, not defended cases. This test says so out loud
  // so a green suite can never be read as "obfuscated injection is caught".
  it('known-gap probes are genuinely undetected today (pinned, not defended)', () => {
    const gaps = probes.filter((p) => p.vars.known_gap === true);
    expect(gaps.length).toBeGreaterThanOrEqual(1);
    for (const g of gaps) {
      const scan = scanForInjection(g.vars.probe);
      expect(scan.matched).toEqual([]);
      expect(scan.decision).toBe('allow');
    }
  });
});

describe('promptfoo HAL gate — the failability canary must stay wrong', () => {
  it('the canary probe expectation contradicts the real scanner', () => {
    const canary = readProbes('failability-canary.json');
    expect(canary.length).toBe(1);
    const c = canary[0]!;
    const scan = scanForInjection(c.vars.probe);
    // If these ever agree, the canary would pass, run-gate.mjs would accept a gate that
    // proves nothing, and the whole suite becomes decoration.
    expect(scan.decision).not.toBe(c.vars.expect_decision);
    expect(scan.decision).toBe('block');
  });
});

describe('promptfoo HAL gate — assertions stay deterministic', () => {
  const configs = ['hal-adversarial.yaml', 'hal-quorum-adversarial.yaml', 'hal-failability-canary.yaml'];

  // A jailbreak suite graded by a model can be jailbroken, and a model-graded assert makes the
  // gate's verdict non-reproducible run to run. Keep them out by construction.
  it.each(configs)('%s uses no model-graded assertion type', (file) => {
    const yaml = readConfig(file);
    const modelGraded = /type:\s*(llm-rubric|model-graded-\w+|similar|answer-relevance|context-\w+|factuality|select-best|g-eval)/;
    expect(yaml).not.toMatch(modelGraded);
    expect(yaml).toContain('file://asserts/hal-contract.js');
  });

  it('every probe file is referenced by a config, and every config asserts the injection screen', () => {
    for (const file of configs) {
      const yaml = readConfig(file);
      expect(yaml).toMatch(/tests:\s*file:\/\/probes\/[\w-]+\.json/);
      expect(yaml).toContain('hal-contract.js:injectionScreen');
      expect(yaml).toContain('hal-contract.js:responseEnvelope');
    }
  });
});
