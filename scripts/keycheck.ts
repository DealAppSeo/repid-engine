import * as fs from 'fs';
import * as path from 'path';
import { checkAllKeys, KeyHealthRecord } from '../src/services/key-health';

const JSON_FILE_PATH = path.join(process.cwd(), 'key-health.json');

const UNBLOCK_INSTRUCTIONS: Record<string, string> = {
  anthropic: 'Ensure ANTHROPIC_API_KEY is correct in .env, and check billing/status at https://console.anthropic.com/',
  openai: 'Ensure OPENAI_API_KEY is correct in .env, and check billing/usage at https://platform.openai.com/',
  groq: 'Ensure GROQ_API_KEY is correct in .env, and check limits/billing at https://console.groq.com/',
  cerebras: 'Ensure CEREBRAS_API_KEY is correct in .env, and check Cerebras Console at https://console.cerebras.ai/',
  deepseek: 'Ensure DEEPSEEK_API_KEY is correct in .env, and check billing at https://platform.deepseek.com/',
  fireworks: 'Ensure FIREWORKS_API_KEY is correct in .env, and check billing status at https://fireworks.ai/account/billing',
  gemini: 'Ensure GEMINI_API_KEY (or GOOGLE_API_KEY) is correct in .env, and check Google AI Studio console at https://aistudio.google.com/',
  cohere: 'Ensure COHERE_API_KEY is correct in .env, and check Cohere Dashboard at https://dashboard.cohere.com/',
  mistral: 'Ensure MISTRAL_API_KEY is correct in .env, and check billing at https://console.mistral.ai/'
};

async function run() {
  console.log('\n======================================================');
  console.log('🔄  RUNNING LLM PROVIDER KEY HEALTH CHECK REGISTRY...');
  console.log('======================================================\n');

  try {
    const results = await checkAllKeys();

    // Write to key-health.json
    fs.writeFileSync(JSON_FILE_PATH, JSON.stringify(results, null, 2), 'utf8');
    console.log(`✅ Status written successfully to key-health.json`);
    console.log(`📅 Timestamp: ${new Date().toISOString()}\n`);

    // Prepare table output
    const tableData = results.map(r => ({
      Provider: r.provider.toUpperCase(),
      Model: r.model,
      Status: r.status === 'LIVE' ? '🟢 LIVE' : r.status === 'DEAD_401' ? '🔴 DEAD_401' : r.status === 'BILLING_BLOCKED' ? '🟠 BILLING_BLOCKED' : r.status === 'RATE_LIMITED' ? '🟡 RATE_LIMITED' : '⚪ UNREACHABLE',
      'Latency (ms)': r.status === 'LIVE' ? `${r.latency_ms}ms` : 'N/A'
    }));

    console.table(tableData);

    // Filter out issues that require attention
    const nonLive = results.filter(r => r.status !== 'LIVE');
    if (nonLive.length > 0) {
      console.log('\n⚠️  ATTENTION REQUIRED — NON-LIVE PROVIDERS DETECTED:');
      console.log('------------------------------------------------------');
      for (const item of nonLive) {
        const step = UNBLOCK_INSTRUCTIONS[item.provider.toLowerCase()] || 'Configure correct API key in .env';
        console.log(`❌ [${item.provider.toUpperCase()}] Status: ${item.status}`);
        console.log(`👉 Unblock Action: ${step}\n`);
      }
    } else {
      console.log('\n🎉 All provider keys are LIVE and healthy!');
    }

  } catch (error: any) {
    console.error(`❌ Unexpected error running key health checks: ${error.message}`);
    process.exit(1);
  }
}

run();
