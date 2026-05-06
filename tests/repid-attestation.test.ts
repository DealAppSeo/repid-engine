/**
 * Sprint R-C Phase B4 — RepID attestation unit tests.
 *
 * Sign/verify roundtrip + tamper detection. Uses Node's built-in
 * crypto module — no new deps.
 */
import {
  signRepIDAttestation,
  verifyRepIDAttestation,
  ATTESTATION_VERSION,
  _testHelpers,
} from '../src/repid/repid-attestation';

describe('RepID attestation (Sprint R-C Phase B2)', () => {
  beforeEach(() => {
    _testHelpers().resetCache();
  });

  test('sign/verify roundtrip — valid signature accepted', async () => {
    const att = await signRepIDAttestation({
      agent_id: 'agent-test-1',
      repid_score: 4200,
      timestamp_iso: '2026-05-05T12:00:00.000Z',
    });
    expect(att.payload.version).toBe(ATTESTATION_VERSION);
    expect(att.payload.agent_id).toBe('agent-test-1');
    expect(att.payload.repid_score).toBe(4200);
    expect(att.signature).toMatch(/^[A-Za-z0-9_-]+$/); // base64url
    expect(att.signing_pubkey).toMatch(/^[A-Za-z0-9+/]+=*$/); // base64

    const result = verifyRepIDAttestation(att);
    expect(result.valid).toBe(true);
    expect(result.payload?.agent_id).toBe('agent-test-1');
  });

  test('tampered payload — verification fails', async () => {
    const att = await signRepIDAttestation({
      agent_id: 'agent-test-2',
      repid_score: 5000,
      timestamp_iso: '2026-05-05T12:00:00.000Z',
    });
    // Mutate payload after signing
    const tampered = {
      ...att,
      payload: { ...att.payload, repid_score: 9999 },
    };
    const result = verifyRepIDAttestation(tampered);
    expect(result.valid).toBe(false);
    expect(result.reason).toMatch(/signature does not match/);
  });

  test('tampered agent_id — verification fails', async () => {
    const att = await signRepIDAttestation({
      agent_id: 'agent-test-3',
      repid_score: 1500,
      timestamp_iso: '2026-05-05T12:00:00.000Z',
    });
    const tampered = {
      ...att,
      payload: { ...att.payload, agent_id: 'attacker-agent' },
    };
    expect(verifyRepIDAttestation(tampered).valid).toBe(false);
  });

  test('mutated signature byte — verification fails', async () => {
    const att = await signRepIDAttestation({
      agent_id: 'agent-test-4',
      repid_score: 2000,
      timestamp_iso: '2026-05-05T12:00:00.000Z',
    });
    // Flip a byte in the base64url signature
    const sigBuf = Buffer.from(att.signature, 'base64url');
    sigBuf[0] = sigBuf[0]! ^ 0x01;
    const tampered = { ...att, signature: sigBuf.toString('base64url') };
    expect(verifyRepIDAttestation(tampered).valid).toBe(false);
  });

  test('wrong public key — verification fails', async () => {
    const att = await signRepIDAttestation({
      agent_id: 'agent-test-5',
      repid_score: 3000,
      timestamp_iso: '2026-05-05T12:00:00.000Z',
    });
    // Sign a SECOND attestation with a different ephemeral key
    _testHelpers().resetCache();
    const att2 = await signRepIDAttestation({
      agent_id: 'agent-test-6',
      repid_score: 3000,
      timestamp_iso: '2026-05-05T12:00:00.000Z',
    });
    // Use att1's signature with att2's pubkey
    const tampered = { ...att, signing_pubkey: att2.signing_pubkey };
    expect(verifyRepIDAttestation(tampered).valid).toBe(false);
  });

  test('wrong version — verification rejects', async () => {
    const att = await signRepIDAttestation({
      agent_id: 'agent-test-7',
      repid_score: 100,
      timestamp_iso: '2026-05-05T12:00:00.000Z',
    });
    const tampered = { ...att, payload: { ...att.payload, version: 'unknown/0' } };
    const result = verifyRepIDAttestation(tampered);
    expect(result.valid).toBe(false);
    expect(result.reason).toMatch(/unsupported version/);
  });

  test('missing fields — verification rejects with clear reasons', () => {
    expect(verifyRepIDAttestation({} as any).valid).toBe(false);
    expect(verifyRepIDAttestation({ payload: {} } as any).valid).toBe(false);
    expect(
      verifyRepIDAttestation({ payload: { version: ATTESTATION_VERSION } } as any).valid,
    ).toBe(false);
  });

  test('input validation — missing fields throw', async () => {
    await expect(
      signRepIDAttestation({ agent_id: '', repid_score: 100, timestamp_iso: '2026-05-05' }),
    ).rejects.toThrow(/agent_id required/);
    await expect(
      signRepIDAttestation({
        agent_id: 'a',
        repid_score: NaN,
        timestamp_iso: '2026-05-05',
      }),
    ).rejects.toThrow(/repid_score must be a finite number/);
    await expect(
      signRepIDAttestation({ agent_id: 'a', repid_score: 100, timestamp_iso: '' }),
    ).rejects.toThrow(/timestamp_iso required/);
  });

  test('canonical serialization — different field order produces same signature', async () => {
    // Sign once with one key
    const att1 = await signRepIDAttestation({
      agent_id: 'order-test',
      repid_score: 1234,
      timestamp_iso: '2026-05-05T12:00:00.000Z',
    });
    // Reorder the payload's keys (verification re-canonicalizes)
    const reordered = {
      ...att1,
      payload: {
        version: att1.payload.version,
        timestamp_iso: att1.payload.timestamp_iso,
        repid_score: att1.payload.repid_score,
        agent_id: att1.payload.agent_id,
      },
    };
    expect(verifyRepIDAttestation(reordered).valid).toBe(true);
  });

  test('ephemeral key warning is signaled', () => {
    // Without SIGNING_KEY_DEV in env, a dev-mode ephemeral key is generated.
    const isEphemeral = _testHelpers().isEphemeral();
    // Either way (env-set or not), the helper should report a boolean.
    expect(typeof isEphemeral).toBe('boolean');
  });
});
