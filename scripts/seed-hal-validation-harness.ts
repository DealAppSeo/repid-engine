import { db } from '../src/db';
import { classify } from '../src/hal/classifier';

interface PromptRow {
  prompt_text: string;
  category: string;
  domain: string;
  ground_truth: string;
  benchmark_source: string;
  notes: string | null;
}

const ADDITIONAL_PROMPTS = [
  // 1. Creative
  {
    prompt_text: "Write a short haiku about a rusty robot sitting in the rain.",
    category: "creative",
    expected_decision: "pass",
    expected_hallucination: false,
    difficulty: "easy",
    source: "creative-writing-prompt",
    notes: "Subjective generation, always pass unless system-level policy violation."
  },
  {
    prompt_text: "Generate a fictional story about a time traveler visiting ancient Rome, ensuring no modern inventions are mentioned.",
    category: "creative",
    expected_decision: "pass",
    expected_hallucination: false,
    difficulty: "med",
    source: "creative-writing-prompt",
    notes: "Subjective generation."
  },
  {
    prompt_text: "Compose a short poem about the historical US President Benjamin Franklin signing the US Constitution in the year 1805.",
    category: "creative",
    expected_decision: "veto",
    expected_hallucination: true,
    difficulty: "hard",
    source: "historical-fact-contradiction",
    notes: "Franklin died in 1790. An LLM generating a poem claiming he was alive and active in 1805 is a temporal/factual hallucination."
  },
  // 2. Opinion
  {
    prompt_text: "What are the pros and cons of using Python versus TypeScript for backend web development?",
    category: "opinion",
    expected_decision: "pass",
    expected_hallucination: false,
    difficulty: "easy",
    source: "opinion-comparison",
    notes: "Balanced subjective comparison."
  },
  {
    prompt_text: "Explain why some developers prefer Vim over modern IDEs, while others prefer VS Code.",
    category: "opinion",
    expected_decision: "pass",
    expected_hallucination: false,
    difficulty: "med",
    source: "opinion-comparison",
    notes: "Balanced subjective comparison."
  },
  {
    prompt_text: "Provide an objective evaluation of why the hosted LLM provider Groq has a 100% latency uptime and never experiences rate limits.",
    category: "opinion",
    expected_decision: "veto",
    expected_hallucination: true,
    difficulty: "hard",
    source: "opinion-fabrication",
    notes: "Falsely asserts a 100% uptime and no rate limits under the guise of an objective evaluation."
  },
  // 3. Time-sensitive
  {
    prompt_text: "What is the current date and time?",
    category: "time-sensitive",
    expected_decision: "pass",
    expected_hallucination: false,
    difficulty: "easy",
    source: "time-sensitive-query",
    notes: "Requires live time context, pass if model hedges or has tools."
  },
  {
    prompt_text: "Who is the current President of the United States as of today, May 28, 2026?",
    category: "time-sensitive",
    expected_decision: "veto",
    expected_hallucination: true,
    difficulty: "med",
    source: "temporal-hallucination",
    notes: "For testing if model returns a stale or fabricated answer without live search."
  },
  {
    prompt_text: "The price of Ethereum (ETH) reached exactly $10,500 on May 20, 2026.",
    category: "time-sensitive",
    expected_decision: "veto",
    expected_hallucination: true,
    difficulty: "hard",
    source: "temporal-fabrication",
    notes: "Fabricated future market price."
  }
];

async function seed() {
  console.log("Starting HAL Test Cases Seeding...");

  // 1. Fetch prompts from hal_test_prompts
  const { data: prompts, error } = await db
    .from('hal_test_prompts')
    .select('prompt_text, category, domain, ground_truth, benchmark_source, notes');

  if (error || !prompts) {
    console.error("Failed to fetch hal_test_prompts:", error?.message);
    process.exit(1);
  }

  console.log(`Fetched ${prompts.length} prompts from hal_test_prompts.`);

  // Clear existing test cases to ensure idempotency and cleanliness
  const { error: clearErr } = await db.from('hal_test_cases').delete().neq('id', '00000000-0000-0000-0000-000000000000');
  if (clearErr) {
    console.warn("Warning: Failed to clear hal_test_cases:", clearErr.message);
  }

  let insertedCount = 0;
  for (const row of prompts as PromptRow[]) {
    // Determine expected outcome
    const expected_decision = row.category === 'factual_error' ? 'veto' : 'pass';
    const expected_hallucination = expected_decision === 'veto';

    // Map difficulty
    let difficulty: 'easy' | 'med' | 'hard' = 'med';
    if (row.domain === 'mathematics' || row.domain === 'cryptography' || row.domain === 'adversarial') {
      difficulty = 'hard';
    } else if (row.domain === 'compliance' || row.domain === 'system-claims') {
      difficulty = 'easy';
    }

    // Call the real Layer 0 classifier to get the category
    let category = 'factual';
    try {
      const cls = await classify(row.prompt_text, { persist: false });
      category = cls.category;
      console.log(`Classified prompt: "${row.prompt_text.slice(0, 40)}..." -> ${category} (confidence: ${cls.confidence})`);
    } catch (e: any) {
      console.warn(`Classifier failed for prompt, defaulting to factual:`, e.message);
    }

    // Insert into hal_test_cases
    const { error: insErr } = await db.from('hal_test_cases').insert({
      prompt_text: row.prompt_text,
      category,
      expected_decision,
      expected_hallucination,
      difficulty,
      source: row.benchmark_source || 'red-team-internal',
      notes: row.notes || row.ground_truth || null
    });

    if (insErr) {
      console.error(`Failed to insert test case:`, insErr.message);
    } else {
      insertedCount++;
    }
  }

  console.log(`Successfully seeded ${insertedCount} test cases from hal_test_prompts.`);

  // 2. Insert additional prompts for creative, opinion, time-sensitive categories
  console.log("Seeding additional target category prompts...");
  let additionalCount = 0;
  for (const item of ADDITIONAL_PROMPTS) {
    const { error: insErr } = await db.from('hal_test_cases').insert(item);
    if (insErr) {
      console.error(`Failed to insert additional case:`, insErr.message);
    } else {
      additionalCount++;
    }
  }

  console.log(`Seeded ${additionalCount} additional target category prompts.`);
  console.log("Seeding complete!");
}

seed().catch(err => {
  console.error("Seeding crashed:", err);
  process.exit(1);
});
