import * as fs from 'fs';
import * as path from 'path';
import 'dotenv/config';

export interface KeyHealthRecord {
  provider: string;
  model: string;
  status: 'LIVE' | 'DEAD_401' | 'BILLING_BLOCKED' | 'RATE_LIMITED' | 'UNREACHABLE' | 'UNKNOWN';
  last_checked: string;
  latency_ms: number;
}

const JSON_FILE_PATH = path.join(process.cwd(), 'key-health.json');

interface ProviderConfig {
  name: string;
  envKey: string;
  model: string;
  url: string;
  headers: (key: string) => Record<string, string>;
  body: string;
}

const PROVIDER_CONFIGS: ProviderConfig[] = [
  {
    name: 'anthropic',
    envKey: 'ANTHROPIC_API_KEY',
    model: 'claude-haiku-4-5-20251001',
    url: 'https://api.anthropic.com/v1/messages',
    headers: (key) => ({
      'Content-Type': 'application/json',
      'x-api-key': key,
      'anthropic-version': '2023-06-01'
    }),
    body: JSON.stringify({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 1,
      messages: [{ role: 'user', content: 'Say OK' }]
    })
  },
  {
    name: 'openai',
    envKey: 'OPENAI_API_KEY',
    model: 'gpt-4o-mini',
    url: 'https://api.openai.com/v1/chat/completions',
    headers: (key) => ({
      'Content-Type': 'application/json',
      Authorization: `Bearer ${key}`
    }),
    body: JSON.stringify({
      model: 'gpt-4o-mini',
      max_tokens: 1,
      messages: [{ role: 'user', content: 'Say OK' }]
    })
  },
  {
    name: 'groq',
    envKey: 'GROQ_API_KEY',
    model: 'llama-3.3-70b-versatile',
    url: 'https://api.groq.com/openai/v1/chat/completions',
    headers: (key) => ({
      'Content-Type': 'application/json',
      Authorization: `Bearer ${key}`
    }),
    body: JSON.stringify({
      model: 'llama-3.3-70b-versatile',
      max_tokens: 1,
      messages: [{ role: 'user', content: 'Say OK' }]
    })
  },
  {
    name: 'cerebras',
    envKey: 'CEREBRAS_API_KEY',
    model: 'llama-3.3-70b',
    url: 'https://api.cerebras.ai/v1/chat/completions',
    headers: (key) => ({
      'Content-Type': 'application/json',
      Authorization: `Bearer ${key}`
    }),
    body: JSON.stringify({
      model: 'llama-3.3-70b',
      max_tokens: 1,
      messages: [{ role: 'user', content: 'Say OK' }]
    })
  },
  {
    name: 'deepseek',
    envKey: 'DEEPSEEK_API_KEY',
    model: 'deepseek-chat',
    url: 'https://api.deepseek.com/v1/chat/completions',
    headers: (key) => ({
      'Content-Type': 'application/json',
      Authorization: `Bearer ${key}`
    }),
    body: JSON.stringify({
      model: 'deepseek-chat',
      max_tokens: 1,
      messages: [{ role: 'user', content: 'Say OK' }]
    })
  },
  {
    name: 'fireworks',
    envKey: 'FIREWORKS_API_KEY',
    model: 'accounts/fireworks/models/llama-v3p1-8b-instruct',
    url: 'https://api.fireworks.ai/inference/v1/chat/completions',
    headers: (key) => ({
      'Content-Type': 'application/json',
      Authorization: `Bearer ${key}`
    }),
    body: JSON.stringify({
      model: 'accounts/fireworks/models/llama-v3p1-8b-instruct',
      max_tokens: 1,
      messages: [{ role: 'user', content: 'Say OK' }]
    })
  },
  {
    name: 'gemini',
    envKey: 'GEMINI_API_KEY',
    model: 'gemini-2.0-flash',
    url: '', // Dynamically built in fetch call using key
    headers: () => ({
      'Content-Type': 'application/json'
    }),
    body: JSON.stringify({
      contents: [{ parts: [{ text: 'Say OK' }] }],
      generationConfig: { maxOutputTokens: 1 }
    })
  },
  {
    name: 'cohere',
    envKey: 'COHERE_API_KEY',
    model: 'command-r-plus',
    url: 'https://api.cohere.com/v1/chat',
    headers: (key) => ({
      'Content-Type': 'application/json',
      Authorization: `Bearer ${key}`
    }),
    body: JSON.stringify({
      message: 'Say OK',
      model: 'command-r-plus'
    })
  },
  {
    name: 'mistral',
    envKey: 'MISTRAL_API_KEY',
    model: 'open-mistral-7b',
    url: 'https://api.mistral.ai/v1/chat/completions',
    headers: (key) => ({
      'Content-Type': 'application/json',
      Authorization: `Bearer ${key}`
    }),
    body: JSON.stringify({
      model: 'open-mistral-7b',
      max_tokens: 1,
      messages: [{ role: 'user', content: 'Say OK' }]
    })
  }
];

