/**
 * BYO / local-model base-URL override for the HAL quorum.
 *
 * Pins that LOCAL_LLM_BASE_URL redirects openai-compat providers to a local
 * model, leaves anthropic-native untouched, and is a no-op when unset (hosted
 * behavior unchanged). Pure/offline.
 */
import {
  toChatCompletionsEndpoint,
  resolveProviderEndpoint,
} from '../src/hal/local-llm';

const GROQ = 'https://api.groq.com/openai/v1/chat/completions';
const ANTHROPIC = 'https://api.anthropic.com/v1/messages';

describe('toChatCompletionsEndpoint', () => {
  test.each([
    ['http://localhost:11434/v1', 'http://localhost:11434/v1/chat/completions'],
    ['http://localhost:11434/v1/', 'http://localhost:11434/v1/chat/completions'],
    ['http://localhost:8000', 'http://localhost:8000/chat/completions'],
    ['http://vllm:8000/v1', 'http://vllm:8000/v1/chat/completions'],
  ])('base %s -> %s', (base, expected) => {
    expect(toChatCompletionsEndpoint(base)).toBe(expected);
  });

  test('idempotent when already a full chat/completions URL', () => {
    const full = 'http://localhost:11434/v1/chat/completions';
    expect(toChatCompletionsEndpoint(full)).toBe(full);
  });
});

describe('resolveProviderEndpoint', () => {
  test('no override -> default endpoint unchanged (hosted behavior)', () => {
    expect(resolveProviderEndpoint(GROQ, '', 'openai-compat')).toBe(GROQ);
  });

  test('override redirects an openai-compat provider to the local base', () => {
    expect(
      resolveProviderEndpoint(GROQ, 'http://localhost:11434/v1', 'openai-compat'),
    ).toBe('http://localhost:11434/v1/chat/completions');
  });

  test('anthropic-native is NEVER redirected (wrong wire shape for a local OpenAI server)', () => {
    expect(
      resolveProviderEndpoint(ANTHROPIC, 'http://localhost:11434/v1', 'anthropic-native'),
    ).toBe(ANTHROPIC);
  });

  test('whitespace-only override is treated as unset', () => {
    expect(resolveProviderEndpoint(GROQ, '   ', 'openai-compat')).toBe(GROQ);
  });
});
