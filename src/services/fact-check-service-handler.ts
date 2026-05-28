import { ServiceHandlerBase } from './service-handler-base';
import { selectWeightedValidators } from './pcp-validator';
import { db } from '../db';
import type { ServiceContractRow } from '../types';

/**
 * Fact-Check Service Handler — new service_type='fact_check'.
 *
 * Distinct from `verification` (general task-accomplishment grading via PCP)
 * and `cross_validation` (PCP+adversarial-judge+Pythagorean-Comma BFT veto).
 * Where those handlers ask "did the claimer accomplish the task?" or "is the
 * peer-validator panel in sufficient agreement?", this handler asks the much
 * narrower question the prompt is tailored to:
 *
 *     Is this factual claim TRUE, FALSE, or AMBIGUOUS?
 *
 * That distinction is in the prompt — not a rebrand of an existing handler.
 *
 * EXISTING PATH REUSED
 * --------------------
 *  - selectWeightedValidators (exported from pcp-validator.ts) for the
 *    eligible-agent pool. We exclude the buyer and require RepID ≥ 500,
 *    same gating runPCP uses.
 *  - Groq's `llama-3.3-70b-versatile` via GROQ_API_KEY, same model and
 *    auth pattern runPCP uses. So this handler exercises the same alive
 *    cross-LLM scoring pipeline Strategy confirmed (248 enqueued/hr,
 *    200 done/hr) — not a parallel substitute.
 *
 * VERDICT MAPPING
 * ---------------
 * The handler returns TWO verdicts:
 *
 *  - `verdict`   — contract-lifecycle verdict consumed by ServiceHandlerBase.
 *                  PASS when ≥1 validator returned a parseable answer, FAIL
 *                  otherwise. Never VETO (this handler does not run BFT and
 *                  must not collide with GA's verdict-close work).
 *
 *  - `fact_verdict` — the actual fact-check answer: TRUE | FALSE | AMBIGUOUS.
 *                     This is the buyer-facing result. A FALSE answer is still
 *                     a successfully delivered service, so the contract still
 *                     fulfils — the buyer paid to LEARN whether the claim is
 *                     true, and the answer "no, it's false" is the service.
 *
 * GA COORDINATION
 * ---------------
 * GA is fixing a verdict-close bug in the queue-verdict-close path. This
 * handler:
 *   - DOES NOT touch ServiceHandlerBase
 *   - DOES NOT touch the validation_queue close path
 *   - DOES NOT use the comma BFT layer (no VETO emission possible from here)
 * It only adds a new file and two registration lines.
 *
 * PATENT MARKER
 * -------------
 * Intentionally omitted. P-001/P-002/P-003 are in use; assigning a new tag
 * is Sean's call, not the handler author's.
 */

interface FactCheckPayload {
  /** The factual claim to evaluate. Required. */
  claim: string;
  /** Optional context that bounds interpretation (e.g. "as of 2026"). */
  context?: string;
  /** Optional buyer-facing title for the contract. */
  title?: string;
}

interface ValidatorVote {
  agent_name: string;
  fact_verdict: 'TRUE' | 'FALSE' | 'AMBIGUOUS' | 'ERROR';
  confidence: number;
  evidence: string;
}

const FACT_CHECK_PROMPT = (claim: string, context?: string) =>
  `You are a careful, evidence-driven fact-checker. Read the factual claim and answer ONLY about its truth value — not about how interesting or well-phrased it is.

Return strict JSON:
{
  "fact_verdict": "TRUE" | "FALSE" | "AMBIGUOUS",
  "confidence": <number 0..1>,
  "evidence": "<one paragraph: cite specific reasoning. If AMBIGUOUS, name the specific ambiguity (definitional, temporal, jurisdictional, contested, or undecided).>"
}

Pick TRUE only if widely accepted, well-established knowledge supports the claim. Pick FALSE only if widely accepted knowledge contradicts it. Pick AMBIGUOUS for contested claims, claims dependent on definition / time / jurisdiction, or claims you cannot evaluate with confidence. Do not guess.

${context ? `CONTEXT: ${context}\n` : ''}CLAIM: ${claim}`;

export class FactCheckServiceHandler extends ServiceHandlerBase {
  protected readonly serviceType = 'fact_check';

