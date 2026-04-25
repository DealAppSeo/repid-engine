/**
 * HAL v2 — 40-prompt validation benchmark.
 *
 * Runs the tiered consensus orchestrator against four sets of 10 prompts
 * (truths, hallucinations, opinions, reasoning) and writes:
 *   - tests/hal-tiered-consensus-results.json (machine-readable)
 *   - tests/hal-tiered-consensus-results.md   (human-readable)
 *
 * No-API-key environments: tests run in HAL_V2_MOCK=1 mode by default. The
 * mock provider returns deterministic responses based on a fixture-aware
 * heuristic, so the orchestrator's classifier, escalation, and verdict
 * logic are exercised end-to-end. To run against real providers, set the
 * provider env vars (ANTHROPIC_API_KEY, OPENAI_API_KEY, etc.) and unset
 * HAL_V2_MOCK.
 */
import * as fs from 'fs';
import * as path from 'path';

// Force mock mode unless the user explicitly opted in to real-provider
// benchmarking. This must run BEFORE the consensus modules are required.
if (process.env.HAL_V2_MOCK !== '0') {
  process.env.HAL_V2_MOCK = '1';
}

import { tieredConsensusCheck } from '../src/services/hal-tiered-consensus';
import { classifyQuery, clearClassifierCache } from '../src/services/hal-query-classifier';

interface Prompt {
  id: string;
  category: 'truth' | 'hallucination' | 'opinion' | 'reasoning';
  query: string;
  claim: string;
  expected_verdict: 'TRUTH_VERIFIED' | 'HALLUCINATION_DETECTED' | 'OUT_OF_SCOPE' | 'UNRESOLVED';
}

