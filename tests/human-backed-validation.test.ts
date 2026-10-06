/**
 * scripts/demo/human-backed-validation.ts: the ERC-8004 Validation Registry request and response
 * files for "a member of this group controls agentId". The proof itself is tested in Rust
 * (zkp-vault/tests/zkpv_cli.rs) and the whole demo runs in CI's zkp-vault job; these pin the parts
 * a validator and a verifier depend on: the context, the exact bytes, the hashes, and that 100 is
 * never answered for something not checked.
 */
import { ethers } from 'ethers';
import {
  buildRequest,
  buildResponse,
  contextFor,
  FIELD_ORDER,
  responseValue,
  TAG,
  type ProofBundle,
} from '../scripts/demo/human-backed-validation';

const bundle: ProofBundle = { context: 7, nullifier: 42, group: [1, 2, 3, 4], proof: '0xabcd' };

describe('context: one per (chain, registry, agent, purpose), inside the proof field', () => {
  const base = { chainId: 84532, validationRegistry: ethers.ZeroAddress, agentId: 6712, purpose: 'p' };
  it('is a field element and deterministic', () => {
    const c = contextFor(base);
    expect(c).toBeLessThan(FIELD_ORDER);
    expect(contextFor(base)).toBe(c);
  });
  it.each([
    ['agent', { agentId: 6713 }],
    ['chain', { chainId: 8453 }],
    ['purpose (another site)', { purpose: 'q' }],
    ['registry', { validationRegistry: '0x0000000000000000000000000000000000000001' }],
  ])('changes with the %s, so a nullifier cannot be replayed across it', (_what, change) => {
    expect(contextFor({ ...base, ...change })).not.toBe(contextFor(base));
  });
});

describe('the request file', () => {
  const { file, hash } = buildRequest(6712, bundle, ethers.ZeroAddress);
  const parsed = JSON.parse(file);

  it('requestHash is keccak256 of the exact bytes', () => {
    expect(hash).toBe(ethers.keccak256(ethers.toUtf8Bytes(file)));
  });
  it('carries the public inputs and the proof, and names no human and no member index', () => {
    expect(parsed).toMatchObject({ agentId: 6712, context: 7, nullifier: 42, group: [1, 2, 3, 4], proof: '0xabcd' });
    expect(file).not.toMatch(/secret|member_?index|wallet/i);
  });
  it('says what it does not prove, in the file itself', () => {
    expect(parsed.proofSystem.soundness).toMatch(/DEMO/);
    expect(parsed.groupMeaning).toMatch(/^NOT_CHECKED/);
  });
});

describe('the response: 100 only for what was checked', () => {
  const ok = { proof: 'VERIFIED', nullifierFresh: 'VERIFIED', stakedHumans: 'NOT_CHECKED' } as const;
  it('100 when the proof verifies and the nullifier is fresh', () => {
    expect(responseValue(ok)).toBe(100);
  });
  it.each([
    ['the proof fails', { ...ok, proof: 'FAILED' as const }],
    ['the nullifier was used in this context', { ...ok, nullifierFresh: 'FAILED' as const }],
  ])('0 when %s', (_why, c) => {
    expect(responseValue(c)).toBe(0);
  });
  it('responseHash is keccak256 of the exact bytes; the tag says membership, the note says stake is not checked', () => {
    const r = buildResponse('0x' + '11'.repeat(32), ok, 'membership proven');
    expect(r.hash).toBe(ethers.keccak256(ethers.toUtf8Bytes(r.file)));
    const parsed = JSON.parse(r.file);
    expect(parsed).toMatchObject({ response: 100, tag: TAG, checks: { stakedHumans: 'NOT_CHECKED' } });
    expect(parsed.note).toMatch(/does not mean the group is staked humans/);
  });
});
