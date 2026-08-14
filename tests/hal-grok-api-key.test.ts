/**
 * Regression lock for the Grok escalation env-name bug (2026-08-09).
 *
 * `grokTiebreak` and both HAL_ESCALATE_GROK gates read the xAI key. `.env.master` stores it as
 * `XAI_API_KEY` — the standard xAI env name — but the code read ONLY `GROK_API_KEY`, so wherever
 * that inventory is the source `HAL_ESCALATE_GROK=true` was a SILENT NO-OP: zero escalations, the
 * entire precision lever dead. `grokApiKey()` now resolves `XAI_API_KEY || GROK_API_KEY`. These
 * tests lock that both names work and that the canonical name wins, so it can never silently die.
 *
 * The two inventories disagree, which is why BOTH names must keep working: Railway supplies
 * `GROK_API_KEY` only [V 2026-08-14]. An earlier version of this header said Railway used
 * `XAI_API_KEY`; that was never verified and is wrong.
 *
 * PRECEDENCE FLIPPED 2026-08-14. The first fix read `GROK_API_KEY || XAI_API_KEY`, which disagreed
 * with `scripts/dispatch/run-agent.mjs` (`['XAI_API_KEY', 'GROK_API_KEY']`). Same two names, opposite
 * order: with both vars set to different values, HAL and XC would authenticate as different
 * principals. `.env.master` was canonicalised to `XAI_API_KEY` (#398), so XAI is the canonical name
 * on both code surfaces now, and `tests/grok-key-precedence-parity.test.ts` keeps them that way.
 */
import { grokApiKey } from '../src/hal/fact-check';

describe('grokApiKey() — xAI key resolution (env-name bug regression)', () => {
  const saved = { grok: process.env.GROK_API_KEY, xai: process.env.XAI_API_KEY };
  afterEach(() => {
    process.env.GROK_API_KEY = saved.grok;
    process.env.XAI_API_KEY = saved.xai;
  });

  it('resolves the canonical XAI_API_KEY when GROK_API_KEY is unset (the bug)', () => {
    delete process.env.GROK_API_KEY;
    process.env.XAI_API_KEY = 'xai-abc';
    expect(grokApiKey()).toBe('xai-abc');
  });

  it('resolves the legacy GROK_API_KEY when it is the only one set', () => {
    process.env.GROK_API_KEY = 'grok-legacy';
    delete process.env.XAI_API_KEY;
    expect(grokApiKey()).toBe('grok-legacy');
  });

  it('prefers XAI_API_KEY over GROK_API_KEY when both are set (same principal as the XC dispatcher)', () => {
    process.env.GROK_API_KEY = 'grok-legacy';
    process.env.XAI_API_KEY = 'xai-abc';
    expect(grokApiKey()).toBe('xai-abc');
  });

  it('returns undefined (lever stays off, fail-safe) when neither is set', () => {
    delete process.env.GROK_API_KEY;
    delete process.env.XAI_API_KEY;
    expect(grokApiKey()).toBeUndefined();
  });

  it('treats a blank/whitespace key as absent (no accidental empty-string enable)', () => {
    process.env.GROK_API_KEY = '   ';
    delete process.env.XAI_API_KEY;
    expect(grokApiKey()).toBeUndefined();
  });

  it('falls through to GROK_API_KEY when the canonical XAI_API_KEY is present but blank', () => {
    // A blank canonical must not SHADOW a real legacy key — that would be the
    // silent no-op again, just one env var further along.
    process.env.XAI_API_KEY = '  ';
    process.env.GROK_API_KEY = 'grok-legacy';
    expect(grokApiKey()).toBe('grok-legacy');
  });
});
