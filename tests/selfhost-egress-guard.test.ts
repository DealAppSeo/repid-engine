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
  assertLocalDataStore,
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

// IP ranges apply only to IP literals. A DNS name that merely STARTS like a private IP
// ('127.evil.example') resolves wherever its owner points it, so it is remote.
describe('egress-guard: isLocalHost classifies the parsed host, not a string prefix', () => {
  test.each([
    'http://127.evil.example/v1',
    'http://10.0.0.1.nip.io/v1',
    'http://192.168.x.example/v1',
    'http://172.16.evil.example/v1',
    'http://169.254.evil.example/v1',
    'http://localhost.evil.example/v1',
    'http://127.0.0.1@evil.example/v1', // userinfo: the host is evil.example
    'http://172.15.0.1/v1', // just outside 172.16/12
    'http://172.32.0.1/v1',
    'postgresql://u:p@010.0.0.1:5432/db', // opaque host; libc may read 010 as octal 8
  ])('refuses %s', (url) => {
    expect(isLocalHost(url)).toBe(false);
  });

  test.each([
    'http://127.0.0.1:11434/v1',
    'http://[::1]:11434/v1', // WHATWG hostname is '[::1]', brackets included
    'http://10.1.2.3:8000/v1',
    'http://192.168.1.10:8000/v1',
    'http://172.20.0.5:8000/v1',
    'http://169.254.1.1:8000/v1',
    'http://0.0.0.0:8000/v1',
    'http://localhost:11434/v1',
    'http://foo.localhost:11434/v1',
    'http://host.docker.internal:11434/v1',
    'http://ollama:11434/v1',
    'http://vllm:8000/v1',
    'http://llama-cpp:8080/v1',
    'redis://[::1]:6379',
    'postgresql://u:p@127.0.0.1:5432/db',
  ])('keeps %s local', (url) => {
    expect(isLocalHost(url)).toBe(true);
  });

  test('every boundary check built on it refuses a prefix-spoofed host', () => {
    expect(() => assertPromptEgressAllowed('http://127.evil.example/v1/chat/completions', 'prompt', true)).toThrow(
      EgressBoundaryError,
    );
    expect(() => assertLocalDataStore('postgresql://u:p@10.0.0.1.nip.io:5432/db', 'DATABASE_URL', true)).toThrow(
      EgressBoundaryError,
    );
    expect(() => assertLocalDataStore('redis://192.168.attacker.example:6379', 'REDIS_URL', true)).toThrow(
      EgressBoundaryError,
    );
    expect(() => assertLocalDataStore('redis://[::1]:6379', 'REDIS_URL', true)).not.toThrow();
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