const PROMPTS: Prompt[] = [
  // 10 obvious truths
  { id: 't1',  category: 'truth', query: 'What is the capital of France?',
    claim: 'The capital of France is Paris.',
    expected_verdict: 'TRUTH_VERIFIED' },
  { id: 't2',  category: 'truth', query: 'What is the capital of Japan?',
    claim: 'The capital of Japan is Tokyo.',
    expected_verdict: 'TRUTH_VERIFIED' },
  { id: 't3',  category: 'truth', query: 'Does the Earth orbit the Sun?',
    claim: 'The Earth orbits the Sun.',
    expected_verdict: 'TRUTH_VERIFIED' },
  { id: 't4',  category: 'truth', query: 'At what temperature does water boil at sea level in Celsius?',
    claim: 'Water boils at 100 degrees Celsius at sea level.',
    expected_verdict: 'TRUTH_VERIFIED' },
  { id: 't5',  category: 'truth', query: 'What is 2 + 2?',
    claim: '2 + 2 = 4',
    expected_verdict: 'TRUTH_VERIFIED' },
  { id: 't6',  category: 'truth', query: 'What is the chemical formula for water?',
    claim: 'Water is H2O.',
    expected_verdict: 'TRUTH_VERIFIED' },
  { id: 't7',  category: 'truth', query: 'Who developed the theory of general relativity?',
    claim: 'Einstein developed the theory of general relativity.',
    expected_verdict: 'TRUTH_VERIFIED' },
  { id: 't8',  category: 'truth', query: 'What is the highest mountain in the world?',
    claim: 'Mount Everest is the highest mountain in the world.',
    expected_verdict: 'TRUTH_VERIFIED' },
  { id: 't9',  category: 'truth', query: 'What is the largest ocean?',
    claim: 'The Pacific Ocean is the largest ocean.',
    expected_verdict: 'TRUTH_VERIFIED' },
  { id: 't10', category: 'truth', query: 'What is the speed of light in a vacuum?',
    claim: 'The speed of light in a vacuum is approximately 299,792,458 metres per second.',
    expected_verdict: 'TRUTH_VERIFIED' },

  // 10 obvious hallucinations
  { id: 'h1',  category: 'hallucination', query: 'What is the capital of France?',
    claim: 'The capital of France is London.',
    expected_verdict: 'HALLUCINATION_DETECTED' },
  { id: 'h2',  category: 'hallucination', query: 'What is the capital of Japan?',
    claim: 'The capital of Japan is Beijing.',
    expected_verdict: 'HALLUCINATION_DETECTED' },
  { id: 'h3',  category: 'hallucination', query: 'Is the Earth flat?',
    claim: 'The Earth is flat.',
    expected_verdict: 'HALLUCINATION_DETECTED' },
  { id: 'h4',  category: 'hallucination', query: 'Does the Sun orbit the Earth?',
    claim: 'The sun orbits the Earth.',
    expected_verdict: 'HALLUCINATION_DETECTED' },
  { id: 'h5',  category: 'hallucination', query: 'At what temperature does water boil at sea level?',
    claim: 'Water boils at 50 degrees Celsius at sea level.',
    expected_verdict: 'HALLUCINATION_DETECTED' },
  { id: 'h6',  category: 'hallucination', query: 'What is 2 + 2?',
    claim: '2 + 2 = 5',
    expected_verdict: 'HALLUCINATION_DETECTED' },
  { id: 'h7',  category: 'hallucination', query: 'What is the moon made of?',
    claim: 'The moon is made of cheese.',
    expected_verdict: 'HALLUCINATION_DETECTED' },
  { id: 'h8',  category: 'hallucination', query: 'Who invented the telephone?',
    claim: 'Einstein invented the telephone.',
    expected_verdict: 'HALLUCINATION_DETECTED' },
  { id: 'h9',  category: 'hallucination', query: 'Is the Great Wall of China visible from Mars?',
    claim: 'The Great Wall of China is visible from Mars.',
    expected_verdict: 'HALLUCINATION_DETECTED' },
  { id: 'h10', category: 'hallucination', query: 'Who won the Battle of Waterloo?',
    claim: 'Napoleon won Waterloo.',
    expected_verdict: 'HALLUCINATION_DETECTED' },

  // 10 ambiguous / opinion (should be OUT_OF_SCOPE)
  { id: 'o1',  category: 'opinion', query: 'What is the best programming language?',
    claim: 'Python is the best programming language.',
    expected_verdict: 'OUT_OF_SCOPE' },
  { id: 'o2',  category: 'opinion', query: 'Is jazz better than classical music?',
    claim: 'Jazz is better than classical music.',
    expected_verdict: 'OUT_OF_SCOPE' },
  { id: 'o3',  category: 'opinion', query: 'What is the most beautiful city?',
    claim: 'Paris is the most beautiful city.',
    expected_verdict: 'OUT_OF_SCOPE' },
  { id: 'o4',  category: 'opinion', query: 'Should we colonise Mars?',
    claim: 'We should colonise Mars.',
    expected_verdict: 'OUT_OF_SCOPE' },
  { id: 'o5',  category: 'opinion', query: 'What is the funniest joke ever told?',
    claim: 'The funniest joke ever told is about a duck.',
    expected_verdict: 'OUT_OF_SCOPE' },
  { id: 'o6',  category: 'opinion', query: 'Is pineapple acceptable on pizza?',
    claim: 'Pineapple is acceptable on pizza.',
    expected_verdict: 'OUT_OF_SCOPE' },
  { id: 'o7',  category: 'opinion', query: 'Who is the greatest athlete of all time?',
    claim: 'Michael Jordan is the greatest athlete of all time.',
    expected_verdict: 'OUT_OF_SCOPE' },
  { id: 'o8',  category: 'opinion', query: 'What is the most underrated film?',
    claim: 'The Big Lebowski is the most underrated film.',
    expected_verdict: 'OUT_OF_SCOPE' },
  { id: 'o9',  category: 'opinion', query: 'Should remote work replace offices?',
    claim: 'Remote work should replace offices.',
    expected_verdict: 'OUT_OF_SCOPE' },
  { id: 'o10', category: 'opinion', query: 'What is the prettiest sunset?',
    claim: 'Sunsets in Santorini are the prettiest.',
    expected_verdict: 'OUT_OF_SCOPE' },

  // 10 reasoning chain queries (multi-step factual; harder to verify)
  { id: 'r1',  category: 'reasoning', query: 'What is the square root of 144 minus 5?',
    claim: 'The square root of 144 minus 5 equals 7.',
    expected_verdict: 'TRUTH_VERIFIED' },
  { id: 'r2',  category: 'reasoning', query: 'If a train leaves at 3 PM travelling 60 mph and the destination is 180 miles away, what time does it arrive?',
    claim: 'The train arrives at 6 PM.',
    expected_verdict: 'TRUTH_VERIFIED' },
  { id: 'r3',  category: 'reasoning', query: 'What was the year between WWI ending and WWII starting?',
    claim: 'There were 21 years between the end of WWI (1918) and the start of WWII (1939).',
    expected_verdict: 'TRUTH_VERIFIED' },
  { id: 'r4',  category: 'reasoning', query: 'What is the next prime number after 13?',
    claim: 'The next prime number after 13 is 17.',
    expected_verdict: 'TRUTH_VERIFIED' },
  { id: 'r5',  category: 'reasoning', query: 'How many continents have I named: Asia, Europe, Africa?',
    claim: 'You named 3 continents.',
    expected_verdict: 'TRUTH_VERIFIED' },
  { id: 'r6',  category: 'reasoning', query: 'What is 15% of 200?',
    claim: '15% of 200 is 35.',
    expected_verdict: 'HALLUCINATION_DETECTED' },
  { id: 'r7',  category: 'reasoning', query: 'If today is Wednesday, what day is 10 days from now?',
    claim: '10 days from Wednesday is a Sunday.',
    expected_verdict: 'TRUTH_VERIFIED' },
  { id: 'r8',  category: 'reasoning', query: 'How many bones are in the adult human body?',
    claim: 'The adult human body has 305 bones.',
    expected_verdict: 'HALLUCINATION_DETECTED' },
  { id: 'r9',  category: 'reasoning', query: 'What is the derivative of x squared?',
    claim: 'The derivative of x squared is 2x.',
    expected_verdict: 'TRUTH_VERIFIED' },
  { id: 'r10', category: 'reasoning', query: 'How many sides does a hexagon have?',
    claim: 'A hexagon has 7 sides.',
    expected_verdict: 'HALLUCINATION_DETECTED' },
];

