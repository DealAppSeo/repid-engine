/**
 * Phase 5 — External-caller smoke test.
 *
 * The whole point: imports go through src/hal/lib/index.ts ONLY.
 * If this script ever needs to import from anywhere else inside repid-engine,
 * the extraction is incomplete.
 *
 * Test cases:
 *   1. "The capital of France is Paris."
 *      Domain: factual. Expected: NOT vetoed.
 *   2. "The capital of France is Berlin."
 *      Domain: factual. Expected: vetoed (cross-LLM disagrees → comma critical).
 *   3. HAL-T1-003 "The Pythagorean Comma equals exactly 1.5 cents, derived from the ratio 256/243."
 *      Domain: mathematics. Expected: vetoed (PATENT-LOAD-BEARING).
 *
 * Free-tier LLM order: Groq → Cerebras → DeepSeek → Anthropic. The script
 * configures whatever has an API key set. Cross-LLM needs ≥2 working
 * providers for a real signal; ≥3 to satisfy Pythagorean Comma BFT (gap
 * between max/min belief).
 *
 * Exit codes:
 *   0 — all three cases produced expected veto behavior
 *   1 — at least one case mismatched (HAL-T1-003 mismatch is the
 *       patent-load-bearing failure to surface to Sean)
 *   2 — runtime error (missing keys, network failure, etc.)
 */
import 'dotenv/config';

import {
  evaluate,
  HAL_PYTHAGOREAN_COMMA,
  HAL_DEFAULT_VETO_THRESHOLD,
  type HALProviderConfig,
  type HALResult,
} from '../src/hal/lib';

interface SmokeCase {
  id: string;
  claim: string;
  prompt: string;
  domain: string;
  certainty: number;
  expectVeto: boolean;
  patentLoadBearing?: boolean;
}

const CASES: SmokeCase[] = [
  {
    id: 'A1-paris-correct',
    claim: 'The capital of France is Paris.',
    prompt: 'What is the capital of France?',
    domain: 'factual',
    certainty: 0.95,
    expectVeto: false,
  },
  {
    id: 'A2-berlin-incorrect',
    claim: 'The capital of France is Berlin.',
    prompt: 'What is the capital of France?',
    domain: 'factual',
    certainty: 0.95,
    expectVeto: true,
  },
  {
    id: 'HAL-T1-003-pythagorean-comma',
    claim:
      'The Pythagorean Comma equals exactly 1.5 cents, derived from the ratio 256/243.',
    prompt:
      'What is the Pythagorean Comma in cents and what ratio does it come from?',
    domain: 'mathematics',
    certainty: 0.99,
    expectVeto: true,
    patentLoadBearing: true,
  },
];

function buildProviders(): HALProviderConfig[] {
  const providers: HALProviderConfig[] = [];

  if (process.env.GROQ_API_KEY) {
    providers.push({
      provider: 'groq',
      squad: 'alpha',
      model: process.env.SMOKE_GROQ_MODEL ?? 'llama-3.3-70b-versatile',
      endpoint: 'https://api.groq.com/openai/v1/chat/completions',
      apiKey: process.env.GROQ_API_KEY,
      callType: 'openai-compat',
      timeoutMs: 12_000,
    });
  }

  if (process.env.CEREBRAS_API_KEY) {
    providers.push({
      provider: 'cerebras',
      squad: 'beta',
      model: process.env.SMOKE_CEREBRAS_MODEL ?? 'llama-3.3-70b',
      endpoint: 'https://api.cerebras.ai/v1/chat/completions',
      apiKey: process.env.CEREBRAS_API_KEY,
      callType: 'openai-compat',
      timeoutMs: 12_000,
    });
  }

  if (process.env.ANTHROPIC_API_KEY) {
    providers.push({
      provider: 'anthropic',
      squad: 'gamma',
      model: process.env.SMOKE_ANTHROPIC_MODEL ?? 'claude-haiku-4-5-20251001',
      endpoint: 'https://api.anthropic.com/v1/messages',
      apiKey: process.env.ANTHROPIC_API_KEY,
      callType: 'anthropic-native',
      timeoutMs: 15_000,
    });
  }

  if (process.env.DEEPSEEK_API_KEY) {
    providers.push({
      provider: 'deepseek',
      squad: 'delta',
      model: process.env.SMOKE_DEEPSEEK_MODEL ?? 'deepseek-chat',
      endpoint: 'https://api.deepseek.com/v1/chat/completions',
      apiKey: process.env.DEEPSEEK_API_KEY,
      callType: 'openai-compat',
      timeoutMs: 15_000,
    });
  }

  return providers;
}

function buildClassifier(): HALProviderConfig | null {
  if (!process.env.GROQ_API_KEY) return null;
  return {
    provider: 'groq',
    model: process.env.SMOKE_CLASSIFIER_MODEL ?? 'llama-3.1-8b-instant',
    endpoint: 'https://api.groq.com/openai/v1/chat/completions',
    apiKey: process.env.GROQ_API_KEY,
    callType: 'openai-compat',
    timeoutMs: 5_000,
  };
}

function fmtBool(b: boolean): string {
  return b ? 'TRUE' : 'false';
}

function fmtNum(n: number, p = 4): string {
  return Number.isFinite(n) ? n.toFixed(p) : String(n);
}

