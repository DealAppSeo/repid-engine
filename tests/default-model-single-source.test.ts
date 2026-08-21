/**
 * ONE table of default models, not four.
 *
 * WHAT THIS PREVENTS, measured 2026-08-21
 * ---------------------------------------
 * The model each provider uses by default was written down in FOUR places: the adapter
 * source literals, `ADAPTER_DEFAULT_MODELS`, a hand-maintained `switch` in route.ts, and
 * the `/api/v1/llm/providers` listing. Three of them disagreed:
 *
 *   provider     ADAPTER_DEFAULT_MODELS      switch + /providers listing
 *   gemini       gemini-1.5-flash            gemini-2.0-flash
 *   anthropic    claude-3-5-haiku-20241022   claude-haiku-4-5
 *   openrouter   qwen/qwen-2.5-72b-instruct  meta-llama/llama-3.3-70b-instruct:free
 *
 * `/api/v1/llm/providers` is a PUBLIC listing, so those disagreements were published as
 * fact. Nobody noticed because nothing compared them — `ADAPTER_DEFAULT_MODELS` was
 * drift-tested against the adapters, and the other two copies were checked by nothing at
 * all. They were asserted once and then quietly aged.
 *
 * The cost became concrete when Groq shut down `llama-3.1-8b-instant` on 2026-08-16:
 * fixing the router would have left two other places still advertising the dead model.
 *
 * `tests/routing-cost-class.test.ts` guards table-vs-adapter drift. This file guards the
 * other direction — that no SECOND table reappears alongside it.
 */
import fs from 'fs';
import path from 'path';
import { ADAPTER_DEFAULT_MODELS } from '../src/providers/cost-class';
import { getDefaultModelForProvider } from '../src/routes/route';

const ROUTE_TS = path.join(__dirname, '..', 'src', 'routes', 'route.ts');

describe('getDefaultModelForProvider resolves from the one canonical table', () => {
  it.each(Object.keys(ADAPTER_DEFAULT_MODELS))(
    '%s matches ADAPTER_DEFAULT_MODELS exactly',
    (provider) => {
      expect(getDefaultModelForProvider(provider)).toBe(ADAPTER_DEFAULT_MODELS[provider]);
    },
  );

  // These are served locally; the provider name IS the model id, so there is no vendor
  // catalogue for them to drift against and no table entry to look up.
  it.each(['llama-3-2-1b', 'gemma-3-2b', 'phi-4'])('%s is identity-mapped', (slm) => {
    expect(getDefaultModelForProvider(slm)).toBe(slm);
  });

  it('an unrecognised provider reports absence, not a plausible-looking value', () => {
    // 'unknown', never 'default': in a log column, a model literally named "default"
    // and "we could not resolve this" must not be the same string.
    expect(getDefaultModelForProvider('not-a-real-provider')).toBe('unknown');
    expect(getDefaultModelForProvider('')).toBe('unknown');
  });
});

describe('a <PROVIDER>_MODEL override reaches every surface, not just routing', () => {
  const KEY = 'GROQ_MODEL';
  const original = process.env[KEY];
  afterEach(() => {
    if (original === undefined) delete process.env[KEY];
    else process.env[KEY] = original;
    jest.resetModules();
  });

  it('is reflected here, so the public listing cannot advertise a model we stopped using', () => {
    process.env[KEY] = 'some-other-model-id';
    // Re-require: `defaultModelFor` memoises its one-per-process log line, not the value,
    // so the read is live — but resetModules keeps this honest if that ever changes.
    jest.resetModules();
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { getDefaultModelForProvider: fresh } = require('../src/routes/route');
    expect(fresh('groq')).toBe('some-other-model-id');
  });
});

describe('no second table reappears', () => {
  const src = fs.readFileSync(ROUTE_TS, 'utf8');

  it('the /providers listing hardcodes no model id', () => {
    // Every `default_model:` must be a call, never a literal. A literal here is a new
    // copy of the table, and it is published to the public listing.
    const literals = src.match(/default_model:\s*["'][^"']+["']/g) ?? [];
    expect(literals).toEqual([]);
  });

  it('route.ts contains no switch-style provider→model mapping', () => {
    // The shape that was removed: `case 'groq': return 'llama-3.1-8b-instant';`
    const caseReturns = src.match(/case\s+['"][a-z0-9.-]+['"]\s*:\s*return\s+['"][^'"]+['"]/gi) ?? [];
    expect(caseReturns).toEqual([]);
  });

  it('the retired Groq model appears in no CODE path, only in prose', () => {
    // Groq shut this down 2026-08-16. An occurrence in executable code is a copy that
    // outlived the model; an occurrence in a comment is the history of why, and banning
    // that would delete the explanation along with the bug.
    //
    // The first draft of this test asserted on the raw file and failed on its own
    // doc comment — the guard was right that the string was present and wrong about
    // what that meant. Strip comments, then assert.
    const code = src
      .replace(/\/\*[\s\S]*?\*\//g, '') // block comments, including JSDoc
      .replace(/^\s*\/\/.*$/gm, ''); // whole-line // comments
    expect(code).not.toContain('llama-3.1-8b-instant');
  });
});
