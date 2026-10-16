import { db } from '../db';
import { logLlmCall } from '../billing/log-call';
import { calculateCost } from '../billing/pricing';
import crypto from 'crypto';
import { providerFetch } from '../egress/provider-fetch';
import { PROVIDER_URLS } from '../egress/provider-hosts';
import { resolveProviderEndpoint } from '../hal/local-llm';

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
    .select('id, agent_name, current_repid, lifecycle_status, is_human, builder_id, mock:constitution->mock');

  if (error || !agents) {
    return notChecked('validator_fetch_failed', `could not read repid_agents: ${error?.message ?? 'no rows returned'}`);
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
  const eligible = eligibleValidators(agents, taskData.claimed_by);

  // VALIDATOR_POOL_INTEGRITY (default OFF). OFF: the draw below is unchanged and one shadow line
  // names the drawn voters the rule would have excluded. ON: they are never drawn, and the result is
  // NOT_CHECKED (insufficient_independent_validators) when fewer than VALIDATOR_COUNT independent
  // validators are left to draw, or fewer than VALIDATOR_QUORUM of the drawn answer with confidence
  // (see the quorum below). So a VOTE needs 2 of 3 independent answers. A claim a caller can decide
  // without a vote (the verification handler's eth_chainId read) is still decided with zero voters.
  const flagged = poolIntegrityExclusions(eligible, agents, [taskData.claimed_by, ...(taskData.counterparties ?? [])]);
  const enforce = validatorPoolIntegrityEnabled();
  const pool = enforce ? eligible.filter((a) => !flagged.has(a)) : eligible;
  if (enforce && pool.length < VALIDATOR_COUNT) {
    return notChecked('insufficient_independent_validators',
      `${pool.length} independent validator(s), ${VALIDATOR_COUNT} required; excluded ` +
      [...flagged].map(([a, r]) => `${a.agent_name}:${r}`).join(', '));
  }

  // Random sample weighted by RepID. Diversity logic is a plus.
  const selectedValidators = selectWeightedValidators(pool, VALIDATOR_COUNT);
  if (selectedValidators.length === 0) {
    return notChecked('no_eligible_validators', `0 of ${agents.length} agent(s) are eligible validators`);
  }
  if (!enforce) {
    console.log(JSON.stringify({
      event: 'validator_pool_shadow',
      contract_id: taskData.contract_id ?? null,
      excluded: selectedValidators.filter((a) => flagged.has(a)).map((a) => ({ agent: a.agent_name, reason: flagged.get(a) })),
      // < VALIDATOR_COUNT means turning the flag on would leave this check NOT_CHECKED.
      independent_pool: eligible.length - flagged.size,
    }));
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
      
      const endpoint = resolveProviderEndpoint(
        PROVIDER_URLS.groqChatCompletions,
        process.env.LOCAL_LLM_BASE_URL || process.env.OPENAI_BASE_URL || '',
        'openai-compat',
      );
      const res = await providerFetch(endpoint, {
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
    console.error(
      `[runPCP] ✗ NOT_CHECKED (no_validator_answered): 0 of ${results.length} validator(s) answered ` +
      `(${results.map(r => r.name).join(', ')}). Returning checked:false — a score of 0 ` +
      `here would blame a provider for work nobody assessed.`
    );
  }

  // Quorum, flag ON only: one confident voter beside two silent ones is not a panel. No answer at
  // all keeps its own reason above (no_validator_answered: retry); one answer is not enough to decide.
  const answered = responded.filter((r) => r.confidence > 0).length;
  if (enforce && checked && answered < VALIDATOR_QUORUM) {
    return notChecked('insufficient_independent_validators',
      `${answered} of ${results.length} independent validator(s) answered with confidence, ${VALIDATOR_QUORUM} required`, {
        respondedCount: responded.length, attemptedCount: results.length,
        validators: responded.map(r => r.name), attemptedValidators: results.map(r => r.name), validatorBeliefs: responded.map(r => r.confidence),
      });
  }

  return {
    score: finalScore,
    confidence: avgConfidence,
    checked,
    ...(checked ? {} : { reason: 'no_validator_answered' as const }),
    respondedCount: responded.length,
    attemptedCount: results.length,
    validators: responded.map(r => r.name),
    attemptedValidators: results.map(r => r.name),
    validatorBeliefs: responded.map(r => r.confidence)
  };
}

/**
 * Who may be named as a PCP validator. Every "validator" is the same PCP_MODEL call with the same
 * prompt; the agent drawn here is the name the verdict is recorded under and the agent that earns
 * VALIDATOR_REWARD. So a row that cannot have made that call must not be drawn:
 *   - is_human: a person did not give this LLM verdict, and must not be recorded or paid as if they had.
 *   - constitution.mock === true: written by scripts/mock-harness/mock-agent.ts, the harness's own
 *     mark (evidence, not a name guess). Measured 2026-10-15: 47 such rows sat 'active' at repid
 *     500-545, and two were paid VALIDATOR_REWARD (+40) for validations they never ran.
 * Plus the original rules: not the claimer (by id or name), repid >= 500, lifecycle 'active'.
 */
export function eligibleValidators(agents: any[], claimer: unknown): any[] {
  return agents.filter((a) =>
    a.agent_name !== claimer &&
    a.id !== claimer &&
    a.current_repid >= 500 &&
    // Exactly 'active'. test_only / deprecated / archived are out, and so is a missing value: the
    // column is nullable, and a row nobody labelled is not one anybody vouched for (XC1 on #1396).
    a.lifecycle_status === 'active' &&
    a.is_human !== true &&
    a.mock !== true && a.mock !== 'true' &&
    // The harness's other mark, which it enforces (MockAgent throws without it) and so cannot omit
    // the way it can omit the JSON flag: names start 'mock-', stored as 'trinity-mock-' by
    // trg_normalize_repid_agent_name. Measured 2026-10-15: 49 such rows, all also JSON-marked.
    !MOCK_HARNESS_NAME.test(String(a.agent_name ?? '')));
}

const MOCK_HARNESS_NAME = /^(trinity-)?mock-/;

const VALIDATOR_COUNT = 3;
const VALIDATOR_QUORUM = 2; // flag ON only

/** Default OFF. Strict 'true', like every gate in this engine (config/flag-readiness.ts). */
export const validatorPoolIntegrityEnabled = () => process.env.VALIDATOR_POOL_INTEGRITY === 'true';

// ponytail: STOPGAP. repid_agents has no test-agent column, so this is a name pattern, matched as a
// whole token so 'attestor' and 'mockingbird' stay in. Measured 2026-10-16 it catches the 3
// redteam-synth rows (scripts/redteam/synthetic-round.ts inserted them active at repid 600, no
// marker), trinity-t12-e2e and trinity-dry_run_agent_*. Replace with an is_test_agent column.
const TEST_AGENT_NAME = /(^|[-_.])(mock|synth|fixture|redteam|red-team|dummy|test|e2e|dry[-_]?run)([-_.0-9]|$)/i;

export type PoolExclusionReason = 'test_agent_name' | 'counterparty' | 'same_builder';

/**
 * Which eligible validators are not independent of the work they would judge. Pure; decides nothing.
 *   test_agent_name  a fixture by name (stopgap above). A fixture's vote is not a peer's vote.
 *   counterparty     a party itself (the provider, on a contract): judging its own deliverable.
 *   same_builder     shares repid_agents.builder_id with a party. MINIMAL owner check: the unsigned
 *                    FK only, and a null builder_id is never "same". PR #1429's resolver
 *                    (owner-distinct-shadow.ts: signed bindings, delegations) should replace it.
 * `parties` are ids or names (callers pass either), e.g. [buyer_agent_id, provider_agent_id].
 */
export function poolIntegrityExclusions(eligible: any[], agents: any[], parties: unknown[]): Map<any, PoolExclusionReason> {
  const ps = parties.filter((p) => p !== null && p !== undefined && p !== '');
  const partyRows = agents.filter((a) => ps.includes(a.id) || ps.includes(a.agent_name));
  const partyBuilders = new Set(partyRows.map((a) => a.builder_id).filter(Boolean));
  const out = new Map<any, PoolExclusionReason>();
  for (const a of eligible) {
    const reason: PoolExclusionReason | null =
      TEST_AGENT_NAME.test(String(a.agent_name ?? '')) ? 'test_agent_name'
      : partyRows.includes(a) ? 'counterparty'
      : a.builder_id && partyBuilders.has(a.builder_id) ? 'same_builder'
      : null;
    if (reason) out.set(a, reason);
  }
  return out;
}

/** PCP's verdict, with no validator having assessed anything. Callers must retry, never score it. */
type NotCheckedReason = 'validator_fetch_failed' | 'no_eligible_validators' | 'no_validator_answered' | 'insufficient_independent_validators';
function notChecked(
  reason: NotCheckedReason, detail: string,
  // Who was asked and who answered, when some did but too few to decide (the flag-ON quorum).
  seen: { respondedCount?: number; attemptedCount?: number; validators?: string[]; attemptedValidators?: string[]; validatorBeliefs?: number[] } = {},
) {
  // Loud: an unchecked task stalls a contract until someone looks, and a quiet log line is how it
  // sat unnoticed before (validation queue, 2026-09-10 to 2026-10-15).
  console.error(`[runPCP] ✗ NOT_CHECKED (${reason}): ${detail}. Returning checked:false — ` +
    (seen.respondedCount ? 'too few independent answers to decide.' : 'no validator assessed this task.'));
  return {
    score: 0, confidence: 0, checked: false as const, reason,
    respondedCount: 0, attemptedCount: 0, validators: [] as string[], attemptedValidators: [] as string[], validatorBeliefs: [] as number[],
    ...seen,
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
