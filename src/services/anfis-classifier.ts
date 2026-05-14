import crypto from 'crypto';

const GROQ_API_KEY = process.env.GROQ_API_KEY || '';

interface Classification {
  provider: string;
  confidence: number; // 0.0 to 1.0
  reasoning: string;
  category: string;
}

// In-memory cache (10-min TTL)
const cache = new Map<string, { value: Classification; expiresAt: number }>();

const SYSTEM_PROMPT = `You are an ANFIS (Adaptive Neuro-Fuzzy Inference System) prompt classifier. Classify the user's prompt into exactly ONE category and recommend an LLM provider.

Categories and providers:
- coding_task → deepseek
- math_reasoning → deepseek
- emotional_support → anthropic
- creative_task → gemini
- fast_factual → cerebras
- complex_analysis → anthropic

Respond ONLY with JSON in this exact format:
{"category": "...", "provider": "...", "confidence": 0.95, "reasoning": "..."}

No other text.`;

export async function classifyPrompt(prompt: string): Promise<Classification> {
  const hash = crypto.createHash('sha256').update(prompt).digest('hex').substring(0, 16);
  const cached = cache.get(hash);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.value;
  }
  
  try {
    if (!GROQ_API_KEY) {
      throw new Error('GROQ_API_KEY not configured');
    }
    
    const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${GROQ_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: 'llama-3.1-8b-instant',
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: prompt }
        ],
        max_tokens: 200,
        temperature: 0.1,
        response_format: { type: 'json_object' }
      })
    });
    
    if (!response.ok) {
      throw new Error(`Groq API returned ${response.status}`);
    }
    
    const resData: any = await response.json();
    const content = resData.choices[0]?.message?.content || '{}';
    const parsed = JSON.parse(content);
    
    const result: Classification = {
      provider: parsed.provider || 'cerebras',
      confidence: parsed.confidence || 0.7,
      reasoning: parsed.reasoning || 'default classification',
      category: parsed.category || 'fast_factual'
    };
    
    cache.set(hash, { value: result, expiresAt: Date.now() + 10 * 60 * 1000 });
    return result;
  } catch (e: any) {
    console.warn('[anfis-classifier] Fallback to heuristic:', e.message);
    // Fallback to old heuristic if API fails
    return classifyHeuristic(prompt);
  }
}

function classifyHeuristic(payload: string): Classification {
  // Same as current mock logic in x402-inbound.ts
  if (payload.includes('code')) return { provider: 'deepseek', confidence: 0.6, reasoning: 'coding heuristic', category: 'coding_task' };
  if (payload.includes('math')) return { provider: 'deepseek', confidence: 0.6, reasoning: 'math heuristic', category: 'math_reasoning' };
  if (payload.includes('emotional')) return { provider: 'anthropic', confidence: 0.6, reasoning: 'emotional heuristic', category: 'emotional_support' };
  if (payload.includes('creative')) return { provider: 'gemini', confidence: 0.6, reasoning: 'creative heuristic', category: 'creative_task' };
  return { provider: 'cerebras', confidence: 0.5, reasoning: 'default heuristic', category: 'fast_factual' };
}