export async function probeSingleKey(p: ProviderConfig, apiKey: string): Promise<KeyHealthRecord> {
  const start = Date.now();
  const last_checked = new Date().toISOString();

  // If the key is empty, immediately classify as DEAD_401 (no call needed)
  if (!apiKey.trim()) {
    return {
      provider: p.name,
      model: p.model,
      status: 'DEAD_401',
      last_checked,
      latency_ms: 0
    };
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 8000); // 8-second timeout for robust network

  try {
    const requestUrl = p.name === 'gemini' 
      ? `https://generativelanguage.googleapis.com/v1beta/models/${p.model}:generateContent?key=${apiKey}`
      : p.url;

    const res = await fetch(requestUrl, {
      method: 'POST',
      headers: p.headers(apiKey),
      body: p.body,
      signal: controller.signal
    });

    clearTimeout(timeoutId);
    const latency_ms = Date.now() - start;

    if (res.ok) {
      return {
        provider: p.name,
        model: p.model,
        status: 'LIVE',
        last_checked,
        latency_ms
      };
    }

    const status = res.status;
    const responseText = await res.text().catch(() => '');
    const lowerText = responseText.toLowerCase();

    // Classification mapping based on status and response text
    if (status === 401 || status === 403 || lowerText.includes('invalid_api_key') || lowerText.includes('api key') || lowerText.includes('unauthorized') || lowerText.includes('forbidden') || lowerText.includes('credentials')) {
      return {
        provider: p.name,
        model: p.model,
        status: 'DEAD_401',
        last_checked,
        latency_ms
      };
    }

    if (status === 402 || lowerText.includes('billing') || lowerText.includes('insufficient_quota') || lowerText.includes('insufficient quota') || lowerText.includes('credit') || lowerText.includes('payment') || lowerText.includes('quota') || lowerText.includes('suspended')) {
      return {
        provider: p.name,
        model: p.model,
        status: 'BILLING_BLOCKED',
        last_checked,
        latency_ms
      };
    }

    if (status === 429 || lowerText.includes('rate limit') || lowerText.includes('too many requests') || lowerText.includes('tpm') || lowerText.includes('rpm')) {
      return {
        provider: p.name,
        model: p.model,
        status: 'RATE_LIMITED',
        last_checked,
        latency_ms
      };
    }

    // Default to DEAD_401 for other 4xx errors, UNREACHABLE for 5xx
    if (status >= 500) {
      return {
        provider: p.name,
        model: p.model,
        status: 'UNREACHABLE',
        last_checked,
        latency_ms
      };
    }

    return {
      provider: p.name,
      model: p.model,
      status: 'DEAD_401',
      last_checked,
      latency_ms
    };

  } catch (err: any) {
    clearTimeout(timeoutId);
    const latency_ms = Date.now() - start;
    return {
      provider: p.name,
      model: p.model,
      status: 'UNREACHABLE',
      last_checked,
      latency_ms
    };
  }
}

export async function checkAllKeys(): Promise<KeyHealthRecord[]> {
  const records: KeyHealthRecord[] = [];

  for (const p of PROVIDER_CONFIGS) {
    // Check if key exists in env. Let's support GEMINI_API_KEY falling back to GOOGLE_API_KEY
    let apiKey = process.env[p.envKey] || '';
    if (p.name === 'gemini' && !apiKey) {
      apiKey = process.env.GOOGLE_API_KEY || '';
    }

    // We do the probe for every provider defined. If the key is not in process.env, it is empty and probeSingleKey handles it.
    const record = await probeSingleKey(p, apiKey);
    records.push(record);
  }

  return records;
}

export function getKeyHealth(provider: string, stalenessMinutes: number = 60): { status: string; last_checked: string } {
  try {
    if (!fs.existsSync(JSON_FILE_PATH)) {
      return { status: 'UNKNOWN — re-check needed', last_checked: '' };
    }

    const data = JSON.parse(fs.readFileSync(JSON_FILE_PATH, 'utf8'));
    const records: KeyHealthRecord[] = Array.isArray(data) ? data : (data.records || []);
    
    const record = records.find((r) => r.provider.toLowerCase() === provider.toLowerCase());
    if (!record) {
      return { status: 'UNKNOWN — re-check needed', last_checked: '' };
    }

    const lastCheckedTime = new Date(record.last_checked).getTime();
    if (isNaN(lastCheckedTime)) {
      return { status: 'UNKNOWN — re-check needed', last_checked: record.last_checked || '' };
    }

    const ageMs = Date.now() - lastCheckedTime;
    const stalenessMs = stalenessMinutes * 60 * 1000;

    if (ageMs > stalenessMs) {
      return { status: 'UNKNOWN — re-check needed', last_checked: record.last_checked };
    }

    return {
      status: record.status,
      last_checked: record.last_checked
    };
  } catch (e) {
    return { status: 'UNKNOWN — re-check needed', last_checked: '' };
  }
}
