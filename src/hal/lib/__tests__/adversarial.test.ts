/**
 * Sprint C Phase 4 — Synthetic Adversarial Unit Tests
 *
 * Three tests probing whether L4+ and L5 mechanisms FIRE WHEN PROPERLY
 * STIMULATED. The morning's empirical data showed claim_vs_consensus and
 * tampering at 0/30 firing rate on 150 clean evals. These tests settle
 * the question: is that "no triggers in dataset" or "wiring bugs"?
 *
 * IMPORTANT — this test file lives at src/hal/lib/__tests__/ which is
 * NOT picked up by `npm test` (jest.config.js pins roots to tests/ only).
 * Run explicitly with:
 *
 *     npx jest --config jest.config.js --roots=src/hal/lib/__tests__ \
 *         src/hal/lib/__tests__/adversarial.test.ts
 *
 * Per Sprint C constraints: do NOT fix bugs found here. Failing tests get
 * .skip with KNOWN FAILURE comments; the failures themselves are the
 * finding.
 */
import { evaluate } from '../evaluate';
import type { HALContext, HALProviderConfig } from '../types';

function stubProvider(provider: string, model: string): HALProviderConfig {
  return {
    provider,
    model,
    // Endpoint contains the provider name so the fetch mock can route by URL.
    endpoint: `https://stub.example.invalid/${provider}/v1/chat/completions`,
    apiKey: 'stub-key',
    callType: 'openai-compat',
    timeoutMs: 1000,
  };
}

/**
 * Drive deterministic provider answers via a fetch stub. Each provider
 * is matched by URL. Returns OpenAI-compat response shape (or anthropic-
 * native when system+messages present).
 */
function mockFetchByProviderUrl(answersByProvider: Record<string, string>): void {
  global.fetch = jest.fn(async (url: any, init?: any) => {
    const u = String(url);
    let answer = '';
    for (const [providerKey, text] of Object.entries(answersByProvider)) {
      if (u.includes(providerKey)) {
        answer = text;
        break;
      }
    }
    const body = init?.body ? JSON.parse(init.body) : {};
    const isAnthropicNative = body?.system !== undefined && body?.messages !== undefined;
    if (isAnthropicNative) {
      return {
        ok: true,
        json: async () => ({ content: [{ type: 'text', text: answer }] }),
        text: async () => '',
      } as any;
    }
    return {
      ok: true,
      json: async () => ({ choices: [{ message: { content: answer } }] }),
      text: async () => '',
    } as any;
  }) as any;
}

function buildContext(strictness: 1 | 2 | 3 | 4 | 5): HALContext {
  return {
    domain: 'factual',
    certainty: 0.95,
    prompt: 'placeholder — set per test',
    providers: [
      stubProvider('groq', 'llama-3.3-70b'),
      stubProvider('cerebras', 'llama3.1-8b'),
      stubProvider('openai', 'gpt-4o-mini'),
    ],
    classifierProvider: null, // skip classifier so gate doesn't filter
    embeddingClient: null,    // Jaccard fallback — deterministic
    strictness,
  };
}

