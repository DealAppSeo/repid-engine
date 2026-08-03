/**
 * openai-compat.ts — be a drop-in OpenAI endpoint that adds verification.
 *
 * THE DISTRIBUTION PROBLEM THIS SOLVES. Our broker takes `{ prompt: string }`.
 * Every tool in the ecosystem speaks `{ model, messages: [...] }` — Odysseus (84.6k
 * stars), Open WebUI, Cursor, Continue, LangChain, LiteLLM, and the official OpenAI
 * SDKs. None of them can point at us today, no matter how good the trust layer is.
 *
 * That is a one-adapter problem, not a product problem. With this route, any of
 * those tools can change one base URL and get HAL scoring, provider-family
 * resolution and a receipt — with zero code change on their side.
 *
 * WHY THIS IS THE RIGHT DIRECTION OF INTEGRATION. The OmniRoute plan has us
 * CONSUME a gateway. This has us BE one. Consuming adds a dependency and hides the
 * provider behind someone else's routing; being one means every existing OpenAI
 * client becomes a potential TrustShell user, and the trust layer is the thing they
 * cannot get anywhere else. Both can be true at once — OmniRoute behind us, clients
 * in front — but only this direction acquires users.
 *
 * DROP-IN MEANS DROP-IN. The response body is exactly OpenAI's shape. Anything we
 * add rides in headers, because a client that strictly types the response must not
 * break:
 *
 *   X-HyperDAG-Verdict         clean | flagged | vetoed | unscored
 *   X-HyperDAG-HAL-Score       0..1, when scored
 *   X-HyperDAG-Provider        who actually served it
 *   X-HyperDAG-Family          resolved model family, or 'unverified'
 *   X-HyperDAG-Cost-USD        what it cost us
 *   X-HyperDAG-Receipt         URL, when the call produced one
 *
 * Callers who WANT the extra data in the body opt in with `hyperdag: { verbose: true }`,
 * which is ignored by every other OpenAI implementation.
 *
 * NO DUPLICATED ROUTING. This delegates to the existing broker rather than
 * re-implementing provider selection, key resolution, health marking, cost
 * accounting and the T0.5 gate. Those live in one place and a second copy would
 * drift — the same reason the manifest and the badge share buildProviderTrust. The
 * cost is one in-process hop; the alternative is two routers that disagree about
 * which provider is healthy.
 *
 * FLAG: OPENAI_COMPAT_ENABLED (default OFF).
 */

import { Router, Request, Response } from 'express';
import { resolveFamily } from '../../decisioning/family-registry';

export const openaiCompatRouter = Router();

export const OPENAI_COMPAT_ENABLED = process.env.OPENAI_COMPAT_ENABLED === 'true';

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | string;
  content: string;
}

/**
 * Flatten an OpenAI message array into the single prompt the broker takes.
 *
 * Roles are labelled rather than concatenated blindly: a model that receives a
 * system instruction as if the user said it behaves differently, and HAL would then
 * be scoring an answer to a prompt that never existed.
 */
export function flattenMessages(messages: ChatMessage[]): { prompt: string; system: string | null } {
  const system = messages
    .filter((m) => m.role === 'system')
    .map((m) => String(m.content ?? ''))
    .join('\n\n');

  const turns = messages
    .filter((m) => m.role !== 'system')
    .map((m) => {
      const who = m.role === 'assistant' ? 'Assistant' : 'User';
      return `${who}: ${String(m.content ?? '')}`;
    });

  return {
    prompt: turns.join('\n\n'),
    system: system.length > 0 ? system : null,
  };
}

/**
 * Family, or the honest admission that we do not know.
 *
 * MODEL ONLY. My first version also tried the provider name as a fallback, and a
 * test proved that branch can never succeed: the registry is keyed by MODEL
 * (`BY_MODEL`), so 'groq' is not a lookup key and never will be. A fallback that
 * cannot fire is worse than none — it reads as extra safety while adding none.
 *
 * resolveFamily THROWS UnmappedFamilyError for anything unregistered, which is the
 * property we want: an unrecognised model reports 'unverified' rather than being
 * guessed into a family, and 'unverified' must never be counted as a distinct
 * family for quorum-diversity purposes.
 */
