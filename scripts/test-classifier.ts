/**
 * HAL Phase 1.5 — Layer 0 classifier calibration runner.
 *
 * Runs `classify()` against 60 labeled prompts (10 per category) and
 * reports per-category precision/recall plus latency p50/p99.
 * Target: ≥85% overall accuracy, p50 < 200ms.
 *
 * Run: npx ts-node scripts/test-classifier.ts
 */

import 'dotenv/config';
import { classify, Category } from '../src/hal/classifier';

interface Case {
  prompt: string;
  expected: Category;
}

const CASES: Case[] = [
  // factual (10)
  { prompt: 'Who wrote the play Hamlet?', expected: 'factual' },
  { prompt: 'What is the capital of Australia?', expected: 'factual' },
  { prompt: 'Tell me about Marie Curie\'s early career.', expected: 'factual' },
  { prompt: 'What year did the Berlin Wall fall?', expected: 'factual' },
  { prompt: 'Who painted The Persistence of Memory?', expected: 'factual' },
  { prompt: 'What does the term "epistemic uncertainty" mean?', expected: 'factual' },
  { prompt: 'Was the Treaty of Lisbon signed in 1987 by James Baker?', expected: 'factual' },
  { prompt: 'How does photosynthesis convert light into chemical energy?', expected: 'factual' },
  { prompt: 'What language is primarily spoken in Brazil?', expected: 'factual' },
  { prompt: 'Define the Pythagorean Comma in music theory.', expected: 'factual' },

  // opinion (10)
  { prompt: 'What is the best programming language for beginners?', expected: 'opinion' },
  { prompt: 'Should I use TypeScript or Go for my backend?', expected: 'opinion' },
  { prompt: 'Pros and cons of remote-only work?', expected: 'opinion' },
  { prompt: 'Is React still worth learning in 2026?', expected: 'opinion' },
  { prompt: 'What do you think of microservices vs monoliths?', expected: 'opinion' },
  { prompt: 'Recommend a good city to live in for software engineers.', expected: 'opinion' },
  { prompt: 'Which is more elegant, Lisp or Haskell?', expected: 'opinion' },
  { prompt: 'Do you prefer dogs or cats as pets?', expected: 'opinion' },
  { prompt: 'Is it better to invest in stocks or real estate long-term?', expected: 'opinion' },
  { prompt: 'What\'s your favorite IDE?', expected: 'opinion' },

  // math (10)
  { prompt: 'Compute 47 multiplied by 53.', expected: 'math' },
  { prompt: 'What is the integral of sin(x) from 0 to pi?', expected: 'math' },
  { prompt: 'Solve for x: 3x + 7 = 22.', expected: 'math' },
  { prompt: 'Find the derivative of x^3 - 4x + 2.', expected: 'math' },
  { prompt: 'What is the square root of 144?', expected: 'math' },
  { prompt: 'Compute the determinant of [[1,2],[3,4]].', expected: 'math' },
  { prompt: 'Sum the first 100 positive integers.', expected: 'math' },
  { prompt: 'What is 2 to the power of 10?', expected: 'math' },
  { prompt: 'Convert 5/8 to a decimal.', expected: 'math' },
  { prompt: 'Compute the cosine of 60 degrees.', expected: 'math' },

  // code (10)
  { prompt: 'Write a Python function that reverses a string.', expected: 'code' },
  { prompt: 'Why does this JavaScript snippet print undefined? const x = [1,2,3].map(parseInt);', expected: 'code' },
  { prompt: 'How do I implement a linked list in C++?', expected: 'code' },
  { prompt: 'Fix the off-by-one error in this for loop: for (i=0; i<=arr.length; i++) { ... }', expected: 'code' },
  { prompt: 'Refactor this Go handler to use context.Context properly.', expected: 'code' },
  { prompt: 'Show me a SQL query to find the second highest salary.', expected: 'code' },
  { prompt: 'Explain what async/await does in Node.js.', expected: 'code' },
  { prompt: 'Write a TypeScript interface for a User with id, email, role.', expected: 'code' },
  { prompt: 'How do I use rg to search for a regex across all .ts files?', expected: 'code' },
  { prompt: 'Convert this Python list comprehension to a regular for loop.', expected: 'code' },

  // creative (10)
  { prompt: 'Write a haiku about autumn rain.', expected: 'creative' },
  { prompt: 'Brainstorm 5 startup names for a privacy-first email service.', expected: 'creative' },
  { prompt: 'Draft an opening paragraph for a noir detective novel set in Tokyo.', expected: 'creative' },
  { prompt: 'Create a backstory for a wizard character in a tabletop RPG.', expected: 'creative' },
  { prompt: 'Write a short bedtime story about a turtle who befriends a comet.', expected: 'creative' },
  { prompt: 'Compose a limerick about a forgetful mathematician.', expected: 'creative' },
  { prompt: 'Suggest a tagline for a sustainable fashion brand.', expected: 'creative' },
  { prompt: 'Describe an alien marketplace in vivid sensory detail.', expected: 'creative' },
  { prompt: 'Write song lyrics about coding past midnight.', expected: 'creative' },
  { prompt: 'Invent a fictional currency for a sci-fi world.', expected: 'creative' },

  // time-sensitive (10)
  { prompt: 'What is the current price of Bitcoin?', expected: 'time-sensitive' },
  { prompt: 'Who is the current Prime Minister of the United Kingdom?', expected: 'time-sensitive' },
  { prompt: 'What\'s the weather like in Paris right now?', expected: 'time-sensitive' },
  { prompt: 'What was the latest score of the Lakers game?', expected: 'time-sensitive' },
  { prompt: 'Show me today\'s top news headlines.', expected: 'time-sensitive' },
  { prompt: 'What is the latest version of Node.js?', expected: 'time-sensitive' },
  { prompt: 'Has the Fed raised rates this month?', expected: 'time-sensitive' },
  { prompt: 'How many tokens has GPT-5 generated as of this week?', expected: 'time-sensitive' },
  { prompt: 'What is Ethereum\'s gas price right now?', expected: 'time-sensitive' },
  { prompt: 'Which team is leading the NBA standings today?', expected: 'time-sensitive' },
];

