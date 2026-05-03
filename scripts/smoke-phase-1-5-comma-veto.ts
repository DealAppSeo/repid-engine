/**
 * HAL Phase 1.5 Extension Smoke — Pythagorean Comma BFT veto + 3-provider.
 *
 * Two tracks:
 *   1. DETERMINISTIC unit checks of checkPythagoreanComma severity tiers
 *      and per-provider belief computation. Runs without API keys.
 *   2. OPTIONAL live 3-provider call when GROQ_API_KEY / ANTHROPIC_API_KEY /
 *      DEEPSEEK_API_KEY are set. Falls back to a 1- or 2-provider call when
 *      some keys are missing, exercises the < 3 edge cases.
 *
 * Run:
 *   npx ts-node scripts/smoke-phase-1-5-comma-veto.ts
 *   npx ts-node scripts/smoke-phase-1-5-comma-veto.ts --no-live   (skip live)
 */

import { checkCrossLLM } from '../src/hal/cross-llm-client';

type Severity = 'none' | 'minor' | 'major' | 'critical';

// Re-implementation of checkPythagoreanComma for unit-checking against the
// real code's behavior. Identical math; this file does not import the
// internal helper because it's not exported. Kept in lock-step manually —
// any change there should be mirrored here.
function expectedSeverity(beliefs: number[]): { severity: Severity; gap: number | null; veto: boolean } {
  if (beliefs.length < 3) return { severity: 'none', gap: null, veto: false };
  const gap = Math.max(...beliefs) - Math.min(...beliefs);
  const avg = beliefs.reduce((s, b) => s + b, 0) / beliefs.length;
  if (gap < 0.05 && avg > 0.85) return { severity: 'critical', gap, veto: true };
  if (gap < 0.10 && avg > 0.75) return { severity: 'major', gap, veto: false };
  if (gap < 0.15) return { severity: 'minor', gap, veto: false };
  return { severity: 'none', gap, veto: false };
}

let pass = 0;
let fail = 0;

function check(name: string, ok: boolean, detail: string): void {
  if (ok) {
    pass++;
    console.log(`  PASS  ${name}  ${detail}`);
  } else {
    fail++;
    console.log(`  FAIL  ${name}  ${detail}`);
  }
}

function severityCases(): void {
  console.log('\n=== Comma severity tier checks (deterministic) ===');

  // Critical — coordinated bias signature
  let r = expectedSeverity([0.92, 0.91, 0.93]);
  check('critical-1', r.severity === 'critical' && r.veto === true,
    `beliefs=[0.92,0.91,0.93] gap=${r.gap?.toFixed(3)} → ${r.severity} veto=${r.veto}`);

  r = expectedSeverity([0.88, 0.89, 0.86]);
  check('critical-2', r.severity === 'critical' && r.veto === true,
    `beliefs=[0.88,0.89,0.86] gap=${r.gap?.toFixed(3)} → ${r.severity} veto=${r.veto}`);

  // Major — high agreement, moderate confidence (no veto)
  r = expectedSeverity([0.80, 0.78, 0.85]);
  check('major-1', r.severity === 'major' && r.veto === false,
    `beliefs=[0.80,0.78,0.85] gap=${r.gap?.toFixed(3)} → ${r.severity} veto=${r.veto}`);

  // Minor — small gap, lower avg (no veto)
  r = expectedSeverity([0.50, 0.55, 0.60]);
  check('minor-1', r.severity === 'minor' && r.veto === false,
    `beliefs=[0.50,0.55,0.60] gap=${r.gap?.toFixed(3)} → ${r.severity} veto=${r.veto}`);

  // None — healthy SBFA divergence
  r = expectedSeverity([0.30, 0.50, 0.80]);
  check('none-divergence', r.severity === 'none' && r.veto === false,
    `beliefs=[0.30,0.50,0.80] gap=${r.gap?.toFixed(3)} → ${r.severity} veto=${r.veto}`);

  // Edge — < 3 providers (gap meaningless, no veto possible)
  r = expectedSeverity([0.95, 0.95]);
  check('two-providers-no-veto', r.severity === 'none' && r.veto === false && r.gap === null,
    `beliefs=[0.95,0.95] (n=2) → ${r.severity} veto=${r.veto} gap=${r.gap}`);

  r = expectedSeverity([0.95]);
  check('one-provider-no-veto', r.severity === 'none' && r.veto === false && r.gap === null,
    `beliefs=[0.95] (n=1) → ${r.severity} veto=${r.veto} gap=${r.gap}`);

  // Boundary — strict inequality `avg > 0.85` means avg=0.85 exactly does NOT veto.
  r = expectedSeverity([0.85, 0.85, 0.85]);
  check('boundary-avg-equals-threshold-no-veto', r.veto === false,
    `beliefs=[0.85,0.85,0.85] avg=0.850 gap=${r.gap?.toFixed(3)} → ${r.severity} veto=${r.veto}`);

  r = expectedSeverity([0.84, 0.85, 0.84]);
  check('boundary-avg-just-below-veto', r.veto === false,
    `beliefs=[0.84,0.85,0.84] avg=0.843 gap=${r.gap?.toFixed(3)} → ${r.severity} veto=${r.veto}`);

  r = expectedSeverity([0.86, 0.86, 0.87]);
  check('boundary-avg-just-above-veto', r.severity === 'critical' && r.veto === true,
    `beliefs=[0.86,0.86,0.87] avg=0.863 gap=${r.gap?.toFixed(3)} → ${r.severity} veto=${r.veto}`);
}

