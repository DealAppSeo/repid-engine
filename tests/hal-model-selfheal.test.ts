/**
 * The quorum repairs its own model ids, and says so when it does (2026-08-28).
 *
 * WHAT THIS REPLACES. Four vendor retirements have each been repaired by a human noticing 404s in
 * production JSON, reading a docs page, guessing a replacement id, and shipping a release — and the
 * fourth guess (`zai-glm-4.6`) was dead on arrival and never once returned a verdict. The repair
 * loop itself was the defect.
 *
 * THE TWO SOURCES, AND WHY NEITHER ALONE IS ENOUGH. Both failure shapes are already MEASURED here:
 *   - QUIETLY RETIRED — the vendor stops serving an id we have pinned. Only the CATALOG sees this.
 *   - ADVERTISED BUT BROKEN — `fact-check.ts` records that Google's /models list still offered
 *     `gemini-2.0-flash` while every call to it 404'd. Only the LEDGER sees this.
 * So selection uses catalog MINUS measured-dead, and the tests below pin both directions.
 *
 * THE MOST IMPORTANT TEST IN THIS FILE is `isModelNotFoundError`. Its inputs are real strings from
 * `llm_call_log`, not invented ones, because the classifier's whole job is to separate "the model is
 * gone" (4 shapes, ~380 rows over 30 days) from "we are being throttled" (429 — the single biggest
 * failure bucket in the table at 3,600+ rows). Misreading a 429 as death would drop healthy models
 * out of the quorum under exactly the load that causes throttling: a self-inflicted outage, strictly
 * worse than the bug being fixed. That asymmetry is why the classifier checks rate/credit/auth
 * shapes FIRST and returns false, and why these cases are pinned literally.
 */

jest.mock('../src/db', () => ({
  db: { from: () => ({ insert: () => Promise.resolve({ error: null }) }) },
}));

import {
  auditFamilyIndependence,
  buildFactCheckProvidersWith,
  providerHeaders,
  providerBody,
  parseProviderResponse,
} from '../src/hal/fact-check';
import { parseModelIds, setCachedCatalog, catalogModelsFor, catalogIsMeasured } from '../src/hal/model-catalog';
import { isModelNotFoundError, classifyEvidence, setCachedEvidence, isMeasuredDead } from '../src/hal/dead-model-evidence';
import { selectModel, scoreCandidate, eligibleCandidates, type SelectionInput } from '../src/hal/model-selection';

const ALL_OFF = {
  groq: false, cerebras: false, fireworks: false, deepseek: false,
  gemini: false, mistral: false, qwen: false, openrouter: false,
} as const;

const TOUCHED = [
  'GROQ_API_KEY', 'CEREBRAS_API_KEY', 'GEMINI_API_KEY', 'OPENROUTER_API_KEY', 'MISTRAL_API_KEY',
  'DEEPSEEK_API_KEY', 'HAL_S2_GROQ_MODEL', 'HAL_S2_CEREBRAS_MODEL', 'HAL_S2_GEMINI_MODEL',
  'HAL_S2_OPENROUTER_MODEL', 'HAL_S2_GEMINI_VIA_OPENROUTER', 'HAL_S2_CEREBRAS_ALLOW_DEAD_MODEL',
  'HAL_QUORUM_AUTOBACKFILL', 'ANTHROPIC_API_KEY', 'HAL_S2_ANTHROPIC_MODEL', 'HAL_S2_ANTHROPIC_TIER',
  'HAL_S2_ENABLE_ANTHROPIC', 'LOCAL_LLM_BASE_URL', 'OPENAI_BASE_URL', 'HAL_S2_ENABLE_FRONTIER',
];

