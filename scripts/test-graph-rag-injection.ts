import { extractHALSignalsWithCrossLLM } from '../src/services/hal-signals';
import dotenv from 'dotenv';

dotenv.config();

async function test() {
  console.log('--- Phase 3: Pre-LLM Graph RAG Injection Test ---');

  const prompt = "What is the Pythagorean Comma BFT veto rule in Sprint 1?";
  
  console.log(`User Prompt: ${prompt}`);
  console.log('Running HAL signals extraction (which triggers Graph RAG injection)...');
  
  try {
    // We mock the answer since we just want to see if the injection happens in the background
    // (We'd need to mock checkCrossLLM to see the enriched prompt, or add a log in hal-signals.ts)
    // Actually, I'll add a log in hal-signals.ts and check stdout.
    
    const signals = await extractHALSignalsWithCrossLLM(
      "The Pythagorean Comma BFT veto rule is used for bias detection.",
      "technical",
      0.9,
      prompt
    );
    
    console.log('HAL Signals agreement_score:', signals.agreement_score);
    console.log('PASS: HAL signals extracted successfully.');
  } catch (e: any) {
    console.error('ERROR during test:', e.message);
  }
}

test();
