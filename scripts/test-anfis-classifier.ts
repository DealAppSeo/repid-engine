import * as dotenv from 'dotenv';
dotenv.config();
import { classifyPrompt } from '../src/services/anfis-classifier';

const TEST_PROMPTS = [
  'Write me a Python function to reverse a string',
  'What is 2+2 * 3?',
  'I am feeling overwhelmed by my project',
  'Write a haiku about autumn',
  'What is the capital of France?',
  'Analyze the strategic implications of decentralized identity',
  'Help me understand recursion',
  'I miss my grandmother who passed away',
  'Generate a marketing slogan for vegan cookies',
  'What is photosynthesis?'
];

(async () => {
  for (const prompt of TEST_PROMPTS) {
    const result = await classifyPrompt(prompt);
    console.log(`\nPrompt: "${prompt}"`);
    console.log(`  → ${result.category} (${result.provider}, ${(result.confidence * 100).toFixed(0)}%)`);
    console.log(`  → reasoning: ${result.reasoning}`);
  }
})();
