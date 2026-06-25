import 'dotenv/config';

interface Provider {
  name: string;
  url: string;
  headers: Record<string, string>;
  body: string;
}

const providers: Provider[] = [
  {
    name: 'anthropic',
    url: 'https://api.anthropic.com/v1/messages',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': process.env.ANTHROPIC_API_KEY || '',
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 10,
      messages: [{ role: 'user', content: 'Say OK' }]
    })
  },
  {
    name: 'openai',
    url: 'https://api.openai.com/v1/chat/completions',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${process.env.OPENAI_API_KEY || ''}`
    },
    body: JSON.stringify({
      model: 'gpt-4o-mini',
      max_tokens: 10,
      messages: [{ role: 'user', content: 'Say OK' }]
    })
  },
  {
    name: 'deepseek-chat',
    url: 'https://api.deepseek.com/v1/chat/completions',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${process.env.DEEPSEEK_API_KEY || ''}`
    },
    body: JSON.stringify({
      model: 'deepseek-chat',
      max_tokens: 10,
      messages: [{ role: 'user', content: 'Say OK' }]
    })
  },
  {
    name: 'groq',
    url: 'https://api.groq.com/openai/v1/chat/completions',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${process.env.GROQ_API_KEY || ''}`
    },
    body: JSON.stringify({
      model: 'llama-3.3-70b-versatile',
      max_tokens: 10,
      messages: [{ role: 'user', content: 'Say OK' }]
    })
  },
  {
    name: 'cerebras',
    url: 'https://api.cerebras.ai/v1/chat/completions',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${process.env.CEREBRAS_API_KEY || ''}`
    },
    body: JSON.stringify({
      model: 'gpt-oss-120b',
      max_tokens: 10,
      messages: [{ role: 'user', content: 'Say OK' }]
    })
  },
  {
    name: 'fireworks',
    url: 'https://api.fireworks.ai/inference/v1/chat/completions',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${process.env.FIREWORKS_API_KEY || ''}`
    },
    body: JSON.stringify({
      model: 'accounts/fireworks/models/llama-v3p1-8b-instruct',
      max_tokens: 10,
      messages: [{ role: 'user', content: 'Say OK' }]
    })
  }
];

async function testAll() {
  console.log('Testing provider keys from env...');
  for (const p of providers) {
    const start = Date.now();
    try {
      const res = await fetch(p.url, {
        method: 'POST',
        headers: p.headers,
        body: p.body
      });
      const elapsed = Date.now() - start;
      if (res.ok) {
        const json: any = await res.json();
        console.log(`[OK] ${p.name} responded successfully in ${elapsed}ms:`, JSON.stringify(json).slice(0, 150));
      } else {
        const text = await res.text();
        console.log(`[FAIL] ${p.name} status ${res.status} in ${elapsed}ms. Error: ${text.slice(0, 200)}`);
      }
    } catch (e: any) {
      console.log(`[ERROR] ${p.name} threw error: ${e.message}`);
    }
  }
}

testAll();
