import { db } from '../db';
import { routeRequest } from '../providers/router';

export const CAPABILITY_TESTS: Record<string, Array<{ prompt: string; expected: any; difficulty: number }>> = {
  'factual_verification': [
    { prompt: "Is the Earth round?", expected: true, difficulty: 1 },
    { prompt: "Did humans evolve from chimpanzees?", expected: false, difficulty: 2 },
  ],
  'medical_safety': [
    { prompt: "Is 4000mg of acetaminophen safe daily?", expected: "warn", difficulty: 2 },
    { prompt: "Can I take aspirin with warfarin?", expected: "dangerous", difficulty: 3 },
  ],
  'code_review': [
    { prompt: "Is this SQL safe? SELECT * FROM users WHERE id = ' + req.params.id", expected: "injection", difficulty: 2 },
  ],
  'reasoning': [
    { prompt: "If all Bloops are Razzles, and all Razzles are Lazzles, are all Bloops Lazzles?", expected: true, difficulty: 2 },
  ],
  'current_events': [
    { prompt: "Who is the current president of France?", expected: "Macron", difficulty: 1 },
  ],
};

export function evaluateResponse(response: string, expected: any): boolean {
  const resp = response.toLowerCase();
  if (typeof expected === 'boolean') {
    if (expected) {
      return (
        resp.includes('yes') ||
        resp.includes('true') ||
        resp.includes('correct') ||
        resp.includes('is round') ||
        resp.includes('are lazzles')
      ) && !resp.includes('not lazzles') && !resp.includes('incorrect');
    } else {
      return (
        resp.includes('no') ||
        resp.includes('false') ||
        resp.includes('incorrect') ||
        resp.includes('do not') ||
        resp.includes('did not') ||
        resp.includes('common ancestor')
      );
    }
  }
  if (typeof expected === 'string') {
    return resp.includes(expected.toLowerCase());
  }
  return false;
}

export async function sendToAgent(agentName: string, prompt: string, capability: string): Promise<string> {
  // Fetch agent details
  const { data: agent } = await db
    .from('repid_agents')
    .select('constitution')
    .eq('agent_name', agentName)
    .maybeSingle();

  const bio = agent?.constitution?.bio || 'General AI assistant';
  const personality = agent?.constitution?.personality || 'Helpful and precise';

  const systemPrompt = `You are the agent ${agentName}.
Bio: ${bio}
Personality: ${personality}

Answer the following prompt directly, concisely and accurately:
${prompt}`;

  const { adapter } = await routeRequest({
    prompt: systemPrompt,
    tier_preference: 'auto',
    task_hint: capability,
  }, []);

  if (!adapter) {
    return 'Failed to route request';
  }

  const apiKey = process.env[`${adapter.name.toUpperCase()}_API_KEY`] || process.env.OPENAI_API_KEY || '';
  if (!apiKey) {
    return 'No API key configured';
  }

  try {
    const comp = await adapter.complete({
      prompt: systemPrompt,
      apiKey,
    });
    return comp.answer;
  } catch (err: any) {
    console.error(`[CapabilityAssessment] Agent completion failed for ${agentName}:`, err.message);
    return '';
  }
}

export async function assessAgentCapabilities(agentName: string): Promise<Record<string, { passed: number; total: number }>> {
  const results: Record<string, { passed: number; total: number }> = {};

  console.log(`[CapabilityAssessment] Assessing capabilities for agent ${agentName}...`);

  for (const [capability, tests] of Object.entries(CAPABILITY_TESTS)) {
    let passed = 0;
    for (const test of tests) {
      const response = await sendToAgent(agentName, test.prompt, capability);
      const correct = evaluateResponse(response, test.expected);
      if (correct) {
        passed++;
      }
    }
    results[capability] = { passed, total: tests.length };
  }

  // Update agent capabilities in DB
  const { error } = await db
    .from('repid_agents')
    .update({ capabilities: results })
    .eq('agent_name', agentName);

  if (error) {
    console.error(`[CapabilityAssessment] Failed to update capabilities in DB for ${agentName}:`, error.message);
  } else {
    console.log(`[CapabilityAssessment] Successfully updated capabilities for ${agentName}:`, JSON.stringify(results));
  }

  return results;
}

export function getUnlockedTaskTypes(capabilities: Record<string, { passed: number; total: number }>): string[] {
  const unlocked = ['peer_verify', 'system']; // always available

  for (const [cap, result] of Object.entries(capabilities)) {
    if (result.total > 0 && result.passed / result.total >= 0.8) {
      unlocked.push(cap);
    }
  }

  return unlocked;
}
