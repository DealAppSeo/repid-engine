import { db } from '../db';
// Using global fetch

export async function runPCP(taskData: any) {
  // 1. Select Validators
  const { data: agents, error } = await db
    .from('repid_agents')
    .select('name, current_repid, metadata');

  if (error || !agents) {
    console.error('[runPCP] Failed to fetch agents:', error);
    return { score: 0, confidence: 0, validators: [] };
  }

  // Filter: exclude claimer, exclude repid < 500
  const eligible = agents.filter(a => a.name !== taskData.claimed_by && a.current_repid >= 500);

  // Random sample weighted by RepID. Diversity logic is a plus.
  const selectedValidators = selectWeightedValidators(eligible, 3);
  if (selectedValidators.length === 0) {
    console.log('[runPCP] No eligible validators found.');
    return { score: 0, confidence: 0, validators: [] };
  }

  // 2. Call LLMs
  const prompt = `You are a peer validator. Read the task and the claimer's output. Score on these axes:
- Validity (0-1): does the output actually accomplish the task?
- Confidence (0-1): how certain are you in your validity assessment?
- Justification (string): one paragraph explaining your reasoning

Output strictly as JSON: {"validity": 0.85, "confidence": 0.9, "justification": "..."}

TASK: ${taskData.title}
DESCRIPTION: ${taskData.description}
CLAIMER OUTPUT:
${taskData.result}`;

  const results = await Promise.all(selectedValidators.map(async (agent) => {
    try {
      // route to free tier logic
      const apiKey = process.env.GROQ_API_KEY;
      if (!apiKey) throw new Error('No GROQ_API_KEY');
      
      const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`
        },
        body: JSON.stringify({
          model: 'llama-3.3-70b-versatile',
          messages: [{ role: 'user', content: prompt }],
          temperature: 0.1,
          response_format: { type: 'json_object' }
        })
      });
      
      const json = await res.json();
      const content = json.choices?.[0]?.message?.content || '{}';
      let parsed;
      try {
        const jsonMatch = content.match(/\{[\s\S]*\}/);
        parsed = JSON.parse(jsonMatch ? jsonMatch[0] : content);
      } catch (e) {
        parsed = { validity: 0, confidence: 0 };
      }
      return {
        name: agent.name,
        validity: Number(parsed.validity) || 0,
        confidence: Number(parsed.confidence) || 0
      };
    } catch (e) {
      console.error(`[runPCP] Validator ${agent.name} failed:`, e);
      return { name: agent.name, validity: 0, confidence: 0 };
    }
  }));

  // 3. Aggregate
  let sumWeightedValidity = 0;
  let sumConfidence = 0;

  for (const res of results) {
    sumWeightedValidity += res.validity * res.confidence;
    sumConfidence += res.confidence;
  }

  const finalScore = sumConfidence > 0 ? sumWeightedValidity / sumConfidence : 0;
  const avgConfidence = results.length > 0 ? sumConfidence / results.length : 0;

  return {
    score: finalScore,
    confidence: avgConfidence,
    validators: results.map(r => r.name)
  };
}

function selectWeightedValidators(agents: any[], count: number) {
  const selected: any[] = [];
  const pool = [...agents];

  while (selected.length < count && pool.length > 0) {
    let totalWeight = pool.reduce((sum, a) => sum + (a.current_repid || 0), 0);
    let rand = Math.random() * totalWeight;
    
    for (let i = 0; i < pool.length; i++) {
      rand -= (pool[i].current_repid || 0);
      if (rand <= 0) {
        selected.push(pool[i]);
        pool.splice(i, 1);
        break;
      }
    }
  }
  return selected;
}
