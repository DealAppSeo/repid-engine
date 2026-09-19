/**
 * Pins the registry helper that replaced a template literal in the judge.
 * The URL shape must stay byte-identical to the former callsite.
 */
import { geminiGenerateContentUrl, PROVIDER_URLS } from '../src/egress/provider-hosts';

describe('provider-hosts registry', () => {
  it('geminiGenerateContentUrl preserves the former judge URL shape', () => {
    expect(geminiGenerateContentUrl('gemini-2.0-flash', 'k')).toBe(
      'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=k',
    );
  });

  it('exports the two distinct DeepSeek paths rather than collapsing them', () => {
    expect(PROVIDER_URLS.deepseekChatCompletions).toBe('https://api.deepseek.com/chat/completions');
    expect(PROVIDER_URLS.deepseekV1ChatCompletions).toBe(
      'https://api.deepseek.com/v1/chat/completions',
    );
    expect(PROVIDER_URLS.deepseekChatCompletions).not.toBe(PROVIDER_URLS.deepseekV1ChatCompletions);
  });
});
