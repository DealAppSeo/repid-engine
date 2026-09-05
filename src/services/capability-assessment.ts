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

/**
 * Ask the agent a probe question.
 *
 * Returns `null` when the probe COULD NOT RUN — no adapter, no API key, or the
 * completion threw. `null` is not an answer and must never be graded.
 *
 * IT USED TO RETURN PROSE FOR ALL THREE, AND THE PROSE WAS GRADED. The strings
 * were `'Failed to route request'`, `'No API key configured'` and `''`, handed
 * straight to `evaluateResponse`. For an `expected: false` probe that function
 * answers "correct" when the response contains "no" — and
 * `'No API key configured'.toLowerCase()` contains "no", so a MISSING API KEY
 * scored as a correct answer. `''` failed every probe, so a provider outage read
 * as an agent that had forgotten how to think.
 *
 * Neither is a capability measurement. `runResumeChecks` turns these into a pass
 * rate that gates `repid_agents.lifecycle_status`, and writes that rate into a
 * learning event as a fact.
 *
 * Blast radius today is smaller than that sounds, and the reason is an accident
 * rather than a guard: only 1 of the 9 declared probes is `expected: false`, so
 * the fabricated pass cannot on its own reach the 0.8 resume threshold. Add a
 * second such probe and it can. The grading was wrong either way, so it is fixed
 * at the source rather than left resting on the test mix.
 */
export async function sendToAgent(agentName: string, prompt: string, capability: string): Promise<string | null> {
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
    console.warn(`[CapabilityAssessment] NOT_CHECKED for ${agentName}: no adapter could be routed.`);
    return null;
  }

  const apiKey = process.env[`${adapter.name.toUpperCase()}_API_KEY`] || process.env.OPENAI_API_KEY || '';
  if (!apiKey) {
    console.warn(`[CapabilityAssessment] NOT_CHECKED for ${agentName}: no API key for ${adapter.name}.`);
    return null;
  }

  try {
    const comp = await adapter.complete({
      prompt: systemPrompt,
      apiKey,
    });
    return comp.answer;
  } catch (err: any) {
    console.error(`[CapabilityAssessment] NOT_CHECKED for ${agentName}: completion threw:`, err.message);
    return null;
  }
}

export async function assessAgentCapabilities(agentName: string): Promise<Record<string, { passed: number; total: number }>> {
  const results: Record<string, { passed: number; total: number }> = {};

  console.log(`[CapabilityAssessment] Assessing capabilities for agent ${agentName}...`);

  for (const [capability, tests] of Object.entries(CAPABILITY_TESTS)) {
    let passed = 0;
    for (const test of tests) {
      const response = await sendToAgent(agentName, test.prompt, capability);
      // NOT_CHECKED. Same rule as `runResumeChecks`: a probe that could not run
      // is not a wrong answer, and a `{passed, total}` built partly from probes
      // that never reached a provider would be written to
      // `repid_agents.capabilities` as a measurement. Abort without writing —
      // no row beats a fabricated one.
      if (response === null) {
        console.warn(
          `[CapabilityAssessment] NOT_CHECKED for ${agentName} on '${capability}' — a probe ` +
            `could not run. Writing NOTHING; capabilities left as they were.`
        );
        return {};
      }
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
