import {
  encryptPrivateKey,
  decryptPrivateKey,
  KEY_VERSION,
} from '../src/services/agent-key-crypto';

const SAMPLE_PK = '0x' + 'ab'.repeat(32); // well-formed 32-byte private key

describe('agent-key-crypto (AES-256-GCM custody)', () => {
  const originalMaster = process.env.AGENT_KEY_MASTER;

  beforeEach(() => {
    process.env.AGENT_KEY_MASTER = 'a'.repeat(64); // 64 hex chars → 32-byte key
  });

  afterAll(() => {
    if (originalMaster === undefined) delete process.env.AGENT_KEY_MASTER;
    else process.env.AGENT_KEY_MASTER = originalMaster;
  });

  it('round-trips a private key', () => {
    const blob = encryptPrivateKey(SAMPLE_PK);
    expect(blob.v).toBe(KEY_VERSION);
    expect(typeof blob.iv).toBe('string');
    expect(typeof blob.tag).toBe('string');
    expect(typeof blob.ciphertext).toBe('string');
    // ciphertext must not leak the plaintext
    expect(blob.ciphertext).not.toContain(SAMPLE_PK);

    const decrypted = decryptPrivateKey(blob);
    expect(decrypted).toBe(SAMPLE_PK);
  });

  it('produces a fresh IV per encryption (non-deterministic ciphertext)', () => {
    const a = encryptPrivateKey(SAMPLE_PK);
    const b = encryptPrivateKey(SAMPLE_PK);
    expect(a.iv).not.toBe(b.iv);
    expect(a.ciphertext).not.toBe(b.ciphertext);
    expect(decryptPrivateKey(a)).toBe(SAMPLE_PK);
    expect(decryptPrivateKey(b)).toBe(SAMPLE_PK);
  });

  it('accepts a long non-hex master key (sha256-derived)', () => {
    process.env.AGENT_KEY_MASTER = 'this-is-a-demo-master-key-at-least-32-chars-long';
    const blob = encryptPrivateKey(SAMPLE_PK);
    expect(decryptPrivateKey(blob)).toBe(SAMPLE_PK);
  });

  it('throws when master key is missing/too short', () => {
    process.env.AGENT_KEY_MASTER = 'short';
    expect(() => encryptPrivateKey(SAMPLE_PK)).toThrow(/AGENT_KEY_MASTER/);
    delete process.env.AGENT_KEY_MASTER;
    expect(() => encryptPrivateKey(SAMPLE_PK)).toThrow(/AGENT_KEY_MASTER/);
  });

  it('fails authentication on tampered ciphertext', () => {
    const blob = encryptPrivateKey(SAMPLE_PK);
    const tampered = { ...blob, ciphertext: Buffer.from('deadbeef', 'hex').toString('base64') };
    expect(() => decryptPrivateKey(tampered)).toThrow();
  });

  it('rejects an unsupported version', () => {
    const blob = encryptPrivateKey(SAMPLE_PK);
    expect(() => decryptPrivateKey({ ...blob, v: 999 })).toThrow(/unsupported/);
  });

  it('rejects decrypting under the wrong master key', () => {
    const blob = encryptPrivateKey(SAMPLE_PK);
    process.env.AGENT_KEY_MASTER = 'b'.repeat(64); // different key
    expect(() => decryptPrivateKey(blob)).toThrow();
  });
});