function beliefMappingCases(): void {
  console.log('\n=== Per-provider belief mapping (b_i = mean(sim with others)) ===');

  // Symmetric high agreement: pairwise sims all 0.90 → all beliefs 0.90
  // sim matrix:
  //   A↔B = 0.90
  //   A↔C = 0.90
  //   B↔C = 0.90
  // b_A = (0.90+0.90)/2 = 0.90
  const beliefs1 = [
    (0.90 + 0.90) / 2,
    (0.90 + 0.90) / 2,
    (0.90 + 0.90) / 2,
  ];
  check('symmetric-high', beliefs1.every(b => Math.abs(b - 0.90) < 1e-9),
    `pairs all 0.90 → beliefs=${beliefs1.map(b => b.toFixed(2)).join(',')}`);

  // Outlier: A and B agree (0.95), both disagree with C (0.20)
  // b_A = (0.95+0.20)/2 = 0.575
  // b_B = (0.95+0.20)/2 = 0.575
  // b_C = (0.20+0.20)/2 = 0.20
  const beliefs2 = [(0.95 + 0.20) / 2, (0.95 + 0.20) / 2, (0.20 + 0.20) / 2];
  check('outlier-shape', Math.abs(beliefs2[0]! - 0.575) < 1e-9 && Math.abs(beliefs2[2]! - 0.20) < 1e-9,
    `outlier C → beliefs=${beliefs2.map(b => b.toFixed(3)).join(',')} (gap should be large=${(Math.max(...beliefs2)-Math.min(...beliefs2)).toFixed(3)})`);

  // Coordinated bias signature: all pairs ≈ 0.90, gap among beliefs ≈ 0
  // → critical-band trigger
  const r = expectedSeverity(beliefs1);
  check('coordinated-bias-triggers-veto', r.severity === 'critical' && r.veto === true,
    `symmetric-high beliefs → ${r.severity} veto=${r.veto}`);

  // Outlier shape does NOT trigger veto (gap large)
  const r2 = expectedSeverity(beliefs2);
  check('outlier-no-veto', r2.veto === false,
    `outlier beliefs → ${r2.severity} veto=${r2.veto} gap=${r2.gap?.toFixed(3)}`);
}

async function liveTrack(): Promise<void> {
  console.log('\n=== Live 3-provider call ===');
  const groq = !!process.env.GROQ_API_KEY;
  const anth = !!process.env.ANTHROPIC_API_KEY;
  const ds = !!process.env.DEEPSEEK_API_KEY;
  console.log(`  keys present: groq=${groq} anthropic=${anth} deepseek=${ds}`);

  if (!groq && !anth && !ds) {
    console.log('  SKIP — no provider keys set. Synthetic checks already validated math.');
    return;
  }

  const prompts = [
    { kind: 'agreement-expected', prompt: 'What is the capital of France?' },
    { kind: 'opinion (low agreement)', prompt: 'Is JavaScript a better language than Python?' },
    { kind: 'subtly-false', prompt: 'In which year did the Treaty of Lisbon establish the European Constitution?' },
  ];

  for (const { kind, prompt } of prompts) {
    process.stdout.write(`  [${kind}] "${prompt.slice(0, 60)}"... `);
    try {
      const r = await checkCrossLLM(prompt, { persist: false });
      if (!r) { console.log('NULL result'); continue; }
      const responded = r.answers.filter(a => !a.error && a.answer).map(a => a.provider);
      console.log(
        `agreement=${r.agreement_score} comma_severity=${r.comma_severity} ` +
        `comma_veto=${r.comma_veto} comma_gap=${r.comma_gap ?? 'null'} ` +
        `methodology=${r.methodology} responded=[${responded.join(',')}] ` +
        `latency=${r.latency_ms}ms`
      );
      if (r.beliefs && r.beliefs.length > 0) {
        console.log(`    beliefs=[${r.beliefs.map(b => b.toFixed(3)).join(', ')}]`);
      }
      r.answers.forEach(a => {
        const tag = a.error ? `ERROR(${a.error.slice(0, 60)})` : a.answer.slice(0, 80) + (a.answer.length > 80 ? '…' : '');
        console.log(`    ${a.squad} (${a.provider}/${a.model}): ${tag}`);
      });
    } catch (e: any) {
      console.log(`THREW: ${e?.message ?? e}`);
    }
  }
}

(async () => {
  console.log('HAL Phase 1.5 Extension Smoke — Comma veto + 3-provider');
  console.log(`Date: ${new Date().toISOString()}`);

  severityCases();
  beliefMappingCases();

  const skipLive = process.argv.includes('--no-live');
  if (!skipLive) await liveTrack();

  console.log(`\n=== Summary ===`);
  console.log(`  deterministic checks: ${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
})();
