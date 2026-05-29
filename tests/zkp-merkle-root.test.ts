/**
 * Hash-agnostic Merkle root/inclusion tests (sprint 2026-05-29, continues PR #73).
 * Proves the tree shape is identical across hash schemes (keccak256, sha256) and
 * that the poseidon2 placeholder fails loudly until the migration lands.
 */
import { keccak256, sha256, toUtf8Bytes } from 'ethers';
import {
  getHashScheme, buildRoot, buildInclusion, verifyInclusion, rootFromCommitments,
  HASH_SCHEMES, DEFAULT_HASH_SCHEME,
} from '../src/zkp/merkle-root';

const COMMITS = ['c0', 'c1', 'c2', 'c3', 'c4']; // odd count exercises duplicate-last

describe('hash schemes', () => {
  it('default is keccak256', () => {
    expect(DEFAULT_HASH_SCHEME).toBe('keccak256');
    expect(getHashScheme().name).toBe('keccak256');
  });

  it('keccak leaf matches ethers keccak256(utf8)', () => {
    expect(getHashScheme('keccak256').leaf('c0')).toBe(keccak256(toUtf8Bytes('c0')));
  });

  it('sha256 leaf matches ethers sha256(utf8)', () => {
    expect(getHashScheme('sha256').leaf('c0')).toBe(sha256(toUtf8Bytes('c0')));
  });

  it('poseidon2 is a flagged placeholder that throws (no mock-as-real)', () => {
    expect(() => getHashScheme('poseidon2').leaf('x')).toThrow(/poseidon2 scheme not available/);
  });

  it('unknown scheme throws', () => {
    expect(() => getHashScheme('blake3')).toThrow(/unknown hash scheme/);
  });
});

describe('hash-agnostic tree shape', () => {
  for (const name of ['keccak256', 'sha256']) {
    it(`${name}: inclusion proof reproduces the root for every index`, () => {
      const scheme = getHashScheme(name);
      const leaves = COMMITS.map(scheme.leaf);
      const root = buildRoot(leaves, scheme.pair);
      for (let i = 0; i < leaves.length; i++) {
        const p = buildInclusion(leaves, i, scheme);
        expect(p.root).toBe(root);
        expect(p.scheme).toBe(name);
        expect(verifyInclusion(p)).toBe(true);
      }
    });
  }

  it('different schemes yield different roots over the same commitments', () => {
    const k = rootFromCommitments(COMMITS, 'keccak256');
    const s = rootFromCommitments(COMMITS, 'sha256');
    expect(k.root).not.toBe(s.root);
    expect(k.scheme).toBe('keccak256');
    expect(s.scheme).toBe('sha256');
  });

  it('rootFromCommitments matches a manual buildRoot', () => {
    const scheme = getHashScheme('keccak256');
    const manual = buildRoot(COMMITS.map(scheme.leaf), scheme.pair);
    expect(rootFromCommitments(COMMITS).root).toBe(manual);
  });

  it('single leaf: root == leaf', () => {
    const scheme = getHashScheme('keccak256');
    const leaves = [scheme.leaf('only')];
    expect(buildRoot(leaves, scheme.pair)).toBe(leaves[0]);
    expect(verifyInclusion(buildInclusion(leaves, 0, scheme))).toBe(true);
  });

  it('verifyInclusion rejects a tampered leaf', () => {
    const scheme = getHashScheme('keccak256');
    const leaves = COMMITS.map(scheme.leaf);
    const p = buildInclusion(leaves, 2, scheme);
    expect(verifyInclusion({ ...p, leaf: scheme.leaf('evil') })).toBe(false);
  });

  it('registry exposes keccak256, sha256, poseidon2', () => {
    expect(Object.keys(HASH_SCHEMES).sort()).toEqual(['keccak256', 'poseidon2', 'sha256']);
  });
});