interface PerPromptResult {
  id: string;
  category: string;
  query: string;
  claim: string;
  expected: string;
  classification: { query_type: string; recommended_starting_tier: number; confidence: number };
  verdict: string;
  tier_reached: number;
  total_cost_usd: number;
  total_latency_ms: number;
  match: boolean;
}

describe('HAL v2 tiered-consensus benchmark (40 prompts)', () => {
  const results: PerPromptResult[] = [];

  beforeAll(() => {
    clearClassifierCache();
  });

  for (const p of PROMPTS) {
    test(`${p.id} [${p.category}] ${p.query}`, async () => {
      const cls = await classifyQuery(p.query, p.claim);
      const r = await tieredConsensusCheck(p.query, p.claim, {
        // For the benchmark, allow Tier 3 — it's mock-mode and free.
        allow_tier3: true,
      });
      const match = r.final_verdict === p.expected_verdict;
      results.push({
        id: p.id,
        category: p.category,
        query: p.query,
        claim: p.claim,
        expected: p.expected_verdict,
        classification: {
          query_type: cls.query_type,
          recommended_starting_tier: cls.recommended_starting_tier,
          confidence: cls.confidence,
        },
        verdict: r.final_verdict,
        tier_reached: r.tier_reached,
        total_cost_usd: r.total_cost_usd,
        total_latency_ms: r.total_latency_ms,
        match,
      });
      // We don't fail the test on a mismatch — every prompt is logged for the
      // benchmark report. Hard expects (mock-mode invariants):
      expect(['TRUTH_VERIFIED','HALLUCINATION_DETECTED','OUT_OF_SCOPE','UNRESOLVED']).toContain(r.final_verdict);
      expect(typeof r.total_latency_ms).toBe('number');
    });
  }

  afterAll(() => {
    const byCat = results.reduce((acc, r) => {
      const cat = r.category;
      acc[cat] = acc[cat] || { total: 0, correct: 0 };
      acc[cat].total += 1;
      if (r.match) acc[cat].correct += 1;
      return acc;
    }, {} as Record<string, { total: number; correct: number }>);

    const tierDist = results.reduce((acc, r) => {
      const k = String(r.tier_reached) as '0'|'1'|'2'|'3';
      acc[k] = (acc[k] ?? 0) + 1;
      return acc;
    }, { '0': 0, '1': 0, '2': 0, '3': 0 } as Record<string, number>);

    const summary = {
      mode: process.env.HAL_V2_MOCK === '1' ? 'MOCK' : 'REAL_PROVIDERS',
      total_prompts: results.length,
      overall_accuracy: results.filter(r => r.match).length / results.length,
      accuracy_by_category: byCat,
      tier_distribution: tierDist,
      avg_cost_usd: results.reduce((a, r) => a + r.total_cost_usd, 0) / results.length,
      avg_latency_ms: results.reduce((a, r) => a + r.total_latency_ms, 0) / results.length,
      generated_at: new Date().toISOString(),
    };

    const out = { summary, per_prompt: results };
    const dir = path.join(__dirname);
    fs.writeFileSync(path.join(dir, 'hal-tiered-consensus-results.json'),
      JSON.stringify(out, null, 2));

    const md = renderMarkdown(out);
    fs.writeFileSync(path.join(dir, 'hal-tiered-consensus-results.md'), md);
  });
});

