import { db } from '../db';
// Using global fetch

export async function runAdversarialJudge(taskData: any) {
  // 1. Identify Claimer Provider
  let claimerProvider = 'unknown';
  if (taskData.metadata) {
    const meta = typeof taskData.metadata === 'string' ? JSON.parse(taskData.metadata) : taskData.metadata;
    claimerProvider = meta.provider || meta.provider_used || 'unknown';
  }

  // 2. Select Adversarial Provider
  let judgeProvider = 'anthropic';
  let model = 'claude-haiku-4-5-20251001';
  
  if (claimerProvider.toLowerCase() === 'anthropic') {
    judgeProvider = 'openai';
    model = 'gpt-4o-mini';
  }

  // 3. Prompt
  const prompt = `You are a critical adversarial judge. A subordinate agent has submitted the following task response.
Your goal is to actively find flaws, hallucinations, or unfulfilled requirements.

TASK: ${taskData.title}
DESCRIPTION: ${taskData.description}
AGENT OUTPUT:
${taskData.result}

Evaluate strictly. Output a JSON object with:
- verdict: "APPROVE", "CHALLENGE", or "ESCALATE"
- confidence: 0.0 to 1.0
- critique: one sentence reasoning

Output ONLY valid JSON.`;

  try {
    let resultJson = '{}';

    if (judgeProvider === 'anthropic') {
      const apiKey = process.env.ANTHROPIC_API_KEY;
      if (!apiKey) throw new Error('No ANTHROPIC_API_KEY');
      
      const res = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01'
        },
        body: JSON.stringify({
          model,
          max_tokens: 200,
          temperature: 0.1,
          system: "You are a critical adversarial judge.",
          messages: [{ role: 'user', content: prompt }]
        })
      });

      const json = await res.json();
      resultJson = json.content?.[0]?.text || '{}';
    } else {
      // OpenAI
      const apiKey = process.env.OPENAI_API_KEY;
      if (!apiKey) throw new Error('No OPENAI_API_KEY');
      
      const res = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`
        },
        body: JSON.stringify({
          model,
          messages: [{ role: 'user', content: prompt }],
          temperature: 0.1,
          response_format: { type: 'json_object' }
        })
      });

      const json = await res.json();
      resultJson = json.choices?.[0]?.message?.content || '{}';
    }

    let parsed;
    try {
      const jsonMatch = resultJson.match(/\{[\s\S]*\}/);
      parsed = JSON.parse(jsonMatch ? jsonMatch[0] : resultJson);
    } catch (e) {
      parsed = { verdict: 'ESCALATE', confidence: 0 };
    }

    return {
      verdict: parsed.verdict || 'ESCALATE',
      confidence: Number(parsed.confidence) || 0,
      critique: parsed.critique || 'Failed to parse'
    };
  } catch (err: any) {
    console.error(`[AdversarialJudge] Error with ${judgeProvider}:`, err.message);
    return { verdict: 'ESCALATE', confidence: 0, critique: err.message };
  }
}