describe('Sprint C — Synthetic Adversarial Tests', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  /* ====================================================================== *
   * TEST 1 — Within-answer numerical inconsistency (tampering trigger?)
   *
   * Hypothesis: HAL's tampering signal fires when CROSS-PROVIDER agreement
   * is too tight (> 0.99 cosine). It does NOT inspect a single answer for
   * internal numerical contradictions. So this test is expected to FAIL:
   * the in-answer "$1M ... $10M" inconsistency is invisible to HAL because
   * HAL never tokenizes numerical claims.
   *
   * SKIPPED until/unless within-answer consistency is implemented.
   * ====================================================================== */
  it.skip(
    'TEST 1: within-answer numerical inconsistency triggers tampering at L5 — KNOWN FAILURE 2026-05-05: HAL does NOT inspect within-answer numerical consistency. Tampering signal is gated on inter-provider agreement only (zone=too-tight, similarity > 0.99). Within-answer inconsistency is an unimplemented capability. Sprint C diagnosis; fix deferred per CLAUDE-RULE-3.',
    async () => {
      const claim =
        'The deal closed at $1,000,000 in Q3, representing the largest transaction. ' +
        'The closing value of $10,000,000 set a new record for the firm.';
      mockFetchByProviderUrl({
        groq: 'Yes, that is consistent with public records.',
        cerebras: 'Confirmed.',
        openai: 'Verified.',
      });
      const ctx = buildContext(5);
      ctx.prompt = 'Is this deal-closure summary internally consistent?';
      const r = await evaluate(claim, claim, ctx);
      expect(r.tampering_suspected).toBe(true);
      expect(r.tampering_signal).not.toBeNull();
    },
  );

  /* ====================================================================== *
   * TEST 2 — Claim-vs-consensus with mocked providers giving correct answer
   *
   * Hypothesis: when 3 providers all give the CORRECT Pythagorean Comma
   * answer (531441:524288) and the user's CLAIM is wrong (256:243), the
   * claim-vs-consensus mechanism at L4 should detect contradiction and
   * set vetoed=true.
   *
   * Expected outcome: TEST EXPOSES GAP B — claim-comparison only runs when
   * agreement_zone === 'in-band' (similarity in [0.95, 0.99]). Three
   * varied-prose correct answers about the same fact land in too-loose
   * (Jaccard ~0.4) or too-tight (if identical) — rarely in-band. So
   * claim_vs_consensus_similarity stays null even though both providers
   * are correct and the claim is wrong.
   *
   * Variant A: 3 IDENTICAL provider answers → zone='too-tight' → no
   *            claim-comparison (gate prevents)
   * Variant B: 3 VARIED correct answers → zone='too-loose' → no
   *            claim-comparison (gate prevents)
   *
   * Both variants demonstrate the gate-too-tight problem. Test runs
   * Variant B and expects the GAP B behavior:
   *   claim_vs_consensus_similarity = null (claim-comparison gated off)
   *   vetoed = false (no contradiction detection ran)
   *
   * If HAL someday lowers the in-band gate or removes it, this test
   * should be updated to expect claim_contradicts_consensus = true.
   * ====================================================================== */
  it('TEST 2: GAP B — claim-vs-consensus does NOT fire on prose-varied correct answers (zone=too-loose blocks gate)', async () => {
    const claim =
      'The Pythagorean Comma is the ratio 256:243. This is a fundamental concept in music theory.';
    // Three correct answers in varied prose — Jaccard agreement ~0.4-0.6
    mockFetchByProviderUrl({
      groq: 'The Pythagorean Comma is approximately 23.46 cents and comes from the ratio 531441:524288.',
      cerebras: "It's about 23.5 cents derived from 531441/524288.",
      openai: 'The Pythagorean Comma equals 531441 divided by 524288, roughly 1.0136.',
    });
    const ctx = buildContext(4);
    ctx.prompt = 'What is the Pythagorean Comma in cents and what ratio does it come from?';
    const r = await evaluate(claim, claim, ctx);
    expect(r.cross_llm).not.toBeNull();
    // Document the gap: zone is NOT in-band on real prose-varied answers
    expect(r.agreement_zone).not.toBe('in-band');
    // Therefore claim-comparison was gated off — fields stay null
    expect(r.claim_vs_consensus_similarity).toBeNull();
    expect(r.claim_contradicts_consensus).toBeNull();
    // The contradiction is real (claim says 256:243, consensus says 531441:524288)
    // but the in-band gate at evaluate.ts:149 prevents detection.
    // Fix would be to widen the gate OR remove it OR check additional signals.
  });

  /* ====================================================================== *
   * TEST 2 VARIANT A — 3 identical answers → zone='too-tight'
   *
   * Even when zone IS far from too-loose, claim-comparison still doesn't
   * fire because the gate is exclusively `agreementZone === 'in-band'`.
   * Confirms the gate is the issue, not just the prose-variation distribution.
   * ====================================================================== */
  it('TEST 2-A: GAP B — claim-vs-consensus does NOT fire when zone=too-tight either', async () => {
    const claim =
      'The Pythagorean Comma is the ratio 256:243.';
    const correctAnswer =
      'The Pythagorean Comma is the ratio 531441:524288.';
    // All three providers return the EXACT SAME text → similarity = 1.0
    mockFetchByProviderUrl({
      groq: correctAnswer,
      cerebras: correctAnswer,
      openai: correctAnswer,
    });
    const ctx = buildContext(4);
    ctx.prompt = 'What is the Pythagorean Comma ratio?';
    const r = await evaluate(claim, claim, ctx);
    expect(r.cross_llm).not.toBeNull();
    // With identical answers, zone is too-tight (similarity > 0.99)
    expect(r.agreement_zone).toBe('too-tight');
    // Claim-comparison still gated off because zone !== 'in-band'
    expect(r.claim_vs_consensus_similarity).toBeNull();
  });

  /* ====================================================================== *
   * TEST 3 — Self-contradiction within single answer
   *
   * Claim text contains both "exactly 531441:524288" and "256:243,
   * mathematically equivalent" — the equivalence statement is false.
   *
   * Hypothesis: HAL's extractor doesn't tokenize numerical ratios for
   * equivalence checks. A self-contradicting claim is just longer text;
   * extractHALSignals scores it on harm/epistemic/evidence/scope without
   * any cross-numerical-claim consistency check.
   *
   * Expected: epistemic_uncertainty stays moderate (not elevated by the
   * contradiction), tampering_suspected stays null (cross-LLM may or may
   * not be tight). Test asserts that NEITHER the elevated-epistemic nor
   * the tampering signal fires — confirming self-contradiction detection
   * is not implemented.
   *
   * SKIPPED. Failure exposes the gap.
   * ====================================================================== */
  it.skip(
    'TEST 3: self-contradiction within answer triggers epistemic-elevated OR tampering — KNOWN FAILURE 2026-05-05: HAL extractor does NOT detect within-answer self-contradiction. extractHALSignals tokenizes for hedge/overconfidence markers but never checks for numerical/factual contradiction across sentences in the same answer. Sprint C diagnosis; fix deferred per CLAUDE-RULE-3.',
    async () => {
      const claim =
        'The Pythagorean Comma is exactly 531441:524288. ' +
        'Some sources also identify it as 256:243, which is mathematically equivalent.';
      // Cross-LLM gives correct, varied answers — should reach zone=too-loose
      mockFetchByProviderUrl({
        groq: 'The Pythagorean Comma is approximately 23.46 cents, ratio 531441:524288.',
        cerebras: 'It equals 531441/524288 in just intonation.',
        openai: 'Pythagorean Comma is 531441:524288, NOT equivalent to 256:243.',
      });
      const ctx = buildContext(5);
      ctx.prompt = 'What is the Pythagorean Comma?';
      const r = await evaluate(claim, claim, ctx);
      // Either elevated epistemic OR tampering should fire
      const elevatedEpistemic = (r.signals.epistemic_uncertainty ?? 0) > 0.6;
      const tampering = r.tampering_suspected === true;
      expect(elevatedEpistemic || tampering).toBe(true);
    },
  );

  /* ====================================================================== *
   * TEST 4 — Sanity-check that THE ORIGINAL tampering wiring WORKS via
   *          inter-provider tight collapse at L5.
   *
   * NOT in the Sprint C dispatch but added as a sanity check so we know
   * tampering_signal is not broken — it just doesn't fire on the v1 corpus
   * because real provider responses don't cluster that tightly.
   *
   * This passes (mirroring tests/hal-tampering.test.ts).
   * ====================================================================== */
  it('TEST 4 (sanity): tampering DOES fire at L5 when 3 providers return identical answers', async () => {
    const sameAnswer = 'The capital of France is Paris.';
    mockFetchByProviderUrl({
      groq: sameAnswer,
      cerebras: sameAnswer,
      openai: sameAnswer,
    });
    const ctx = buildContext(5);
    ctx.prompt = 'What is the capital of France?';
    const r = await evaluate(sameAnswer, sameAnswer, ctx);
    expect(r.cross_llm).not.toBeNull();
    expect(r.agreement_zone).toBe('too-tight');
    expect(r.tampering_suspected).toBe(true);
    expect(r.tampering_signal).not.toBeNull();
    expect(r.tampering_signal!.similarity).toBeGreaterThan(0.99);
  });
});
