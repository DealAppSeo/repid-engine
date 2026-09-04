import {
  encryptPrivateKey,
  decryptPrivateKey,
  rotateEncryptedKey,
  currentKeyVersion,
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

  it('refuses a version whose master key is not provisioned', () => {
    // WAS `toThrow(/unsupported/)`. The PROPERTY is unchanged and is the one that
    // matters: an unknown generation still fails closed, never silently decrypts.
    // Only the reason moved. Before, every version but 1 was rejected on principle,
    // which is also what made rotation impossible. Now it is rejected because its
    // key is absent — and the message names the variable to restore, which is the
    // error an operator actually hits mid-rotation.
    const blob = encryptPrivateKey(SAMPLE_PK);
    expect(() => decryptPrivateKey({ ...blob, v: 999 })).toThrow(/AGENT_KEY_MASTER_V999/);
  });

  it('still rejects a malformed version outright', () => {
    const blob = encryptPrivateKey(SAMPLE_PK);
    for (const v of [0, -1, 1.5, NaN]) {
      expect(() => decryptPrivateKey({ ...blob, v: v as number })).toThrow(/unsupported/);
    }
  });

  it('rejects decrypting under the wrong master key', () => {
    const blob = encryptPrivateKey(SAMPLE_PK);
    process.env.AGENT_KEY_MASTER = 'b'.repeat(64); // different key
    expect(() => decryptPrivateKey(blob)).toThrow();
  });
});

/**
 * MASTER-KEY ROTATION.
 *
 * The module header promised "rotation can decrypt-old / re-encrypt-new" from the
 * day it was written, and `decryptPrivateKey` threw on any `blob.v !== 1`. So the
 * moment you rotated and began writing v2, every v1 blob became permanently
 * unreadable by the only code that could have re-encrypted it — a compromised
 * master key had no remediation but abandoning every custodied wallet.
 *
 * These pin the whole procedure, not just the happy path: that an old blob is
 * still readable while its key is provisioned, that a sweep is idempotent, and —
 * the one that matters most — that retiring the old key too early fails LOUD
 * rather than returning something wrong.
 */
describe('agent-key-crypto (master-key rotation)', () => {
  const OLD = 'a'.repeat(64);
  const NEW = 'c'.repeat(64);
  const saved = { ...process.env };

  afterEach(() => {
    process.env = { ...saved };
  });

  /** Encrypt under generation 1, then move the deployment to generation 2. */
  function blobFromGen1() {
    process.env.AGENT_KEY_MASTER = OLD;
    delete process.env.AGENT_KEY_MASTER_VERSION;
    const blob = encryptPrivateKey(SAMPLE_PK);
    expect(blob.v).toBe(1);

    process.env.AGENT_KEY_MASTER_V1 = OLD; // step 1: keep the outgoing key
    process.env.AGENT_KEY_MASTER = NEW; // step 2: the incoming key
    process.env.AGENT_KEY_MASTER_VERSION = '2';
    return blob;
  }

  it('an unrotated deployment is unchanged: version 1 from AGENT_KEY_MASTER alone', () => {
    process.env.AGENT_KEY_MASTER = OLD;
    delete process.env.AGENT_KEY_MASTER_VERSION;
    expect(currentKeyVersion()).toBe(1);
    const blob = encryptPrivateKey(SAMPLE_PK);
    expect(blob.v).toBe(1);
    expect(decryptPrivateKey(blob)).toBe(SAMPLE_PK);
  });

  it('reads an old-generation blob while its key is still provisioned', () => {
    const old = blobFromGen1();
    // This is the assertion the old equality check made impossible.
    expect(decryptPrivateKey(old)).toBe(SAMPLE_PK);
  });

  it('new writes go to the new generation', () => {
    blobFromGen1();
    expect(currentKeyVersion()).toBe(2);
    expect(encryptPrivateKey(SAMPLE_PK).v).toBe(2);
  });

  it('rotates an old blob to the current generation, preserving the key', () => {
    const old = blobFromGen1();
    const r = rotateEncryptedKey(old);
    expect(r.rotated).toBe(true);
    expect(r.fromVersion).toBe(1);
    expect(r.toVersion).toBe(2);
    expect(r.blob.v).toBe(2);
    expect(r.blob.ciphertext).not.toBe(old.ciphertext);
    // The whole point: same secret out the other side.
    expect(decryptPrivateKey(r.blob)).toBe(SAMPLE_PK);
  });

  it('the rotated blob no longer needs the retired key', () => {
    const old = blobFromGen1();
    const rotated = rotateEncryptedKey(old).blob;
    delete process.env.AGENT_KEY_MASTER_V1; // step 4: retire the old key
    expect(decryptPrivateKey(rotated)).toBe(SAMPLE_PK);
  });

  it('is idempotent, so a partially-failed sweep can be re-run', () => {
    const old = blobFromGen1();
    const once = rotateEncryptedKey(old);
    const twice = rotateEncryptedKey(once.blob);
    expect(twice.rotated).toBe(false);
    // Returned UNCHANGED, not re-encrypted: churning current ciphertext would make
    // "how many rows are left" unanswerable.
    expect(twice.blob).toBe(once.blob);
    expect(decryptPrivateKey(twice.blob)).toBe(SAMPLE_PK);
  });

  it('FAILS LOUD, naming the variable, if the old key was retired too early', () => {
    const old = blobFromGen1();
    delete process.env.AGENT_KEY_MASTER_V1; // the step an operator skips
    expect(() => rotateEncryptedKey(old)).toThrow(/AGENT_KEY_MASTER_V1/);
    // Never a silent pass, and never a wrong plaintext.
    expect(() => decryptPrivateKey(old)).toThrow(/AGENT_KEY_MASTER_V1/);
  });

  it('refuses a nonsense generation rather than guessing', () => {
    process.env.AGENT_KEY_MASTER = OLD;
    for (const bad of ['0', '-2', 'two', '1.5']) {
      process.env.AGENT_KEY_MASTER_VERSION = bad;
      expect(() => currentKeyVersion()).toThrow(/positive integer/);
    }
  });
});
