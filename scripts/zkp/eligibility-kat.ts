/**
 * eligibility-kat.ts — known-answer vectors for the private-eligibility circuit (spec:
 * living-docs/03_specs/ZK_PRIVATE_ELIGIBILITY_v0_2026-11-17.md, §3), computed by the TS side.
 *
 * The Rust circuit (zkp-vault/src/eligibility.rs) recomputes every value here from the same inputs and
 * must match, so "one hash, one field" (ZKP Invariant 1) is a test, not a claim. The identity commitment
 * is `commitToSecretFelts` itself, the function the engine would use to register an agent.
 *
 *   npx ts-node scripts/zkp/eligibility-kat.ts > zkp-vault/kat/eligibility_v0_kat.json
 */
import { poseidon2Sponge, poseidon2Compress, fieldsToHex } from '../../src/zkp/poseidon2-leaf';
import { commitToSecretFelts, feltsFromString } from '../../src/zkp/nullifier-identity';

export const COMMIT_TAG = 'hyperdag/identity/commitment/v1';
export const NULLIFIER_TAG = 'hyperdag/eligibility/nullifier/v2';
export const POLICY_TAG = 'hyperdag/eligibility/policy/v1';
export const LEAF_TAG = 0x4c454631n;

const s = (xs: readonly bigint[]) => xs.map(String);

export function identityCommitment(sk: readonly bigint[]): bigint[] {
  return poseidon2Sponge([...feltsFromString(COMMIT_TAG), ...sk]);
}
export function leaf(idc: readonly bigint[], score: bigint, epoch: bigint, salt: readonly bigint[]): bigint[] {
  return poseidon2Compress(idc, [score, epoch, LEAF_TAG, ...salt]);
}
/** The public prefix, zero-padded to a full block, so the secret is exactly the last block. */
export function nullifierPrefix(domain: string, verifierId: string, scopeEpoch: string): bigint[] {
  const p = [...feltsFromString(NULLIFIER_TAG), ...feltsFromString(domain), ...feltsFromString(verifierId), ...feltsFromString(scopeEpoch)];
  while (p.length % 8 !== 0) p.push(0n);
  return p;
}
export function nullifier(sk: readonly bigint[], domain: string, verifierId: string, scopeEpoch: string): bigint[] {
  return poseidon2Sponge([...nullifierPrefix(domain, verifierId, scopeEpoch), ...sk]);
}
export function policyHash(canonicalJson: string): bigint[] {
  return poseidon2Sponge([...feltsFromString(POLICY_TAG), ...feltsFromString(canonicalJson)]);
}

function main(): void {
  const sk = [11n, 22n, 33n, 44n, 55n, 66n, 77n, 88n];
  const sk2 = [2013265920n, 1n, 123456789n, 987654321n, 5n, 6n, 7n, 8n];
  const idc = identityCommitment(sk);
  if (fieldsToHex(idc) !== commitToSecretFelts(sk)) throw new Error('identityCommitment diverged from commitToSecretFelts');
  const salt = [101n, 102n, 103n, 104n, 105n];
  const scope = { domain: 'repid', verifier_id: 'trustmarket/sandbox-1', scope_epoch: '2026-11-17' };
  const policy = '{"circuit_id":"zkp-vault/eligibility/v0/d8-h64","domain":"repid","issuer":"repid-engine/attester/v0","max_epoch_age":1,"predicate":"score_gte","threshold":500}';
  const out = {
    source: 'scripts/zkp/eligibility-kat.ts (TS poseidon2Sponge / poseidon2Compress / commitToSecretFelts)',
    commitment: [
      { sk: s(sk), idc: s(idc) },
      { sk: s(sk2), idc: s(identityCommitment(sk2)) },
    ],
    leaf: { idc: s(idc), score: '742', epoch: '20409', salt: s(salt), leaf: s(leaf(idc, 742n, 20409n, salt)) },
    nullifier: { sk: s(sk), ...scope, prefix_len: nullifierPrefix(scope.domain, scope.verifier_id, scope.scope_epoch).length,
      nullifier: s(nullifier(sk, scope.domain, scope.verifier_id, scope.scope_epoch)) },
    nullifier_other_scope: { ...scope, verifier_id: 'trustmarket/sandbox-2',
      nullifier: s(nullifier(sk, scope.domain, 'trustmarket/sandbox-2', scope.scope_epoch)) },
    policy: { canonical_json: policy, policy_hash: s(policyHash(policy)) },
  };
  process.stdout.write(JSON.stringify(out, null, 2) + '\n');
}

if (require.main === module) main();
