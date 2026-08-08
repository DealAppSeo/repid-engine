/**
 * Data-locality egress boundary (ONLY_ATTESTATIONS_LEAVE).
 *
 * Pins the guarantee the self-host claim rests on: with the boundary engaged,
 * prompt/response TEXT cannot leave the box, while commitments (proofs, EAS
 * anchors, chain RPC) still can. Pure/offline — no network, no DB.
 */
import {
  isLocalHost,
  classifyEgress,
  assertPromptEgressAllowed,
  EgressBoundaryError,
} from '../src/selfhost/egress-guard';

describe('egress-guard: isLocalHost', () => {
  test.each([
    'http://localhost:11434/v1/chat/completions',
    'http://127.0.0.1:8000/v1/chat/completions',
    'http://ollama:11434/v1',
    'http://host.docker.internal:8000/v1',
    'http://192.168.1.50:11434/v1',
    'http://10.0.0.3:8000/v1',
    'http://172.16.4.4:8000/v1',
  ])('treats %s as local', (url) => {
    expect(isLocalHost(url)).toBe(true);
  });

  test.each([
    'https://api.groq.com/openai/v1/chat/completions',
    'https://api.deepseek.com/v1/chat/completions',
    'https://api.anthropic.com/v1/messages',
    'https://api.openai.com/v1/embeddings',
  ])('treats %s as remote', (url) => {
    expect(isLocalHost(url)).toBe(false);
  });

  test('an unparseable URL is treated as remote (fail-closed)', () => {
    expect(isLocalHost('not a url')).toBe(false);
  });
});

describe('egress-guard: classifyEgress with boundary ENGAGED', () => {
  const ON = true;

  test('BLOCKS prompt text to a cloud LLM', () => {
    const d = classifyEgress('https://api.groq.com/openai/v1/chat/completions', 'prompt', ON);
    expect(d.allowed).toBe(false);
    expect(d.reason).toMatch(/blocked/i);
  });

  test('BLOCKS embedding text to a cloud embedder', () => {
    const d = classifyEgress('https://api.openai.com/v1/embeddings', 'embedding', ON);
    expect(d.allowed).toBe(false);
  });

  test('ALLOWS prompt text to a LOCAL model', () => {
    const d = classifyEgress('http://localhost:11434/v1/chat/completions', 'prompt', ON);
    expect(d.allowed).toBe(true);
    expect(d.local).toBe(true);
  });

  test('ALLOWS an attestation (EAS) to leave — it is a commitment, not content', () => {
    const d = classifyEgress('https://base-sepolia.easscan.org/graphql', 'attestation', ON);
    expect(d.allowed).toBe(true);
    expect(d.reason).toMatch(/commitment/);
  });

  test('ALLOWS a chain RPC to leave — commitment, not content', () => {
    const d = classifyEgress('https://sepolia.base.org', 'chain', ON);
    expect(d.allowed).toBe(true);
  });
});

describe('egress-guard: boundary DISENGAGED = hosted behavior unchanged', () => {
  const OFF = false;

  test('cloud prompt egress is allowed when the flag is off', () => {
    const d = classifyEgress('https://api.groq.com/openai/v1/chat/completions', 'prompt', OFF);
    expect(d.allowed).toBe(true);
    expect(d.reason).toBe('boundary-off');
  });
});

describe('egress-guard: assertPromptEgressAllowed', () => {
  test('throws EgressBoundaryError on a blocked cloud prompt (explicit boundary on)', () => {
    expect(() =>
      assertPromptEgressAllowed('https://api.groq.com/openai/v1/chat/completions', 'prompt', true),
    ).toThrow(EgressBoundaryError);
  });

  test('does not throw for a local target', () => {
    expect(() =>
      assertPromptEgressAllowed('http://localhost:11434/v1/chat/completions', 'prompt', true),
    ).not.toThrow();
  });

  test('does not throw when boundary is off (default)', () => {
    expect(() =>
      assertPromptEgressAllowed('https://api.groq.com/openai/v1/chat/completions', 'prompt', false),
    ).not.toThrow();
  });

  test('reads ONLY_ATTESTATIONS_LEAVE from env when not passed explicitly', () => {
    const orig = process.env.ONLY_ATTESTATIONS_LEAVE;
    try {
      process.env.ONLY_ATTESTATIONS_LEAVE = 'true';
      expect(() =>
        assertPromptEgressAllowed('https://api.groq.com/openai/v1/chat/completions', 'prompt'),
      ).toThrow(EgressBoundaryError);
      process.env.ONLY_ATTESTATIONS_LEAVE = 'false';
      expect(() =>
        assertPromptEgressAllowed('https://api.groq.com/openai/v1/chat/completions', 'prompt'),
      ).not.toThrow();
    } finally {
      if (orig === undefined) delete process.env.ONLY_ATTESTATIONS_LEAVE;
      else process.env.ONLY_ATTESTATIONS_LEAVE = orig;
    }
  });
});