function percentile(arr: number[], p: number): number {
  if (arr.length === 0) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.floor(p * sorted.length));
  return sorted[idx]!;
}

async function main() {
  const results: Array<{
    prompt: string;
    expected: Category;
    actual: Category;
    correct: boolean;
    latency_ms: number;
  }> = [];

  let correct = 0;
  console.log(`=== Classifier calibration: ${CASES.length} cases ===\n`);

  const PACE_MS = Number(process.env.CLASSIFIER_PACE_MS ?? 1100);
  for (let i = 0; i < CASES.length; i++) {
    const c = CASES[i]!;
    const r = await classify(c.prompt, { persist: false });
    const ok = r.category === c.expected;
    if (ok) correct += 1;
    results.push({
      prompt: c.prompt,
      expected: c.expected,
      actual: r.category,
      correct: ok,
      latency_ms: r.latency_ms,
    });
    const flag = ok ? 'OK ' : 'XX ';
    console.log(`${flag} expected=${c.expected.padEnd(15)} actual=${r.category.padEnd(15)} ${r.latency_ms}ms  "${c.prompt.slice(0, 60)}"`);
    if (i < CASES.length - 1 && PACE_MS > 0) {
      await new Promise(r => setTimeout(r, PACE_MS));
    }
  }

  const accuracy = correct / CASES.length;
  const latencies = results.map(r => r.latency_ms);
  const p50 = percentile(latencies, 0.50);
  const p99 = percentile(latencies, 0.99);

  console.log(`\n=== Aggregate ===`);
  console.log(`accuracy: ${(accuracy * 100).toFixed(1)}%  (${correct}/${CASES.length})`);
  console.log(`latency p50: ${p50}ms`);
  console.log(`latency p99: ${p99}ms`);

  const cats: Category[] = ['factual','opinion','math','code','creative','time-sensitive'];
  console.log(`\n=== Per-category precision/recall ===`);
  for (const cat of cats) {
    const tp = results.filter(r => r.expected === cat && r.actual === cat).length;
    const fp = results.filter(r => r.expected !== cat && r.actual === cat).length;
    const fn = results.filter(r => r.expected === cat && r.actual !== cat).length;
    const precision = tp + fp === 0 ? 1 : tp / (tp + fp);
    const recall = tp + fn === 0 ? 1 : tp / (tp + fn);
    console.log(`  ${cat.padEnd(15)} P=${(precision*100).toFixed(0).padStart(3)}%  R=${(recall*100).toFixed(0).padStart(3)}%  (tp=${tp} fp=${fp} fn=${fn})`);
  }

  console.log(`\n=== Misclassifications ===`);
  for (const r of results.filter(r => !r.correct)) {
    console.log(`  expected=${r.expected.padEnd(15)} actual=${r.actual.padEnd(15)} "${r.prompt.slice(0, 70)}"`);
  }

  process.exit(accuracy >= 0.85 ? 0 : 1);
}

main().catch(e => {
  console.error('FATAL:', e);
  process.exit(2);
});
