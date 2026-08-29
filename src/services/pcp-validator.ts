import { db } from '../db';
import { logLlmCall } from '../billing/log-call';
import { calculateCost } from '../billing/pricing';
import crypto from 'crypto';

// Using global fetch

/**
 * The validator model, and why it is not a literal any more.
 *
 * `llama-3.3-70b-versatile` was hardcoded in four places. Groq decommissioned it,
 * and from 2026-08-17 every PCP call returned:
 *
 *     Groq HTTP 404: The model `llama-3.3-70b-versatile` does not exist or you do
 *     not have access to it.
 *
 * MEASURED in `llm_call_log` (task_hint='pcp_validation'): 39 successes, the last
 * at 2026-08-16 12:04:12 — the exact minute of the last contract that ever settled —
 * then 69 consecutive failures. Twelve daily living-proof runs escrowed real USDC
 * and minted nothing because of a model rename.
 *
 * The default below is EVIDENCE, not a guess: `openai/gpt-oss-20b` was observed
 * answering on this account's Groq key on 2026-08-29 via the live
 * POST /api/v1/hal/evaluate probe (verdict TRUE, confidence 95, 232ms).
 *
 * It is env-overridable so the NEXT deprecation is a variable change, not a deploy.
 * A provider retiring a model is routine; a hardcoded name turning it into twelve
 * days of silent economic damage is not.
 */
const PCP_MODEL = process.env['PCP_VALIDATOR_MODEL'] ?? 'openai/gpt-oss-20b';

