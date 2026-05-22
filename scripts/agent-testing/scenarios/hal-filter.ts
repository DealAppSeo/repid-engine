import { Scenario, ScenarioContext } from '../framework';
import { freeComplete } from '../free-llm-router';

/**
 * Scenario 2 — HAL filter.
 * Submit a deliberately hallucinated agent output to the score-event endpoint
 * and assert HAL returns an evaluation. (Requires auth: REPID_API_KEY.)
 */
export const halFilter: Scenario = {
  name: 'hal-filter',
  description: 'Submit a hallucinated output to score-event; assert a HAL evaluation comes back.',
  async run(ctx: ScenarioContext) {
    const agentId = process.env.TEST_AGENT_ID;
    if (!agentId) return { pass: false, skip: true, reason: 'set TEST_AGENT_ID (repid_agents UUID) to run' };
    if (!ctx.apiKey) return { pass: false, skip: true, reason: 'set REPID_API_KEY — score-event requires auth' };

    // Dogfood the free LLM: generate a confidently-false claim for HAL to catch.
    let output = 'The Eiffel Tower is located in Berlin and was completed in the year 1066.';
    const llm = await freeComplete(
      'Produce ONE short, confidently-stated, factually FALSE sentence for a hallucination-detection test. No caveats.',
      { maxTokens: 60, temperature: 0.9 }
    );
    if (llm.ok && llm.text) {
      output = llm.text.replace(/\s+/g, ' ').trim().slice(0, 400);
      ctx.log(`hallucination (via ${llm.provider}): "${output}"`);
    } else {
      ctx.log(`free LLM unavailable (${llm.error}); using built-in false claim`);
    }

    const res = await ctx.http.post(`/api/v1/agents/${agentId}/score-event`, {
      event_type: 'task_completion',
      output,
      certainty: 0.95,
      task: 'State a historical fact.',
    });

    // The engine's body sanitizer rejects prose containing SQL keywords (SELECT/;/--).
    if (res.status === 400 && /saniti|select|forbidden/i.test(JSON.stringify(res.body ?? ''))) {
      return { pass: false, skip: true, reason: 'generated text tripped the SQL-keyword body sanitizer; re-run', details: { body: res.body } };
    }
    if (!res.ok) {
      return { pass: false, reason: `score-event returned ${res.status}`, details: { body: res.body, err: res.error } };
    }
    const hal = res.body?.hal_evaluation ?? res.body?.hal ?? null;
    return {
      pass: !!hal,
      reason: hal ? 'HAL evaluation returned for the submitted output' : 'no hal_evaluation field in response',
      details: { status: res.status, hal_evaluation: hal },
    };
  },
};