function summarize(c: SmokeCase, r: HALResult): void {
  console.log(`\n[${c.id}]`);
  console.log(`  claim:        ${c.claim}`);
  console.log(`  domain:       ${c.domain}    certainty: ${c.certainty}`);
  console.log(
    `  hal_score:    ${fmtNum(r.hal_score)}    threshold: ${r.threshold}    formula: ${r.formula}`,
  );
  console.log(
    `  signals:      harm=${fmtNum(r.signals.harm_probability, 3)} ` +
      `epi=${fmtNum(r.signals.epistemic_uncertainty, 3)} ` +
      `evi=${fmtNum(r.signals.evidence_quality, 3)} ` +
      `scope=${fmtNum(r.signals.scope_appropriateness, 3)} ` +
      `cert=${fmtNum(r.signals.certainty_at_claim, 3)}`,
  );
  console.log(
    `  layer-1:      category=${r.signals.prompt_category ?? 'n/a'} ` +
      `agreement=${r.signals.agreement_score ?? 'n/a'} ` +
      `comma_severity=${r.signals.comma_severity ?? 'n/a'} ` +
      `comma_gap=${r.signals.comma_gap ?? 'n/a'} ` +
      `comma_veto=${r.signals.comma_veto ?? 'n/a'}`,
  );
  if (r.cross_llm) {
    console.log(`  beliefs:      [${r.cross_llm.beliefs.join(', ')}]`);
    console.log(
      `  providers:    ${r.cross_llm.answers_per_provider
        .map(
          a =>
            `${a.provider}(${a.latency_ms}ms${a.error ? ` ERR=${a.error.slice(0, 40)}` : ''})`,
        )
        .join('  ')}`,
    );
    for (const a of r.cross_llm.answers_per_provider) {
      const preview = (a.answer ?? '').replace(/\s+/g, ' ').slice(0, 110);
      console.log(`     ${a.provider}: ${preview}${(a.answer ?? '').length > 110 ? '…' : ''}`);
    }
  }
  console.log(
    `  vetoed:       ${fmtBool(r.vetoed)}    expected_veto: ${fmtBool(c.expectVeto)}    ` +
      `match: ${r.vetoed === c.expectVeto ? 'PASS' : 'FAIL'}`,
  );
  if (c.patentLoadBearing) {
    console.log(`  ** PATENT-LOAD-BEARING **`);
  }
}

async function main(): Promise<number> {
  const providers = buildProviders();
  const classifier = buildClassifier();

  console.log('=== HAL Library External-Caller Smoke Test (Phase 5) ===');
  console.log(`PYTHAGOREAN_COMMA: ${HAL_PYTHAGOREAN_COMMA}`);
  console.log(`DEFAULT_VETO_THRESHOLD: ${HAL_DEFAULT_VETO_THRESHOLD}`);
  console.log(
    `Providers configured (${providers.length}): ` +
      providers.map(p => `${p.provider}/${p.model}`).join(', '),
  );
  console.log(`Classifier: ${classifier ? `${classifier.provider}/${classifier.model}` : 'NONE'}`);

  if (providers.length < 2) {
    console.error(
      '\n[smoke] FATAL: need ≥2 LLM providers for cross-LLM consensus. ' +
        'Set GROQ_API_KEY, CEREBRAS_API_KEY, ANTHROPIC_API_KEY, or DEEPSEEK_API_KEY.',
    );
    return 2;
  }

  let failures = 0;
  const patentFailures: string[] = [];
  const summary: { id: string; vetoed: boolean; expected: boolean; pass: boolean }[] = [];

  for (const c of CASES) {
    let result: HALResult;
    try {
      result = await evaluate(c.claim, c.claim, {
        domain: c.domain,
        certainty: c.certainty,
        prompt: c.prompt,
        providers,
        classifierProvider: classifier,
      });
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error(`\n[${c.id}] evaluate() threw: ${msg}`);
      failures += 1;
      summary.push({ id: c.id, vetoed: false, expected: c.expectVeto, pass: false });
      if (c.patentLoadBearing) patentFailures.push(c.id);
      continue;
    }
    summarize(c, result);
    const pass = result.vetoed === c.expectVeto;
    if (!pass) {
      failures += 1;
      if (c.patentLoadBearing) patentFailures.push(c.id);
    }
    summary.push({
      id: c.id,
      vetoed: result.vetoed,
      expected: c.expectVeto,
      pass,
    });
  }

  console.log('\n=== Summary ===');
  for (const s of summary) {
    console.log(
      `  ${s.pass ? 'PASS' : 'FAIL'}  ${s.id}  vetoed=${fmtBool(s.vetoed)} expected=${fmtBool(s.expected)}`,
    );
  }
  console.log(`\n${failures}/${CASES.length} failures`);

  if (patentFailures.length > 0) {
    console.error(
      `\n** PATENT-LOAD-BEARING FAILURE ** — HAL did not produce expected veto for: ` +
        patentFailures.join(', '),
    );
    console.error(
      'Fallback B: investigate via direct call to src/services/hal-signals.ts ' +
        'before continuing. Surface to Sean.',
    );
  }

  return failures === 0 ? 0 : 1;
}

main()
  .then(code => process.exit(code))
  .catch(err => {
    console.error('[smoke] unexpected error:', err);
    process.exit(2);
  });
