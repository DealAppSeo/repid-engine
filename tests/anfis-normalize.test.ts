/**
 * S-2026-06-04 — the ANFIS RPC aggregates repid_score_events.llm_provider (answer-provider names),
 * which never matched the router's adapter names → findIndex=-1 → ANFIS reorder was a silent no-op.
 * normalizeToAdapter maps an arbitrary provider/model name to a router adapter (or null if none maps).
 */
import { normalizeToAdapter } from '../src/providers/router';

describe('normalizeToAdapter', () => {
  it('maps adapter names through unchanged', () => {
    for (const a of ['groq', 'cerebras', 'gemini', 'cohere', 'deepseek', 'anthropic', 'openai']) {
      expect(normalizeToAdapter(a)).toBe(a);
    }
  });
  it('maps answer-provider/model names to the right adapter', () => {
    expect(normalizeToAdapter('llama-3.1-8b-instant')).toBe('groq');
    expect(normalizeToAdapter('zai-glm-4.7')).toBe('cerebras');
    expect(normalizeToAdapter('gemini-2.0-flash')).toBe('gemini');
    expect(normalizeToAdapter('command-r')).toBe('cohere');
    expect(normalizeToAdapter('deepseek-chat')).toBe('deepseek');
    expect(normalizeToAdapter('claude-haiku-4-5')).toBe('anthropic');
    expect(normalizeToAdapter('gpt-4o-mini')).toBe('openai');
  });
  it('returns null for providers with no router adapter (the old findIndex=-1 cases)', () => {
    expect(normalizeToAdapter('deepinfra')).toBeNull();
    expect(normalizeToAdapter('togetherai')).toBeNull();
    expect(normalizeToAdapter('gemini/test-model')).toBe('gemini'); // still maps via substring
    expect(normalizeToAdapter('unknown')).toBeNull();
    expect(normalizeToAdapter('')).toBeNull();
  });
});
