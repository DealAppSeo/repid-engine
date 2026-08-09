/**
 * Regression lock for the Grok escalation env-name bug (2026-08-09).
 *
 * `grokTiebreak` and both HAL_ESCALATE_GROK gates read the xAI key. The key is stored in the wallet
 * inventory (.env.master / Railway) as `XAI_API_KEY` — the standard xAI env name — but the code read
 * ONLY `GROK_API_KEY`, so `HAL_ESCALATE_GROK=true` was a SILENT NO-OP: zero escalations, the entire
 * precision lever dead. `grokApiKey()` now resolves `GROK_API_KEY || XAI_API_KEY`. These tests lock
 * that both names work and that the canonical name still wins, so the lever can never silently die again.
 */
import { grokApiKey } from '../src/hal/fact-check';

describe('grokApiKey() — xAI key resolution (env-name bug regression)', () => {
  const saved = { grok: process.env.GROK_API_KEY, xai: process.env.XAI_API_KEY };
  afterEach(() => {
    process.env.GROK_API_KEY = saved.grok;
    process.env.XAI_API_KEY = saved.xai;
  });

  it('resolves the standard xAI name XAI_API_KEY when GROK_API_KEY is unset (the bug)', () => {
    delete process.env.GROK_API_KEY;
    process.env.XAI_API_KEY = 'xai-abc';
    expect(grokApiKey()).toBe('xai-abc');
  });

  it('resolves the canonical GROK_API_KEY when set', () => {
    process.env.GROK_API_KEY = 'grok-canonical';
    delete process.env.XAI_API_KEY;
    expect(grokApiKey()).toBe('grok-canonical');
  });

  it('prefers GROK_API_KEY over XAI_API_KEY when both are set (no behavior change where GROK_API_KEY exists)', () => {
    process.env.GROK_API_KEY = 'grok-canonical';
    process.env.XAI_API_KEY = 'xai-abc';
    expect(grokApiKey()).toBe('grok-canonical');
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
});
