import {
  gateOpenRouterModel,
  gateZaiModel,
  gateGeminiUnderHold,
  halAllowPaid,
  isFreeSlug,
  isFreeZaiModel,
  GEMINI_FREE_OPENROUTER_SLUG,
} from '../src/hal/hal-free-gate';

const PAID = 'qwen/qwen-2.5-72b-instruct';
const FREE = 'nvidia/nemotron-3-ultra-550b-a55b:free';

describe('hal-free-gate: halAllowPaid', () => {
  it('defaults to false when nothing is set', () => {
    expect(halAllowPaid({} as NodeJS.ProcessEnv)).toBe(false);
  });
  it.each(['', 'false', '0', 'hold', 'no', 'HOLD', 'False'])('treats %p as NOT paid', (v) => {
    expect(halAllowPaid({ SEAN_PAID_LOOP: v } as NodeJS.ProcessEnv)).toBe(false);
  });
  it('allows paid only when SEAN_PAID_LOOP is a real loop value', () => {
    expect(halAllowPaid({ SEAN_PAID_LOOP: 'loop3' } as NodeJS.ProcessEnv)).toBe(true);
  });
  it('accepts the legacy ALLOW_PAID knob', () => {
    expect(halAllowPaid({ ALLOW_PAID: 'true' } as NodeJS.ProcessEnv)).toBe(true);
  });
});

describe('hal-free-gate: isFreeSlug', () => {
  it('is true only for :free-suffixed slugs', () => {
    expect(isFreeSlug(FREE)).toBe(true);
    expect(isFreeSlug(PAID)).toBe(false);
    expect(isFreeSlug('qwen/qwen-2.5-72b-instruct:free')).toBe(true);
    expect(isFreeSlug(undefined)).toBe(false);
  });
});

describe('hal-free-gate: gateOpenRouterModel', () => {
  // REQUIRED PROOF 1 — allow_paid=false must REFUSE the paid default.
  it('refuses the paid default when allow_paid=false (no operator override)', () => {
    const r = gateOpenRouterModel({ operatorModel: undefined, paidDefault: PAID, freeDefault: FREE, allowPaid: false });
    expect(r.staticDefault).toBe(FREE);
    expect(r.staticDefault).not.toBe(PAID);
    expect(r.ignoreOperatorModel).toBe(true);
  });

  // REQUIRED PROOF 1b — a PAID operator override is refused too, not just the default.
  it('refuses a PAID HAL_S2_OPENROUTER_MODEL override when allow_paid=false', () => {
    const r = gateOpenRouterModel({ operatorModel: PAID, paidDefault: PAID, freeDefault: FREE, allowPaid: false });
    expect(r.staticDefault).toBe(FREE);
    expect(r.staticDefault).not.toBe(PAID);
    expect(r.ignoreOperatorModel).toBe(true);
    expect(r.reason).toMatch(/REFUSED/);
  });

  // REQUIRED PROOF 2 — a :free operator override IS used.
  it('uses a :free operator override when allow_paid=false', () => {
    const freeOverride = 'meta-llama/llama-3.3-70b-instruct:free';
    const r = gateOpenRouterModel({ operatorModel: freeOverride, paidDefault: PAID, freeDefault: FREE, allowPaid: false });
    expect(r.staticDefault).toBe(freeOverride);
    expect(isFreeSlug(r.staticDefault)).toBe(true);
  });

  // Current behaviour preserved when Sean authorises paid.
  it('keeps the paid default when allow_paid=true (operator override still honoured downstream)', () => {
    const r = gateOpenRouterModel({ operatorModel: undefined, paidDefault: PAID, freeDefault: FREE, allowPaid: true });
    expect(r.staticDefault).toBe(PAID);
    expect(r.ignoreOperatorModel).toBe(false);
  });

  // Invariant: under the hold, the resolved static default is ALWAYS free.
  it('never emits a paid staticDefault while allow_paid=false', () => {
    for (const op of [undefined, PAID, 'openai/gpt-4o', 'anthropic/claude-sonnet-4', FREE]) {
      const r = gateOpenRouterModel({ operatorModel: op, paidDefault: PAID, freeDefault: FREE, allowPaid: false });
      expect(isFreeSlug(r.staticDefault)).toBe(true);
    }
  });
});

describe('hal-free-gate: gateZaiModel', () => {
  const FLASH = 'glm-4.5-flash';
  it('pins Flash when allow_paid=false and catalog/operator would pick glm-5-turbo', () => {
    const r = gateZaiModel({ operatorModel: 'glm-5-turbo', freeDefault: FLASH, allowPaid: false });
    expect(r.staticDefault).toBe(FLASH);
    expect(r.ignoreOperatorModel).toBe(true);
    expect(r.reason).toMatch(/REFUSED/);
  });
  it('honours an operator Flash pin under the hold', () => {
    const r = gateZaiModel({ operatorModel: FLASH, freeDefault: FLASH, allowPaid: false });
    expect(r.staticDefault).toBe(FLASH);
    expect(isFreeZaiModel(r.staticDefault)).toBe(true);
  });
  it('allows glm-5-turbo only when allow_paid=true', () => {
    const r = gateZaiModel({ operatorModel: 'glm-5-turbo', freeDefault: FLASH, allowPaid: true });
    expect(r.staticDefault).toBe('glm-5-turbo');
    expect(r.ignoreOperatorModel).toBe(false);
  });
  it('treats turbo/pro as paid', () => {
    expect(isFreeZaiModel('glm-5-turbo')).toBe(false);
    expect(isFreeZaiModel('glm-4.7')).toBe(false);
    expect(isFreeZaiModel('glm-4.5-flash')).toBe(true);
  });
});

describe('hal-free-gate: gateGeminiUnderHold', () => {
  it('skips paid Gemini direct while allow_paid=false', () => {
    const r = gateGeminiUnderHold(false);
    expect(r.skipDirect).toBe(true);
    expect(isFreeSlug(r.openRouterFreeSlug)).toBe(true);
    expect(r.openRouterFreeSlug).toBe(GEMINI_FREE_OPENROUTER_SLUG);
  });
  it('permits direct Gemini when allow_paid=true', () => {
    expect(gateGeminiUnderHold(true).skipDirect).toBe(false);
  });
});

// REQUIRED PROOF 3 — "404 parks that hop" is NOT this module's job and is asserted here as a
// reference, not a new test: resolveModelFor()/add() in fact-check.ts already SKIP a provider whose
// resolved model is measured-dead (a 404'd slug → `isMeasuredDead` → add() returns false, provider
// not dialled). This gate only chooses the *slug*; the existing skip handles the dead-slug 404.
// See fact-check.ts add() (~1772) and the DEAD-SLUG FIX note (~2004). Left as a documented contract
// so the PR test-list is honest about which layer owns the 404 parking.
