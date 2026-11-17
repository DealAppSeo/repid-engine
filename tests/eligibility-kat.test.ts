/**
 * The private-eligibility KAT (zkp-vault/kat/eligibility_v0_kat.json) must still be what the TS code computes.
 * The Rust side checks the same file (`rust_matches_the_ts_known_answers`), so a drift on either side fails CI
 * instead of leaving two "one hash" definitions that disagree (ZKP Invariant 1).
 * Regenerate: npx ts-node scripts/zkp/eligibility-kat.ts > zkp-vault/kat/eligibility_v0_kat.json
 */
import { readFileSync } from 'fs';
import { join } from 'path';
import { identityCommitment, leaf, nullifier, policyHash } from '../scripts/zkp/eligibility-kat';
import { commitToSecretFelts } from '../src/zkp/nullifier-identity';
import { fieldsToHex } from '../src/zkp/poseidon2-leaf';

const kat = JSON.parse(readFileSync(join(__dirname, '..', 'zkp-vault', 'kat', 'eligibility_v0_kat.json'), 'utf8'));
const big = (xs: string[]) => xs.map((x) => BigInt(x));
const str = (xs: bigint[]) => xs.map(String);

describe('eligibility KAT matches the TS code', () => {
  test('identity commitment is commitToSecretFelts', () => {
    for (const c of kat.commitment) {
      expect(str(identityCommitment(big(c.sk)))).toEqual(c.idc);
      expect(fieldsToHex(identityCommitment(big(c.sk)))).toBe(commitToSecretFelts(big(c.sk)));
    }
  });
  test('leaf, nullifiers and policy hash', () => {
    const l = kat.leaf;
    expect(str(leaf(big(l.idc), BigInt(l.score), BigInt(l.epoch), big(l.salt)))).toEqual(l.leaf);
    const n = kat.nullifier;
    expect(str(nullifier(big(n.sk), n.domain, n.verifier_id, n.scope_epoch))).toEqual(n.nullifier);
    const o = kat.nullifier_other_scope;
    expect(str(nullifier(big(n.sk), o.domain, o.verifier_id, o.scope_epoch))).toEqual(o.nullifier);
    expect(o.nullifier).not.toEqual(n.nullifier);
    expect(str(policyHash(kat.policy.canonical_json))).toEqual(kat.policy.policy_hash);
  });
});