export function resolveFamilyOrUnverified(upstreamModel: string, _provider?: string): string {
  const model = String(upstreamModel ?? '');
  if (!model || model === 'unknown') return 'unverified';
  try {
    return resolveFamily(model);
  } catch {
    return 'unverified';
  }
}

/** Map our verdict vocabulary onto a single honest word. */
export function verdictOf(halDecision: string | null | undefined, scored: boolean): string {
  if (!scored) return 'unscored';
  const d = String(halDecision ?? '').toLowerCase();
  if (d === 'vetoed' || d === 'veto') return 'vetoed';
  if (d === 'flagged') return 'flagged';
  if (d === 'clean') return 'clean';
  return 'unscored';
}

/**
 * The catalogue an OpenAI client expects.
 *
 * Deliberately advertises INTENT-shaped names rather than a list of 500 upstream
 * models. A client asking for `auto/cheap` is stating a goal we can honour across
 * whatever is healthy right now; a client hardcoding `llama-3.1-8b-instant` has
 * pinned itself to one provider's naming and loses the resilience that is the point.
 */
const ADVERTISED_MODELS = [
  { id: 'hyperdag-auto', description: 'Route on policy: cheapest healthy provider that meets the task.' },
  { id: 'hyperdag-auto/cheap', description: 'Prefer free tier. Escalate only if nothing free is healthy.' },
  { id: 'hyperdag-auto/fast', description: 'Prefer lowest latency.' },
  { id: 'hyperdag-verified', description: 'Route, then HAL-score the answer. Verdict in X-HyperDAG-Verdict.' },
];

openaiCompatRouter.get('/models', (_req: Request, res: Response) => {
  res.json({
    object: 'list',
    data: ADVERTISED_MODELS.map((m) => ({
      id: m.id,
      object: 'model',
      created: 0,
      owned_by: 'hyperdag',
      description: m.description,
    })),
    hyperdag_note:
      'These are intents, not upstream model names. HyperDAG picks a concrete provider per call and ' +
      'reports which one served it in X-HyperDAG-Provider. Pin an upstream name and you lose the fallback.',
  });
});

/**
 * POST /v1/chat/completions — the drop-in.
 *
 * Streaming is refused explicitly rather than silently ignored: a client that asked
 * for a stream and got one JSON blob will hang waiting for chunks, and "it hung" is
 * a far worse first experience than "not supported yet, here is why".
 */