  protected async fulfill(contract: ServiceContractRow): Promise<Record<string, unknown>> {
    const payload = contract.payload as FactCheckPayload;

    if (!payload?.claim || typeof payload.claim !== 'string') {
      throw new Error('fact_check payload must include a non-empty string `claim`');
    }
    // Cap claim length to a sane bound; an LLM context blow-up is a service
    // failure that should surface as a clear error, not a silent truncation.
    if (payload.claim.length > 8000) {
      throw new Error(`fact_check claim too long (${payload.claim.length} chars; max 8000)`);
    }

    // 1. Select validators — same eligibility runPCP uses (RepID ≥ 500,
    //    excludes the buyer). We do the pool query inline rather than going
    //    through runPCP because runPCP carries a task-accomplishment prompt
    //    that does not fit fact-checking.
    const { data: agents, error: agentsErr } = await db
      .from('repid_agents')
      .select('id, agent_name, current_repid');

    if (agentsErr || !agents) {
      console.error(
        '[fact_check] validator pool fetch failed:',
        agentsErr?.message ?? agentsErr,
        (agentsErr as any)?.stack ?? new Error().stack
      );
      throw new Error(`validator pool fetch failed: ${agentsErr?.message ?? 'unknown'}`);
    }

    // Filter by id (UUID) — buyer_agent_id is a UUID, not an agent_name,
    // so comparing those would never exclude the buyer. Also exclude the
    // provider so a provider cannot validate its own work.
    const eligible = (agents as any[]).filter(
      (a) =>
        a.id !== contract.buyer_agent_id &&
        a.id !== contract.provider_agent_id &&
        (a.current_repid ?? 0) >= 500
    );
    const validators = selectWeightedValidators(eligible, 3);

    if (validators.length === 0) {
      // No eligible validators — service cannot be performed. FAIL routes to
      // the dispute panel via ServiceHandlerBase rather than silently
      // fulfilling with zero evidence.
      return {
        verdict: 'FAIL',
        fact_verdict: null,
        score: 0,
        confidence: 0,
        validators: [],
        evidence_note: 'No eligible validators available (RepID ≥ 500 requirement).',
        contract_id: contract.id,
        verified_at: new Date().toISOString(),
      };
    }

    // 2. Call LLMs in parallel — same model + endpoint as runPCP.
    const apiKey = process.env.GROQ_API_KEY;
    if (!apiKey) {
      // We do NOT fall back to a canned answer here — that would violate the
      // sprint's explicit "no stub" constraint. Surface the failure honestly.
      throw new Error('GROQ_API_KEY not set; fact-check requires a live LLM provider');
    }

    const prompt = FACT_CHECK_PROMPT(payload.claim, payload.context);

    const votes: ValidatorVote[] = await Promise.all(
      validators.map(async (v: any): Promise<ValidatorVote> => {
        try {
          const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Authorization: `Bearer ${apiKey}`,
            },
            body: JSON.stringify({
              model: 'llama-3.3-70b-versatile',
              messages: [{ role: 'user', content: prompt }],
              temperature: 0.1,
              response_format: { type: 'json_object' },
            }),
          });

          const json: any = await res.json();
          const content = json?.choices?.[0]?.message?.content ?? '{}';
          // Defensive parse — same pattern runPCP uses.
          let parsed: any;
          try {
            const m = content.match(/\{[\s\S]*\}/);
            parsed = JSON.parse(m ? m[0] : content);
          } catch {
            parsed = {};
          }

          const rawVerdict = String(parsed.fact_verdict ?? '').toUpperCase();
          const fact_verdict: ValidatorVote['fact_verdict'] =
            rawVerdict === 'TRUE' || rawVerdict === 'FALSE' || rawVerdict === 'AMBIGUOUS'
              ? (rawVerdict as 'TRUE' | 'FALSE' | 'AMBIGUOUS')
              : 'ERROR';

          const confidence = Number.isFinite(Number(parsed.confidence))
            ? Math.max(0, Math.min(1, Number(parsed.confidence)))
            : 0;

          const evidence =
            typeof parsed.evidence === 'string' && parsed.evidence.length > 0
              ? parsed.evidence
              : '(no evidence returned)';

          return { agent_name: v.agent_name, fact_verdict, confidence, evidence };
        } catch (e: any) {
          console.error(`[fact_check] validator ${v.agent_name} failed:`, e?.message ?? e);
          return {
            agent_name: v.agent_name,
            fact_verdict: 'ERROR',
            confidence: 0,
            evidence: `validator call failed: ${e?.message ?? String(e)}`,
          };
        }
      })
    );

    // 3. Aggregate.
    //    - Majority vote on fact_verdict (ignoring ERROR votes).
    //    - On tie or no live votes, return AMBIGUOUS rather than guessing.
    //    - Score = max-vote share among the three real labels (TRUE/FALSE/AMBIGUOUS),
    //      computed against the LIVE vote count so a single ERROR doesn't drag
    //      a clean consensus down.
    //    - Confidence = mean confidence across live votes.
    const liveVotes = votes.filter((v) => v.fact_verdict !== 'ERROR');
    const tallies = { TRUE: 0, FALSE: 0, AMBIGUOUS: 0 } as Record<string, number>;
    for (const v of liveVotes) tallies[v.fact_verdict] = (tallies[v.fact_verdict] ?? 0) + 1;

    let fact_verdict: 'TRUE' | 'FALSE' | 'AMBIGUOUS' | null = null;
    let score = 0;
    if (liveVotes.length > 0) {
      const max = Math.max(tallies.TRUE!, tallies.FALSE!, tallies.AMBIGUOUS!);
      const winners = (['TRUE', 'FALSE', 'AMBIGUOUS'] as const).filter(
        (k) => tallies[k] === max
      );
      // Tie-break: a tie between TRUE and FALSE collapses to AMBIGUOUS (we
      // refuse to flip a coin on a factual question). A tie involving
      // AMBIGUOUS resolves to AMBIGUOUS for the same reason.
      fact_verdict = winners.length === 1 ? winners[0]! : 'AMBIGUOUS';
      score = max / liveVotes.length;
    }

    const meanConfidence =
      liveVotes.length > 0
        ? liveVotes.reduce((s, v) => s + v.confidence, 0) / liveVotes.length
        : 0;

    const evidence_note = votes
      .map((v) => `${v.agent_name} [${v.fact_verdict} @${v.confidence.toFixed(2)}]: ${v.evidence}`)
      .join('\n\n');

    // Contract-lifecycle verdict: the SERVICE was performed if at least one
    // validator returned a parseable answer. The buyer asked for a
    // fact-check; we returned one. Whether the claim itself is TRUE/FALSE/
    // AMBIGUOUS is `fact_verdict`, not `verdict`.
    const verdict = liveVotes.length > 0 ? 'PASS' : 'FAIL';

    return {
      verdict,
      fact_verdict,
      score,
      confidence: meanConfidence,
      validators: votes.map((v) => v.agent_name),
      validator_count: votes.length,
      live_validator_count: liveVotes.length,
      tallies,
      evidence_note,
      contract_id: contract.id,
      verified_at: new Date().toISOString(),
    };
  }
}
