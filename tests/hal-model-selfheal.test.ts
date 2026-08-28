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

import { buildFactCheckProvidersWith } from '../src/hal/fact-check';
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
  'HAL_QUORUM_AUTOBACKFILL',
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