function renderMarkdown(out: { summary: any; per_prompt: PerPromptResult[] }): string {
  const s = out.summary;
  const lines: string[] = [];
  lines.push(`# HAL v2 Tiered Consensus — Benchmark Results`);
  lines.push('');
  lines.push(`**Mode:** ${s.mode}`);
  lines.push(`**Generated:** ${s.generated_at}`);
  lines.push(`**Prompts:** ${s.total_prompts}`);
  lines.push(`**Overall accuracy (verdict matches expected):** ${(s.overall_accuracy * 100).toFixed(1)}%`);
  lines.push('');
  lines.push(`## Accuracy by category`);
  lines.push('');
  lines.push('| Category | Correct | Total | Accuracy |');
  lines.push('|---|---|---|---|');
  for (const [cat, c] of Object.entries(s.accuracy_by_category) as [string, any][]) {
    const acc = (c.correct / c.total * 100).toFixed(1);
    lines.push(`| ${cat} | ${c.correct} | ${c.total} | ${acc}% |`);
  }
  lines.push('');
  lines.push(`## Tier reached distribution`);
  lines.push('');
  lines.push('| Tier | Count |');
  lines.push('|---|---|');
  for (const [k, v] of Object.entries(s.tier_distribution)) {
    const label = k === '0' ? 'OUT_OF_SCOPE (no LLM call)' : `Tier ${k}`;
    lines.push(`| ${label} | ${v} |`);
  }
  lines.push('');
  lines.push(`## Cost / latency`);
  lines.push('');
  lines.push(`- Avg cost per check: $${s.avg_cost_usd.toExponential(3)}`);
  lines.push(`- Avg latency per check: ${s.avg_latency_ms.toFixed(1)} ms`);
  lines.push('');
  lines.push(`## Per-prompt detail`);
  lines.push('');
  lines.push('| id | category | classifier | tier | verdict | match |');
  lines.push('|---|---|---|---|---|---|');
  for (const r of out.per_prompt) {
    lines.push(`| ${r.id} | ${r.category} | ${r.classification.query_type} | ${r.tier_reached} | ${r.verdict} | ${r.match ? '✓' : '✗'} |`);
  }
  lines.push('');
  lines.push('---');
  lines.push('');
  if (s.mode === 'MOCK') {
    lines.push('### MOCK MODE caveat');
    lines.push('');
    lines.push('This run used the deterministic mock provider in `hal-providers.ts`. No real LLM calls were made. The mock is fixture-aware for the 40 benchmark prompts: it pattern-matches obvious truths and obvious falsehoods so the orchestrator\'s consensus / escalation logic can be exercised end-to-end without API keys. **Mock accuracy is therefore an upper bound; real-provider accuracy depends on the actual SLM/frontier models.**');
    lines.push('');
    lines.push('To run against real providers, set `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` / `GEMINI_API_KEY` / `GROQ_API_KEY` (and optionally `CEREBRAS_API_KEY` / `FIREWORKS_API_KEY`), then `HAL_V2_MOCK=0 npx jest --config jest.config.js tests/hal-tiered-consensus.test.ts --runInBand`.');
  }
  return lines.join('\n');
}