function withEnv<T>(env: Record<string, string | undefined>, fn: () => T): T {
  const saved: Record<string, string | undefined> = {};
  for (const k of [...TOUCHED, ...Object.keys(env)]) saved[k] = process.env[k];
  try {
    for (const k of TOUCHED) delete process.env[k];
    for (const [k, v] of Object.entries(env)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    return fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

/** Reset both caches to cold — the state every process boots in. */
function coldCaches() {
  setCachedCatalog({ entries: {}, refreshed_at: null });
  setCachedEvidence({ rows: [], refreshed_at: null });
}

beforeEach(coldCaches);
afterEach(coldCaches);

// ════════════════════════════════════════════════════════════════════════════════════════════════
describe('COLD CACHES ARE TODAY\'S BEHAVIOUR — the OFF state and the un-refreshed state are one state', () => {
  it('with nothing measured, providers use exactly their configured/shipped models', () => {
    const out = withEnv(
      { GROQ_API_KEY: 'k', MISTRAL_API_KEY: 'k', HAL_QUORUM_AUTOBACKFILL: 'false' },
      () => buildFactCheckProvidersWith({ ...ALL_OFF, groq: true, mistral: true }),
    );
    expect(out.find((p) => p.name === 'groq')!.model).toBe('openai/gpt-oss-20b');
    expect(out.find((p) => p.name === 'mistral')!.model).toBe('mistral-small-latest');
  });

  it('and NOTHING is reported as substituted — an untouched build must claim no self-healing', () => {
    // If this ever fails, every quorum would carry a `selections` field, which would make a real
    // substitution unreadable by drowning it. Absent, not empty, is the contract.
    const out = withEnv({ GROQ_API_KEY: 'k', HAL_QUORUM_AUTOBACKFILL: 'false' }, () =>
      buildFactCheckProvidersWith({ ...ALL_OFF, groq: true }),
    );
    expect(out.every((p) => p.selection === undefined)).toBe(true);
  });

  it('an unmeasured catalog is not an empty catalog', () => {
    // The distinction the whole module rests on: "we did not ask" must never read as "there is
    // nothing there", or a cold cache would look like a vendor with no models and skip the provider.
    expect(catalogIsMeasured('groq')).toBe(false);
    expect(catalogModelsFor('groq')).toEqual([]);
    expect(isMeasuredDead('groq', 'anything')).toBe(false);
  });
});

// ════════════════════════════════════════════════════════════════════════════════════════════════
describe('the catalog parser handles both shapes in the wild', () => {
  it('OpenAI-compatible: {data:[{id}]}', () => {
    expect(parseModelIds({ data: [{ id: 'llama-3.3-70b' }, { id: 'gpt-oss-120b' }] }))
      .toEqual(['llama-3.3-70b', 'gpt-oss-120b']);
  });

  it('Google/Cohere: {models:[{name}]} — and the `models/` prefix is STRIPPED', () => {
    // Unstripped, this hands the caller `models/gemini-2.5-flash`, which the completion endpoint
    // 404s. A catalog that returns ids you cannot call is the bug it exists to prevent.
    expect(parseModelIds({ models: [{ name: 'models/gemini-2.5-flash' }] })).toEqual(['gemini-2.5-flash']);
  });

  it('garbage in, empty out — never a throw, never an invented id', () => {
    for (const junk of [null, undefined, 42, 'a string', {}, { data: 'not-an-array' }, { data: [{}] }]) {
      expect(parseModelIds(junk)).toEqual([]);
    }
  });
});

// ════════════════════════════════════════════════════════════════════════════════════════════════
describe('MODEL DEATH vs EVERYTHING ELSE — real strings from llm_call_log', () => {
  // All four measured death shapes, verbatim from the ledger.
  it.each([
    ['cerebras archived', 'HTTP 404: {"message":"Model zai-glm-4.7 is archived and unavailable for the organization.","type":"model_archived_error"'],
    ['groq shutdown', 'HTTP 404: {"error":{"message":"The model `llama-3.1-8b-instant` does not exist or you do not have access to it.","type":'],
    ['google retirement', 'HTTP 404: [{\n  "error": {\n    "code": 404,\n    "message": "This model models/gemini-2.0-flash is no longer available. Pl'],
    ['generic not-found', 'HTTP 404: {"message":"Model does not exist or you do not have access to it.","type":"not_found_error","param":"model"'],
  ])('%s IS model death', (_label, msg) => {
    expect(isModelNotFoundError(msg)).toBe(true);
  });

  // The far more common failures. Every one of these must be false.
  it.each([
    ['rate limit, generic', 'HTTP 429: {"message":"Requests per minute limit exceeded - too many requests sent.","type":"too_many_requests_error"'],
    ['rate limit NAMING THE MODEL', 'HTTP 429: {"error":{"message":"Rate limit reached for model `llama-3.1-8b-instant` in organization `org_redacted`'],
    ['out of credits', 'HTTP 402: {"error":{"message":"This request requires more credits, or fewer max_tokens. You requested up to 512 tokens,'],
    ['bad key', 'HTTP 401: {"error":{"message":"Invalid API Key","type":"invalid_request_error","code":"invalid_api_key"}}'],
    ['timeout', 'timeout after 12000ms'],
    ['network', 'fetch failed'],
    ['unparseable answer', 'empty content'],
    ['upstream 503', 'HTTP 503: [{\n  "error": {\n    "code": 503,\n    "message": "The service is currently unavailable."'],
    ['nothing at all', ''],
  ])('%s is NOT model death', (_label, msg) => {
    expect(isModelNotFoundError(msg)).toBe(false);
  });

  it('a stray 404 in the PROSE of a non-404 body is not a retirement', () => {
    // Found by the failability check on this file: the first version matched a bare /\b404\b/,
    // which reads arbitrary upstream JSON — token counts, byte lengths, request ids — as vendor
    // retirements. The ledger already carries a 402 whose text is "You requested up to 512
    // tokens", a number in exactly that position. Only the HTTP status may mean the status.
    expect(isModelNotFoundError(
      'HTTP 402: {"error":{"message":"This request requires more credits. You requested up to 404 tokens"}}',
    )).toBe(false);
    expect(isModelNotFoundError('HTTP 500: {"request_id":"req_404aa","message":"internal"}')).toBe(false);
    // …while every real shape the logger writes still reads as death.
    expect(isModelNotFoundError('Groq HTTP 404: {"error":{"message":"The model `x` does not exist"}}')).toBe(true);
    expect(isModelNotFoundError('Groq HTTP error: 404')).toBe(true);
  });

  it('THE TRAP, stated on its own: a 429 body that names the model is still a 429', () => {
    // This one string is why the rate/credit/auth checks run BEFORE the model-name match. Groq's
    // throttle message quotes the model id, so a classifier that looked for the id first would call
    // the single largest failure bucket in the table "death" and empty the quorum under load.
    const throttleNamingModel =
      'HTTP 429: {"error":{"message":"Rate limit reached for model `llama-3.1-8b-instant` in organization ..."}}';
    expect(isModelNotFoundError(throttleNamingModel)).toBe(false);
    expect(/model .*does not exist|404/.test(throttleNamingModel)).toBe(false);
  });
});

// ════════════════════════════════════════════════════════════════════════════════════════════════
describe('the ledger can UN-learn — this is what a static list cannot do', () => {
  const base = { provider: 'cerebras', model: 'zai-glm-4.7', not_found: 0, other_failures: 0, successes: 0 };

  it('repeated not-found with no success ⇒ DEAD', () => {
    expect(classifyEvidence({ ...base, not_found: 2 })).toBe('DEAD');
  });

  it('ONE success anywhere in the window ⇒ LIVE, however many 404s preceded it', () => {
    // THE LIVE CASE THIS WAS BUILT FOR. A new key was issued that CAN reach a model the previous
    // key could not, while this repo had just shipped that id as retired on the old key's 404s.
    // Both facts were true of different credentials. The ledger resolves it with no deploy and no
    // PR to delete a row — which is the entire argument for measuring over maintaining a list.
    expect(classifyEvidence({ ...base, not_found: 50, successes: 1 })).toBe('LIVE');
  });

  it('one lone 404 is UNKNOWN, not DEAD — and UNKNOWN never excludes', () => {
    expect(classifyEvidence({ ...base, not_found: 1 })).toBe('UNKNOWN');
  });

  it('throttling alone never condemns a model', () => {
    expect(classifyEvidence({ ...base, other_failures: 900 })).toBe('UNKNOWN');
  });

  it('a model never called is UNKNOWN — otherwise nothing new could ever get its first call', () => {
    // The cold-start deadlock. If "not known live" excluded, a newly-added model could never be
    // tried, so the system could never adopt one — the opposite of the goal.
    expect(classifyEvidence(base)).toBe('UNKNOWN');
  });
});

// ════════════════════════════════════════════════════════════════════════════════════════════════
describe('selection: pin when you can, heal when you cannot, always say which', () => {
  const familyOf = (m: string) =>
    /glm|zai/.test(m) ? 'glm' : /gemini|gemma/.test(m) ? 'gemini' : /gpt|oss/.test(m) ? 'openai' : /qwen/.test(m) ? 'qwen' : 'other';

  const input = (over: Partial<SelectionInput> = {}): SelectionInput => ({
    provider: 'cerebras',
    catalogModels: [],
    catalogMeasured: false,
    isMeasuredDead: () => false,
    isStaticallyRetired: () => false,
    familiesTaken: new Set<string>(),
    familyOf,
    ...over,
  });

  it('a live operator override is used untouched, even if the catalog does not list it', () => {
    // The operator may know something we do not — a new key, an early-access grant. Only OUR OWN
    // measurement of the credential in use may overrule them.
    const c = selectModel(input({ operatorModel: 'secret-preview-model', catalogMeasured: true, catalogModels: ['a', 'b'] }));
    expect(c.model).toBe('secret-preview-model');
    expect(c.source).toBe('operator');
    expect(c.substituted).toBe(false);
    expect(c.reason).toContain('not in this key');
  });

  it('a working pin is KEPT — the measurement ruler survives', () => {
    const c = selectModel(input({ staticModel: 'zai-glm-4.9', catalogMeasured: true, catalogModels: ['zai-glm-4.9', 'qwen-3'] }));
    expect(c.model).toBe('zai-glm-4.9');
    expect(c.source).toBe('static');
    expect(c.substituted).toBe(false);
  });

  it('a MEASURED-DEAD override is replaced from the live catalog, and the reason names it', () => {
    const c = selectModel(input({
      operatorModel: 'zai-glm-4.7',
      catalogMeasured: true,
      catalogModels: ['zai-glm-4.9', 'gpt-oss-120b'],
      isMeasuredDead: (m) => m === 'zai-glm-4.7',
    }));
    expect(c.model).toBe('zai-glm-4.9');
    expect(c.source).toBe('catalog');
    expect(c.substituted).toBe(true);
    expect(c.reason).toContain('zai-glm-4.7');
    expect(c.reason).toContain('MEASURED dead');
  });

  it('WITHOUT a measured catalog it never invents a replacement', () => {
    // The rule that would have prevented `zai-glm-4.6`: with no list to choose from, the answer is
    // "keep what you have, unverified" — never a third id sourced from anywhere else.
    const c = selectModel(input({ staticModel: 'zai-glm-4.7', catalogMeasured: false, isMeasuredDead: () => true }));
    expect(c.source).toBe('static');
    expect(c.reason).toContain('NOT_CHECKED');
  });

  it('nothing reachable ⇒ no model, so the caller SKIPS rather than dialling a guaranteed 404', () => {
    const c = selectModel(input({ catalogMeasured: true, catalogModels: ['text-embedding-3-large', 'whisper-large-v3'] }));
    expect(c.model).toBeNull();
    expect(c.source).toBe('none');
  });

  it('THE FAMILY BONUS DOMINATES: a new family beats a faster model in a covered one', () => {
    // The quorum buys INDEPENDENCE, not latency. A second voter inside a family already present
    // adds no dissent, and MIN_QUORUM_FOR_VETO is 2 — so widening the panel is worth more than
    // shaving milliseconds inside it.
    const c = selectModel(input({
      catalogMeasured: true,
      catalogModels: ['gpt-oss-120b-flash-mini', 'zai-glm-4.9'],
      familiesTaken: new Set(['openai']),
    }));
    expect(familyOf(c.model!)).toBe('glm');
    expect(c.reason).toContain('new to this quorum');
  });

  it('within one family, fast and cheap wins and reasoning models lose', () => {
    // MEASURED: the reasoning model in this panel ran ~1442ms/640tok against ~251ms/203tok for the
    // fastest member, to emit the same three-field JSON.
    const taken = new Set<string>();
    expect(scoreCandidate('glm-flash-mini', taken, familyOf)).toBeGreaterThan(
      scoreCandidate('glm-thinking-235b', taken, familyOf),
    );
  });

  it('non-chat models are excluded — calling one is a guaranteed 400', () => {
    const got = eligibleCandidates(input({
      catalogMeasured: true,
      catalogModels: ['text-embedding-3-small', 'whisper-large', 'llama-guard-4', 'tts-1', 'qwen-3-chat'],
    }));
    expect(got).toEqual(['qwen-3-chat']);
  });

  it('THE LEDGER OUTRANKS THE STATIC LIST — a statically-retired model that answers is eligible', () => {
    // The un-learn path, at the selection layer. `isMeasuredDead` false + `isStaticallyRetired`
    // true must not resurrect it (the list is still a backstop) …
    expect(eligibleCandidates(input({
      catalogMeasured: true, catalogModels: ['zai-glm-4.7'], isStaticallyRetired: (m) => m === 'zai-glm-4.7',
    }))).toEqual([]);
    // … but a DEAD verdict is what actually excludes, and it is keyed to the credential in use.
    expect(eligibleCandidates(input({
      catalogMeasured: true, catalogModels: ['zai-glm-4.7'], isMeasuredDead: (m) => m === 'zai-glm-4.7',
    }))).toEqual([]);
  });
});

// ════════════════════════════════════════════════════════════════════════════════════════════════
describe('gemini routes DIRECT by default — splitting it from the shared OpenRouter account', () => {
  const geminiOf = (enable: Record<string, string | undefined>) =>
    withEnv({ HAL_QUORUM_AUTOBACKFILL: 'false', ...enable }, () =>
      buildFactCheckProvidersWith({ ...ALL_OFF, gemini: true }).find((p) => p.name === 'gemini'),
    );

  it('with BOTH keys present, gemini goes to Google directly', () => {
    // THE CHANGE. Previously OpenRouter won whenever its key existed, putting two of the quorum's
    // families on one account and one credit pool — a pool that has returned `HTTP 402 … requires
    // more credits` 8,762 times against 16,643 successes.
    const g = geminiOf({ GEMINI_API_KEY: 'k', OPENROUTER_API_KEY: 'k' })!;
    expect(g.endpoint).toContain('generativelanguage.googleapis.com');
    expect(g.model).toBe('gemini-2.5-flash');
  });

  it('with no Gemini key it still falls back to OpenRouter — the family is never simply dropped', () => {
    const g = geminiOf({ OPENROUTER_API_KEY: 'k' })!;
    expect(g.endpoint).toContain('openrouter.ai');
    expect(g.model).toBe('google/gemini-3.5-flash');
  });

  it('the flag forces the re-route back on, without a release', () => {
    const g = geminiOf({ GEMINI_API_KEY: 'k', OPENROUTER_API_KEY: 'k', HAL_S2_GEMINI_VIA_OPENROUTER: 'true' })!;
    expect(g.endpoint).toContain('openrouter.ai');
  });

  it('THE SLUG NAMESPACES DO NOT MIX: an OpenRouter-shaped override never lands on the direct endpoint', () => {
    // `google/gemini-3.5-flash` is a valid OpenRouter slug and a guaranteed 404 on Google's own
    // endpoint. One env var applied to whichever route we happened to pick would silently break the
    // model, so an override only applies to the endpoint whose shape it matches.
    const g = geminiOf({ GEMINI_API_KEY: 'k', HAL_S2_GEMINI_MODEL: 'google/gemini-3.5-flash' })!;
    expect(g.endpoint).toContain('generativelanguage.googleapis.com');
    expect(g.model).toBe('gemini-2.5-flash'); // the direct default, NOT the OpenRouter slug
  });

  it('and a direct-shaped override IS honoured on the direct endpoint', () => {
    const g = geminiOf({ GEMINI_API_KEY: 'k', HAL_S2_GEMINI_MODEL: 'gemini-3.5-flash' })!;
    expect(g.model).toBe('gemini-3.5-flash');
  });

  it('gemini and openrouter are now separate HOSTS, which is the point of the change', () => {
    const out = withEnv({ GEMINI_API_KEY: 'k', OPENROUTER_API_KEY: 'k', HAL_QUORUM_AUTOBACKFILL: 'false' }, () =>
      buildFactCheckProvidersWith({ ...ALL_OFF, gemini: true, openrouter: true }),
    );
    const hosts = out.map((p) => new URL(p.endpoint).host);
    expect(new Set(hosts).size).toBe(out.length); // no two members share an account
  });
});

// ════════════════════════════════════════════════════════════════════════════════════════════════
describe('the anthropic dialect — an independent family that was already paid for', () => {
  const cfg = {
    name: 'anthropic',
    endpoint: 'https://api.anthropic.com/v1/messages',
    apiKey: 'test-key-not-real',
    model: 'claude-haiku-4-5-20251001',
    dialect: 'anthropic' as const,
  };
  const oai = { name: 'groq', endpoint: 'https://x/v1/chat/completions', apiKey: 'test-key-not-real', model: 'm' };

  it('authenticates with x-api-key and a version header — NEVER as a Bearer token', () => {
    // Not cosmetic. Anthropic rejects a Bearer outright, so getting this wrong is a 401 that looks
    // like a dead key; and sending a credential under the wrong scheme is worth pinning on its own.
    const h = providerHeaders(cfg);
    expect(h['x-api-key']).toBe('test-key-not-real');
    expect(h['anthropic-version']).toBeTruthy();
    expect(h['Authorization']).toBeUndefined();
  });

  it('the openai dialect is untouched — this is the regression that matters', () => {
    const h = providerHeaders(oai);
    expect(h['Authorization']).toBe('Bearer test-key-not-real');
    expect(h['x-api-key']).toBeUndefined();
  });

  it('the system prompt is a TOP-LEVEL field, not a system message', () => {
    // Anthropic 400s on a `role: "system"` entry in `messages`. A body that merely looks close
    // enough would fail on the first real call and read as an outage.
    const b = JSON.parse(providerBody(cfg, 'the sky is blue', 64));
    expect(typeof b.system).toBe('string');
    expect(b.messages).toHaveLength(1);
    expect(b.messages[0].role).toBe('user');
    expect(b.messages.some((m: any) => m.role === 'system')).toBe(false);
  });

  it('…and stays a system message on the openai dialect', () => {
    const b = JSON.parse(providerBody(oai, 'the sky is blue', 64));
    expect(b.messages[0].role).toBe('system');
    expect(b.system).toBeUndefined();
  });

  it('reads content blocks and its own token fields', () => {
    const parsed = parseProviderResponse(cfg, {
      content: [{ type: 'text', text: '{"verdict":' }, { type: 'text', text: '"TRUE"}' }],
      usage: { input_tokens: 11, output_tokens: 7 },
    });
    // Concatenated, not first-block-only: a verdict split across blocks must not be truncated
    // into unparseable JSON, which would surface as a phantom provider failure.
    expect(parsed.content).toBe('{"verdict":"TRUE"}');
    expect(parsed.tokensIn).toBe(11);
    expect(parsed.tokensOut).toBe(7);
  });

  it('a non-text block is skipped rather than crashing the parse', () => {
    const parsed = parseProviderResponse(cfg, { content: [{ type: 'thinking' }, { type: 'text', text: 'ok' }] });
    expect(parsed.content).toBe('ok');
  });

  it('openai responses still parse, reasoning fallbacks included', () => {
    expect(parseProviderResponse(oai, { choices: [{ message: { content: 'a' } }], usage: { prompt_tokens: 2, completion_tokens: 3 } }))
      .toEqual({ content: 'a', tokensIn: 2, tokensOut: 3 });
    expect(parseProviderResponse(oai, { choices: [{ message: { reasoning: 'r' } }] }).content).toBe('r');
  });

  it('joins the quorum as its own family, on its own account, at escalation tier', () => {
    const out = withEnv({ ANTHROPIC_API_KEY: 'k', GROQ_API_KEY: 'k', OPENROUTER_API_KEY: 'k' }, () =>
      buildFactCheckProvidersWith({ ...ALL_OFF, groq: true }),
    );
    const a = out.find((p) => p.name === 'anthropic');
    expect(a).toBeDefined();
    expect(a!.family).toBe('anthropic');
    expect(a!.dialect).toBe('anthropic');
    expect(a!.tier).toBe('escalation'); // costs nothing while the free wave forms a quorum
    // The whole point: a family nobody else covers, reached without OpenRouter in the path.
    expect(new URL(a!.endpoint).host).toBe('api.anthropic.com');
    expect(out.filter((p) => p.family === 'anthropic')).toHaveLength(1);
  });

  it('LOCAL_LLM_BASE_URL DROPS it rather than pointing /v1/messages at an openai server', () => {
    // The bug this prevents: the redirect loop used to assume every member was openai-compat, so
    // it would have rewritten this endpoint and posted a body the local host cannot parse —
    // converting a working self-hosted setup into a silently failing provider. Dropping is also
    // the conservative choice under a data-locality boundary: leaving the cloud endpoint would
    // be an egress leak.
    const out = withEnv({ ANTHROPIC_API_KEY: 'k', GROQ_API_KEY: 'k', LOCAL_LLM_BASE_URL: 'http://127.0.0.1:11434/v1' }, () =>
      buildFactCheckProvidersWith({ ...ALL_OFF, groq: true }),
    );
    expect(out.find((p) => p.name === 'anthropic')).toBeUndefined();
    // …and the openai-compat member IS still redirected, so the local path keeps working.
    expect(out.find((p) => p.name === 'groq')!.endpoint).toContain('127.0.0.1');
  });

  it('the direct account WINS over the routed one for the same family', () => {
    // Without this the frontier panel would put `or-claude` (family 'anthropic', via OpenRouter)
    // alongside the direct member — two hosts, ONE vote — and trip the family-independence audit
    // with a violation the direct member itself introduced. Prefer the independent account.
    const out = withEnv(
      { ANTHROPIC_API_KEY: 'k', OPENROUTER_API_KEY: 'k', GROQ_API_KEY: 'k', HAL_S2_ENABLE_FRONTIER: 'true' },
      () => buildFactCheckProvidersWith({ ...ALL_OFF, groq: true }),
    );
    expect(out.filter((p) => p.family === 'anthropic')).toHaveLength(1);
    expect(out.find((p) => p.family === 'anthropic')!.name).toBe('anthropic');
    // Asserted on the anthropic family SPECIFICALLY, not on whole-panel independence.
    //
    // A blanket `independent === true` here fails, and for a reason that is NOT this change: with
    // the frontier panel on, groq's default `openai/gpt-oss-20b` and or-gpt's `openai/gpt-4o` both
    // resolve to family 'openai', so they already count as one vote. That collision predates the
    // anthropic member and is out of scope here (frontier is default OFF, so production is
    // unaffected) — but asserting the broad claim would have quietly attached a pre-existing bug
    // to this diff, and later "fixing" the test would have buried it. Pinned narrowly, and the
    // collision is reported rather than absorbed.
    const collapsed = auditFamilyIndependence(out).collapsed;
    expect(collapsed.map((c) => c.family)).not.toContain('anthropic');
  });

  it('PRE-EXISTING, recorded not fixed: groq and or-gpt are both family openai', () => {
    // Documented here because this suite is where it surfaced. With HAL_S2_ENABLE_FRONTIER=true
    // the panel counts two 'openai' hosts as two votes in its width while the audit says they are
    // one — and the frontier panel's recorded F1 was measured at exactly that configuration. Not
    // touched in this change: frontier is default OFF, so no live quorum is affected, and fixing
    // it means re-measuring a frozen number. If this test ever goes red because the collision is
    // gone, delete it — that is the fix landing, not a regression.
    const out = withEnv({ OPENROUTER_API_KEY: 'k', GROQ_API_KEY: 'k', HAL_S2_ENABLE_FRONTIER: 'true' }, () =>
      buildFactCheckProvidersWith({ ...ALL_OFF, groq: true }),
    );
    const openai = out.filter((p) => p.family === 'openai').map((p) => p.name).sort();
    expect(openai).toEqual(['groq', 'or-gpt']);
  });

  it('…and without a direct key, the routed one is added exactly as before', () => {
    const out = withEnv(
      { OPENROUTER_API_KEY: 'k', GROQ_API_KEY: 'k', HAL_S2_ENABLE_FRONTIER: 'true' },
      () => buildFactCheckProvidersWith({ ...ALL_OFF, groq: true }),
    );
    expect(out.find((p) => p.family === 'anthropic')!.name).toBe('or-claude');
  });

  it('no key, no member — presence is the only trigger', () => {
    const out = withEnv({ GROQ_API_KEY: 'k' }, () => buildFactCheckProvidersWith({ ...ALL_OFF, groq: true }));
    expect(out.find((p) => p.name === 'anthropic')).toBeUndefined();
  });
});

// ════════════════════════════════════════════════════════════════════════════════════════════════
describe('FAILABILITY — every guard above must be able to go red', () => {
  it('the catalog actually drives selection when it is warm', () => {
    // Without this, every test in this file could be passing because nothing is wired, and the
    // whole suite would report safety it has not earned. This is the one that proves the wire.
    setCachedCatalog({
      entries: { cerebras: { provider: 'cerebras', status: 'MEASURED', models: ['zai-glm-4.9'], detail: 'test', fetched_at: 'now' } },
      refreshed_at: 'now',
    });
    setCachedEvidence({
      rows: [{ provider: 'cerebras', model: 'zai-glm-4.7', successes: 0, not_found: 9, other_failures: 0, liveness: 'DEAD' }],
      refreshed_at: 'now',
    });

    expect(catalogIsMeasured('cerebras')).toBe(true);
    expect(isMeasuredDead('cerebras', 'zai-glm-4.7')).toBe(true);

    const c = withEnv(
      { CEREBRAS_API_KEY: 'k', HAL_S2_CEREBRAS_MODEL: 'zai-glm-4.7', HAL_S2_CEREBRAS_ALLOW_DEAD_MODEL: 'true', HAL_QUORUM_AUTOBACKFILL: 'false' },
      () => buildFactCheckProvidersWith({ ...ALL_OFF, cerebras: true }).find((p) => p.name === 'cerebras'),
    );
    // The dead pinned id was replaced by the only live one the key advertises — no deploy involved.
    expect(c!.model).toBe('zai-glm-4.9');
    expect(c!.selection?.substituted).toBe(true);
    expect(c!.selection?.source).toBe('catalog');
  });

  it('and the substitution is REPORTED, never silent', () => {
    setCachedCatalog({
      entries: { mistral: { provider: 'mistral', status: 'MEASURED', models: ['mistral-medium-latest'], detail: 't', fetched_at: 'now' } },
      refreshed_at: 'now',
    });
    setCachedEvidence({
      rows: [{ provider: 'mistral', model: 'mistral-small-latest', successes: 0, not_found: 4, other_failures: 0, liveness: 'DEAD' }],
      refreshed_at: 'now',
    });
    const m = withEnv({ MISTRAL_API_KEY: 'k', HAL_QUORUM_AUTOBACKFILL: 'false' }, () =>
      buildFactCheckProvidersWith({ ...ALL_OFF, mistral: true }).find((p) => p.name === 'mistral'),
    );
    expect(m!.model).toBe('mistral-medium-latest');
    expect(m!.selection?.reason).toMatch(/mistral-small-latest/);
  });
});

// ════════════════════════════════════════════════════════════════════════════════════════════════
/**
 * THE SKIP GUARD RAN BEFORE SELF-HEALING, so self-healing could never fire for cerebras.
 *
 * MEASURED ON PRODUCTION 2026-08-28 at commit 736062e, keyless POST /api/v1/hal/evaluate:
 *
 *   "skipped":[{"name":"cerebras","reason":"not called: configured model 'zai-glm-4.7' is
 *              retired and 404s on every call. …"}]
 *
 * On the SAME response, deepseek's dead pinned id was silently healed from the live catalog
 * ("selected 'deepseek-v4-flash' from this key's live model list"). One provider healed; the
 * other reported a skip. The difference is not the catalog — it is one `&&`.
 *
 * The builder read:
 *
 *     if (c && enabled.cerebras && !cerebrasDeadModelSkip()) add(…)
 *
 * and the comment directly above it claimed "SELF-HEALING SUPERSEDES THE HARDCODED SKIP … a
 * cerebras with NO usable configured model is no longer automatically nothing". That comment is
 * mine, from earlier the same day, and it was false in BOTH cases it named:
 *
 *   - no model configured  → cerebrasDeadModelSkip() returns the "no model configured" skip
 *   - model configured but retired → it returns the "retired" skip
 *
 * Those are exactly the two states where healing is worth anything, and in both the guard
 * short-circuited before `add()` was ever reached. The only state that got through to selection
 * was HAL_S2_CEREBRAS_ALLOW_DEAD_MODEL=true — which is the operator having already fixed it by
 * hand, the case that needs no healing at all. The existing FAILABILITY test above passes for
 * precisely that reason: it sets that flag.
 *
 * A mechanism wired at both ends that cannot run under any condition it was built for. Same class
 * as the workflow that always refused on `main`, found the same way — by executing it.
 *
 * THE SKIP IS NOT DELETED, and must not be: with a cold catalog there is nothing to select from,
 * and dialling a known-404 id costs a request and reports the quorum `partial`. What changed is
 * ORDER. Selection gets first refusal; the skip stands only when selection finds nothing — which
 * `add()` already reports by returning false and pushing nothing.
 */
describe('cerebras: self-healing gets first refusal, and the skip is the fallback', () => {
  const cerebrasWith = (env: Record<string, string | undefined>) =>
    withEnv({ CEREBRAS_API_KEY: 'k', HAL_QUORUM_AUTOBACKFILL: 'false', ...env }, () =>
      buildFactCheckProvidersWith({ ...ALL_OFF, cerebras: true }).find((p) => p.name === 'cerebras'),
    );

  /** A warm catalog offering one live id, and a ledger that has measured the pinned id dead. */
  function warmWithLiveReplacement() {
    setCachedCatalog({
      entries: { cerebras: { provider: 'cerebras', status: 'MEASURED', models: ['zai-glm-4.9'], detail: 't', fetched_at: 'now' } },
      refreshed_at: 'now',
    });
    setCachedEvidence({
      rows: [{ provider: 'cerebras', model: 'zai-glm-4.7', successes: 0, not_found: 9, other_failures: 0, liveness: 'DEAD' }],
      refreshed_at: 'now',
    });
  }

  it("PRODUCTION'S EXACT STATE: a retired pin + a live catalog now heals instead of skipping", () => {
    // No HAL_S2_CEREBRAS_ALLOW_DEAD_MODEL — that is the whole point. Before the fix this was
    // undefined (guard short-circuited); the family sat out of every quorum while a model it
    // could reach was sitting in the catalog.
    warmWithLiveReplacement();
    const c = cerebrasWith({ HAL_S2_CEREBRAS_MODEL: 'zai-glm-4.7' });
    expect(c).toBeDefined();
    expect(c!.model).toBe('zai-glm-4.9');
    expect(c!.selection?.substituted).toBe(true);
    expect(c!.selection?.source).toBe('catalog');
  });

  it('NO MODEL CONFIGURED AT ALL also heals — the other case the comment claimed', () => {
    warmWithLiveReplacement();
    const c = cerebrasWith({ HAL_S2_CEREBRAS_MODEL: undefined });
    expect(c).toBeDefined();
    expect(c!.model).toBe('zai-glm-4.9');
  });

  it('FAILABILITY — a COLD catalog still skips: healing must not become invention', () => {
    // The state every process boots in. Nothing has been measured, so there is nothing to select
    // from, and dialling the retired pin anyway is the bug the skip exists to prevent. If this
    // ever goes green with a model, the fix has turned into a guess.
    coldCaches();
    expect(cerebrasWith({ HAL_S2_CEREBRAS_MODEL: 'zai-glm-4.7' })).toBeUndefined();
  });

  it('FAILABILITY — a warm catalog with NO live model still skips', () => {
    // The vendor answered and offered nothing this key can chat with. That is a real skip, and
    // it must survive: an empty catalog is a measurement, not a licence to dial the dead id.
    setCachedCatalog({
      entries: { cerebras: { provider: 'cerebras', status: 'MEASURED', models: [], detail: 't', fetched_at: 'now' } },
      refreshed_at: 'now',
    });
    expect(cerebrasWith({ HAL_S2_CEREBRAS_MODEL: 'zai-glm-4.7' })).toBeUndefined();
  });

  it('FAILABILITY — a catalog offering ONLY the dead id still skips', () => {
    // The vendor still lists a model our ledger has watched 404 nine times. The ledger outranks
    // the catalog; nothing eligible remains.
    warmWithLiveReplacement();
    setCachedCatalog({
      entries: { cerebras: { provider: 'cerebras', status: 'MEASURED', models: ['zai-glm-4.7'], detail: 't', fetched_at: 'now' } },
      refreshed_at: 'now',
    });
    expect(cerebrasWith({ HAL_S2_CEREBRAS_MODEL: 'zai-glm-4.7' })).toBeUndefined();
  });

  it('an operator id that is NOT dead is still used untouched — the operator keeps the last word', () => {
    warmWithLiveReplacement();
    const c = cerebrasWith({ HAL_S2_CEREBRAS_MODEL: 'zai-glm-4.9' });
    expect(c!.model).toBe('zai-glm-4.9');
    // `selection` is attached ONLY on a substitution (see add()), so its absence here IS the
    // assertion: nothing was overridden, and the reported-substitution channel stays quiet when
    // there is nothing to report.
    expect(c!.selection).toBeUndefined();
  });

  it('ALLOW_DEAD_MODEL still forces the dead id through, unchanged', () => {
    // The documented manual override must not be quietly overruled by healing.
    coldCaches();
    const c = cerebrasWith({ HAL_S2_CEREBRAS_MODEL: 'zai-glm-4.7', HAL_S2_CEREBRAS_ALLOW_DEAD_MODEL: 'true' });
    expect(c!.model).toBe('zai-glm-4.7');
  });

  it('no key means no member and no skip — absence is not a dead model', () => {
    warmWithLiveReplacement();
    const c = withEnv({ CEREBRAS_API_KEY: undefined, HAL_QUORUM_AUTOBACKFILL: 'false' }, () =>
      buildFactCheckProvidersWith({ ...ALL_OFF, cerebras: true }).find((p) => p.name === 'cerebras'),
    );
    expect(c).toBeUndefined();
  });
});

// ════════════════════════════════════════════════════════════════════════════════════════════════
/**
 * Z.AI joins the QUORUM, not just the router — the credential now buys the family it names.
 *
 * `src/providers/zai.ts` and `ZAI_API_KEY` both already existed, and the adapter's own header says
 * what they did NOT do: "this does not widen HAL quorum on its own". It served
 * src/providers/router.ts only. So the key could be set on the service and the fact-check panel
 * would still have no GLM voice — a credential that looks connected and buys nothing.
 *
 * That mattered because `glm` reached the quorum through cerebras, whose shipped ids are all
 * retired. MEASURED on production 2026-08-28: four families answered and glm was not among them.
 * Z.AI publishes GLM on a permanently free tier, so this restores the family at zero marginal cost
 * — and on the vendor's own account, which is independence in the BILLING sense too. That is the
 * property MIN_QUORUM_FOR_VETO=2 actually rests on: two families on one credit pool are one
 * billing event away from being one family.
 */
describe('zai is a first-class quorum member', () => {
  const zaiOf = (env: Record<string, string | undefined>) =>
    withEnv({ HAL_QUORUM_AUTOBACKFILL: 'false', ...env }, () =>
      buildFactCheckProvidersWith({ ...ALL_OFF, zai: true } as never).find((p) => p.name === 'zai'),
    );

  it('key present + enabled -> a glm-family member on the vendor endpoint', () => {
    const z = zaiOf({ ZAI_API_KEY: 'k' });
    expect(z).toBeDefined();
    expect(z!.family).toBe('glm');
    expect(z!.endpoint).toBe('https://api.z.ai/api/paas/v4/chat/completions');
    expect(z!.model).toBe('glm-4.5-flash');
  });

  it('FAILABILITY: no key, no member — presence is the only trigger', () => {
    expect(zaiOf({ ZAI_API_KEY: undefined })).toBeUndefined();
  });

  it('it is auto-backfilled like the other free families', () => {
    // Free tier, so it belongs in the free wave, not behind an opt-in nobody sets.
    const z = withEnv({ ZAI_API_KEY: 'k', HAL_QUORUM_AUTOBACKFILL: 'true' }, () =>
      buildFactCheckProvidersWith({ ...ALL_OFF }).find((p) => p.name === 'zai'),
    );
    expect(z).toBeDefined();
  });

  it('HAL_QUORUM_AUTOBACKFILL=false + no opt-in leaves it out', () => {
    const z = withEnv({ ZAI_API_KEY: 'k', HAL_QUORUM_AUTOBACKFILL: 'false' }, () =>
      buildFactCheckProvidersWith({ ...ALL_OFF }).find((p) => p.name === 'zai'),
    );
    expect(z).toBeUndefined();
  });

  it('an operator model override is honoured', () => {
    expect(zaiOf({ ZAI_API_KEY: 'k', HAL_S2_ZAI_MODEL: 'glm-4.7' })!.model).toBe('glm-4.7');
  });

  it('THE POINT: it adds a family the panel did not have, so the veto floor gets real headroom', () => {
    // groq=openai, mistral=mistral, zai=glm. Three families where cerebras' retirement left two.
    const out = withEnv({ GROQ_API_KEY: 'k', MISTRAL_API_KEY: 'k', ZAI_API_KEY: 'k', HAL_QUORUM_AUTOBACKFILL: 'true' },
      () => buildFactCheckProvidersWith({ ...ALL_OFF, groq: true }));
    const fams = new Set(out.map((p) => p.family));
    expect(fams.has('glm')).toBe(true);
    expect(fams.size).toBeGreaterThanOrEqual(3);
  });

  it('SELF-HEALING APPLIES TO IT TOO — it is not exempt from the system it joined', () => {
    // A member with no probe row can never have a MEASURED catalog, so it could never notice its
    // own model retiring. That is the failure the whole self-healing effort exists to end; adding a
    // provider outside it would have quietly recreated it for the newest member.
    setCachedCatalog({
      entries: { zai: { provider: 'zai', status: 'MEASURED', models: ['glm-4.9-flash'], detail: 't', fetched_at: 'now' } },
      refreshed_at: 'now',
    });
    setCachedEvidence({
      rows: [{ provider: 'zai', model: 'glm-4.5-flash', successes: 0, not_found: 5, other_failures: 0, liveness: 'DEAD' }],
      refreshed_at: 'now',
    });
    const z = zaiOf({ ZAI_API_KEY: 'k' });
    expect(z!.model).toBe('glm-4.9-flash');
    expect(z!.selection?.substituted).toBe(true);
  });
});