export async function runPCP(taskData: any) {
  // 1. Select Validators
  const { data: agents, error } = await db
    .from('repid_agents')
    .select('id, agent_name, current_repid, lifecycle_status');

  if (error || !agents) {
    console.error('[runPCP] Failed to fetch agents:', error);
    return { score: 0, confidence: 0, validators: [] };
  }

  // Filter: exclude claimer, exclude repid < 500, exclude non-active lifecycle.
  //
  // The lifecycle filter is HYGIENE, NOT THE FIX, and the distinction matters:
  // `lifecycle_status` is a LABEL, and it is measurably unreliable here — 47 of the
  // 110 rows marked 'active' are mock/test agents by name (measured 2026-08-29), and
  // the mock buyers sit at repid 500-505, clearing the `>= 500` gate exactly. So this
  // line removes the 61 rows honest enough to admit what they are and nothing more.
  // The load-bearing fix is below: a validator that does not answer is NOT_CHECKED,
  // never a zero. Classify on evidence, never on the label (LESSONS #4).
  // `claimed_by` is compared against BOTH id and agent_name on purpose. Callers pass
  // whichever they hold — VerificationServiceHandler passes `contract.buyer_agent_id`,
  // a UUID, while its own comment says "excludes buyer from the validator pool". Against
  // a name-only comparison that never matched, so the buyer stayed eligible to validate
  // its own purchase. Self-validation is exactly what a peer-validation claim must not
  // permit, so the exclusion now covers both shapes.
  const claimer = taskData.claimed_by;
  const eligible = agents.filter(a =>
    a.agent_name !== claimer &&
    a.id !== claimer &&
    a.current_repid >= 500 &&
    (a.lifecycle_status ?? 'active') === 'active');

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
    const call_id = crypto.randomUUID();
    const t0 = Date.now();
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
          model: PCP_MODEL,
          messages: [{ role: 'user', content: prompt }],
          temperature: 0.1,
          response_format: { type: 'json_object' }
        })
      });
      
      const latency = Date.now() - t0;
      if (res.ok === false) {
        const body = await res.text().catch(() => '');
        throw new Error(`Groq HTTP ${res.status}: ${body}`);
      }
      
      const json = await res.json();
      const tokensIn = json.usage?.prompt_tokens || 0;
      const tokensOut = json.usage?.completion_tokens || 0;
      const cost_usd = calculateCost('groq', PCP_MODEL, tokensIn, tokensOut);
      
      logLlmCall({
        call_id,
        provider: 'groq',
        tier: '0a',
        model: PCP_MODEL,
        prompt_tokens: tokensIn,
        completion_tokens: tokensOut,
        cost_usd,
        latency_ms: latency,
        status: 'success',
        agent_id: agent.id,
        task_hint: 'pcp_validation'
      }).catch(err => console.error('[runPCP] logLlmCall error:', err));

      const content = json.choices?.[0]?.message?.content || '{}';
      let parsed;
      try {
        const jsonMatch = content.match(/\{[\s\S]*\}/);
        parsed = JSON.parse(jsonMatch ? jsonMatch[0] : content);
      } catch (e) {
        // Unparseable output is a validator that did not answer, not one that
        // answered "worthless". Marked NOT_CHECKED and dropped from the aggregate.
        return { name: agent.agent_name, validity: 0, confidence: 0, responded: false };
      }
      return {
        name: agent.agent_name,
        validity: Number(parsed.validity) || 0,
        confidence: Number(parsed.confidence) || 0,
        responded: true
      };
    } catch (e: any) {
      console.error(`[runPCP] Validator ${agent.agent_name} failed:`, e);
      logLlmCall({
        call_id,
        provider: 'groq',
        tier: '0a',
        model: PCP_MODEL,
        prompt_tokens: 0,
        completion_tokens: 0,
        cost_usd: 0,
        latency_ms: Date.now() - t0,
        status: 'failed',
        error_message: e.message || String(e),
        agent_id: agent.id,
        task_hint: 'pcp_validation'
      }).catch(err => console.error('[runPCP] logLlmCall error:', err));
      // An unreachable validator is NOT_CHECKED. Returning validity 0 here is what
      // charged providers for work nobody assessed: with all three validators erroring,
      // sumConfidence was 0, finalScore fell to 0, the handler read FAIL, and the
      // contract disputed as `provider_at_fault`. Measured: every daily living-proof
      // run from 2026-08-17 to 2026-08-28 died exactly this way.
      return { name: agent.agent_name, validity: 0, confidence: 0, responded: false };
    }
  }));

  // 3. Aggregate — OVER RESPONDERS ONLY.
  //
  // Averaging across non-responders silently converts "we could not check" into "it
  // scored zero". Dividing by `results.length` did exactly that to `confidence` even
  // when a responder existed, so one live validator beside two dead ones had its
  // confidence cut to a third.
  const responded = results.filter(r => r.responded);

  let sumWeightedValidity = 0;
  let sumConfidence = 0;
  for (const res of responded) {
    sumWeightedValidity += res.validity * res.confidence;
    sumConfidence += res.confidence;
  }

  // Quorum: at least one real verdict carrying real confidence. Below that there is
  // no measurement, and the caller MUST NOT read the result as a failing score —
  // `checked: false` is the signal to leave the contract alone and retry, never to
  // dispute it. Three outcomes, never two.
  const checked = responded.length > 0 && sumConfidence > 0;

  const finalScore = checked ? sumWeightedValidity / sumConfidence : 0;
  const avgConfidence = checked ? sumConfidence / responded.length : 0;

  if (!checked) {
    console.warn(
      `[runPCP] NOT_CHECKED: 0 of ${results.length} validator(s) answered ` +
      `(${results.map(r => r.name).join(', ')}). Returning checked:false — a score of 0 ` +
      `here would blame a provider for work nobody assessed.`
    );
  }

  return {
    score: finalScore,
    confidence: avgConfidence,
    checked,
    respondedCount: responded.length,
    attemptedCount: results.length,
    validators: responded.map(r => r.name),
    attemptedValidators: results.map(r => r.name),
    validatorBeliefs: responded.map(r => r.confidence)
  };
}

export function selectWeightedValidators(agents: any[], count: number) {
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