openaiCompatRouter.post('/chat/completions', async (req: Request, res: Response) => {
  if (!OPENAI_COMPAT_ENABLED) {
    return res.status(503).json({
      error: {
        message: 'The OpenAI-compatible surface is not enabled on this deployment.',
        type: 'service_unavailable',
      },
    });
  }

  const body = req.body ?? {};
  const messages = Array.isArray(body.messages) ? (body.messages as ChatMessage[]) : null;

  if (!messages || messages.length === 0) {
    return res.status(400).json({
      error: { message: 'messages is required and must be a non-empty array.', type: 'invalid_request_error' },
    });
  }

  if (body.stream === true) {
    return res.status(400).json({
      error: {
        message:
          'Streaming is not supported yet. HAL scores a complete answer, so a streamed response ' +
          'could not carry a verdict. Set stream:false, or use hyperdag-auto to skip scoring.',
        type: 'invalid_request_error',
        param: 'stream',
      },
    });
  }

  const { prompt, system } = flattenMessages(messages);
  if (!prompt.trim()) {
    return res.status(400).json({
      error: { message: 'messages contained no user or assistant content.', type: 'invalid_request_error' },
    });
  }

  const wantsVerification = String(body.model ?? '').includes('verified');
  const tierPreference = String(body.model ?? '').includes('cheap')
    ? 'free'
    : String(body.model ?? '').includes('fast')
      ? 'fast'
      : 'auto';

  // Delegate to the broker rather than re-implementing routing. See module header.
  const base = process.env.INTERNAL_SELF_URL || `http://127.0.0.1:${process.env.PORT || 3000}`;
  const auth = req.headers['authorization'];
  const apiKeyHeader = req.headers['x-api-key'];

  let brokerJson: any;
  try {
    const upstream = await fetch(`${base}/api/v1/llm/complete`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(auth ? { authorization: String(auth) } : {}),
        ...(apiKeyHeader ? { 'x-api-key': String(apiKeyHeader) } : {}),
        ...(req.headers['x-agent-gate-token']
          ? { 'x-agent-gate-token': String(req.headers['x-agent-gate-token']) }
          : {}),
      },
      body: JSON.stringify({
        prompt: system ? `${system}\n\n${prompt}` : prompt,
        tier_preference: tierPreference,
        max_tokens: body.max_tokens,
        temperature: body.temperature,
        task_hint: body.hyperdag?.task_hint,
      }),
      signal: AbortSignal.timeout(120_000),
    });
    brokerJson = await upstream.json().catch(() => ({}));
    if (!upstream.ok) {
      return res.status(upstream.status).json({
        error: {
          message: brokerJson?.error ?? brokerJson?.message ?? 'upstream broker error',
          type: 'upstream_error',
        },
      });
    }
  } catch (e: unknown) {
    return res.status(502).json({
      error: {
        message: `broker unreachable: ${e instanceof Error ? e.message : String(e)}`,
        type: 'upstream_error',
      },
    });
  }

  const text = String(brokerJson.completion ?? brokerJson.text ?? brokerJson.answer ?? '');
  const provider = String(brokerJson.provider ?? brokerJson.chosen_provider ?? 'unknown');
  const upstreamModel = String(brokerJson.model ?? 'unknown');

  // Resolve the family on OUR side, never from an upstream header.
  //
  // resolveFamily THROWS UnmappedFamilyError for anything not in the registry —
  // register-first by design, and exactly the property we want: an unrecognised
  // model is reported 'unverified' rather than guessed into a family. A claim we
  // cannot check is not a claim we make, so this never counts toward quorum
  // diversity. Model and provider are tried independently, because the first
  // throwing must not skip the second.
  const family = resolveFamilyOrUnverified(upstreamModel, provider);

  const scored = wantsVerification && brokerJson.hal_score != null;
  const verdict = verdictOf(brokerJson.hal_decision, scored);

  res.set('X-HyperDAG-Verdict', verdict);
  if (scored) res.set('X-HyperDAG-HAL-Score', String(brokerJson.hal_score));
  res.set('X-HyperDAG-Provider', provider);
  res.set('X-HyperDAG-Family', family);
  if (brokerJson.cost_usd != null) res.set('X-HyperDAG-Cost-USD', String(brokerJson.cost_usd));
  res.set('Access-Control-Expose-Headers', 'X-HyperDAG-Verdict, X-HyperDAG-HAL-Score, X-HyperDAG-Provider, X-HyperDAG-Family, X-HyperDAG-Cost-USD');

  const payload: Record<string, unknown> = {
    id: `chatcmpl-${brokerJson.call_id ?? Math.random().toString(36).slice(2)}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: body.model ?? 'hyperdag-auto',
    choices: [
      {
        index: 0,
        message: { role: 'assistant', content: text },
        finish_reason: 'stop',
      },
    ],
    usage: {
      prompt_tokens: Number(brokerJson.tokens_in ?? 0),
      completion_tokens: Number(brokerJson.tokens_out ?? 0),
      total_tokens: Number(brokerJson.tokens_in ?? 0) + Number(brokerJson.tokens_out ?? 0),
    },
  };

  // Opt-in only. Every other OpenAI implementation ignores unknown request keys, so
  // asking for this cannot break a client that does not.
  if (body.hyperdag?.verbose === true) {
    payload.hyperdag = {
      verdict,
      hal_score: scored ? brokerJson.hal_score : null,
      provider,
      upstream_model: upstreamModel,
      family,
      cost_usd: brokerJson.cost_usd ?? null,
      note:
        family === 'unverified'
          ? 'Provider family could not be resolved, so this call does not count toward quorum diversity.'
          : undefined,
    };
  }

  return res.json(payload);
});

export default openaiCompatRouter;
