/**
 * "A staked human stands behind this agent", proven without saying which human, in the shape the
 * ERC-8004 Validation Registry carries. Decisions D-019 / D-020: an agent's identity and RepID are
 * public; the human behind it is not, and is revealed only by court order.
 *
 *   cargo build --release --manifest-path zkp-vault/Cargo.toml
 *   npx ts-node scripts/demo/human-backed-validation.ts [--out <dir>]
 *
 * What it does, with no chain write and no key:
 *  1. Four synthetic humans each hold a secret and are bound to one agent token id. Their
 *     commitments H(secret, agentId) form a public group.
 *  2. One member proves, in zero knowledge (zkp-vault, Plonky3 + Poseidon2), "a member of this
 *     group controls agentId" for a context derived from (chain, registry, agentId, purpose). The
 *     proof reveals a per-context nullifier, never the secret or which member proved.
 *  3. The request file is what `validationRequest(validator, agentId, requestURI, requestHash)`
 *     points at; `requestHash` is keccak256 of its exact bytes. The validator verifies the proof and
 *     the nullifier's freshness and writes the response file for
 *     `validationResponse(requestHash, response, responseURI, responseHash, tag)`.
 *  4. Then the properties that make it accountable without being surveillance: a second use in the
 *     same context repeats the nullifier and is refused; another context gives an unlinkable one; a
 *     changed byte is rejected; a non-member cannot prove at all.
 *
 * What it does NOT show, said here and in every file it writes:
 *  - The group is not yet "staked humans": staking and binding are preview-only in production, so
 *    the stake leg is NOT_CHECKED and the response's tag is about membership only.
 *  - Soundness is demo-grade (zkp-vault README: FRI log_blowup 3, 2 queries, 1 PoW bit; a 31-bit
 *    field, so a nullifier is brute-forceable). Not for value.
 *  - No canonical Validation Registry is deployed (the ERC-8004 team lists Identity and Reputation
 *    only), so nothing is posted; the call arguments are printed.
 *  - Court-order reveal (D-020) is not built.
 *
 * Exit 0 when every property behaves as stated, 1 when one does not, 2 when zkpv is missing.
 */
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ethers } from 'ethers';

/** BabyBear, the field the proof lives in: 15 * 2^27 + 1. */
export const FIELD_ORDER = 2013265921n;
export const IDENTITY_REGISTRY = '0x8004A818BFB912233c491871b3d84c89A494BD9e';
export const CHAIN_ID = 84532;
export const PURPOSE = 'hyperdag.human-backed-agent.v0';
export const TAG = 'zk-membership-v0';

/** The context a proof is scoped to: one per (chain, registry, agent, purpose), as a field element. */
export function contextFor(i: { chainId: number; validationRegistry: string; agentId: number; purpose: string }): bigint {
  const h = ethers.keccak256(
    ethers.AbiCoder.defaultAbiCoder().encode(['uint256', 'address', 'uint256', 'string'], [i.chainId, i.validationRegistry, i.agentId, i.purpose]),
  );
  return BigInt(h) % FIELD_ORDER;
}

export interface ProofBundle {
  context: number;
  nullifier: number;
  group: number[];
  proof: string;
}

/** The request file: exact bytes, keccak256 of which is the request's requestHash. */
export function buildRequest(agentId: number, bundle: ProofBundle, validationRegistry: string): { file: string; hash: string } {
  const file = JSON.stringify({
    type: PURPOSE,
    agentRegistry: `eip155:${CHAIN_ID}:${IDENTITY_REGISTRY}`,
    agentId,
    validationRegistry: `eip155:${CHAIN_ID}:${validationRegistry}`,
    statement: 'A member of `group` controls `agentId`. The member is not revealed.',
    context: bundle.context,
    nullifier: bundle.nullifier,
    group: bundle.group,
    proof: bundle.proof,
    proofSystem: {
      name: 'zkp-vault ownership proof (Plonky3 uni-stark 0.3, Poseidon2 over BabyBear)',
      soundness: 'DEMO: FRI log_blowup 3, 2 queries, 1 PoW bit; 31-bit field. Not for value.',
    },
    groupMeaning: 'NOT_CHECKED: the group is synthetic. In production it would be the commitments of staked, bound humans; staking is preview-only today.',
  });
  return { file, hash: ethers.keccak256(ethers.toUtf8Bytes(file)) };
}

export interface Checks {
  proof: 'VERIFIED' | 'FAILED';
  nullifierFresh: 'VERIFIED' | 'FAILED';
  stakedHumans: 'NOT_CHECKED';
}

/** 100 only when the proof verifies AND the nullifier is unused in this context; else 0. */
export function responseValue(c: Checks): number {
  return c.proof === 'VERIFIED' && c.nullifierFresh === 'VERIFIED' ? 100 : 0;
}

/** The response file: exact bytes, keccak256 of which is the response's responseHash. */
export function buildResponse(requestHash: string, c: Checks, reason: string): { file: string; hash: string; response: number } {
  const response = responseValue(c);
  const file = JSON.stringify({
    type: `${PURPOSE}.response`,
    requestHash,
    response,
    tag: TAG,
    checks: c,
    reason,
    note: 'response 100 means the membership proof verified and its nullifier was fresh in this context. It does not mean the group is staked humans (stakedHumans is NOT_CHECKED).',
  });
  return { file, hash: ethers.keccak256(ethers.toUtf8Bytes(file)), response };
}

function zkpv(bin: string, args: string[], input?: string): { code: number; out: string } {
  try {
    const out = execFileSync(bin, args, { input, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
    return { code: 0, out };
  } catch (e) {
    const err = e as { status?: number; stdout?: string };
    return { code: err.status ?? 1, out: err.stdout ?? '' };
  }
}

const secret = () => BigInt('0x' + randomBytes(7).toString('hex')).toString(); // < 2^56, a u64

async function main(): Promise<number> {
  const bin = process.env.ZKPV_BIN || join(__dirname, '..', '..', 'zkp-vault', 'target', 'release', 'zkpv');
  if (!existsSync(bin)) {
    console.log(`NOT_CHECKED: zkpv not built (cargo build --release --manifest-path zkp-vault/Cargo.toml), looked at ${bin}`);
    return 2;
  }
  const outIdx = process.argv.indexOf('--out');
  const outDir = outIdx >= 0 ? process.argv[outIdx + 1]! : join(process.cwd(), 'out', 'human-backed-validation');
  mkdirSync(outDir, { recursive: true });
  const registry = ethers.ZeroAddress; // no canonical Validation Registry is deployed yet
  const results: Array<[string, boolean]> = [];

  // 1. Four synthetic humans, each bound to one agent token id; the group is their commitments.
  const humans = [3747, 6712, 1, 2].map((agentId) => ({ secret: secret(), agentId }));
  const group = humans.map((h) => JSON.parse(zkpv(bin, ['commit', h.secret, String(h.agentId)]).out).commitment as number);
  const prover = humans[1]!;
  console.log(`group of ${group.length} commitments: ${group.join(', ')}`);

  // 2. The member bound to agent 6712 proves membership for this agent's context.
  const ctx = contextFor({ chainId: CHAIN_ID, validationRegistry: registry, agentId: prover.agentId, purpose: PURPOSE });
  const proved = zkpv(bin, ['prove', prover.secret, String(prover.agentId), ctx.toString(), group.join(',')]);
  const bundle = JSON.parse(proved.out) as ProofBundle;
  const req = buildRequest(prover.agentId, bundle, registry);
  const seen = new Set<number>();

  // 3. The validator: verify the proof, then the nullifier's freshness in this context.
  const validate = (r: { file: string; hash: string }, b: ProofBundle) => {
    const ok = zkpv(bin, ['verify'], JSON.stringify(b)).code === 0;
    const fresh = !seen.has(b.nullifier);
    if (ok && fresh) seen.add(b.nullifier);
    const checks: Checks = { proof: ok ? 'VERIFIED' : 'FAILED', nullifierFresh: fresh ? 'VERIFIED' : 'FAILED', stakedHumans: 'NOT_CHECKED' };
    return buildResponse(r.hash, checks, !ok ? 'the proof does not verify' : !fresh ? 'this nullifier was already used in this context' : 'membership proven; member not revealed');
  };
  const res = validate(req, bundle);
  writeFileSync(join(outDir, 'request.json'), req.file);
  writeFileSync(join(outDir, 'response.json'), res.file);
  console.log(`\nvalidationRequest(validator, ${prover.agentId}, "<requestURI>/request.json", ${req.hash})`);
  console.log(`validationResponse(${req.hash}, ${res.response}, "<responseURI>/response.json", ${res.hash}, "${TAG}")`);
  console.log(`proof ${Math.round(bundle.proof.length / 2 / 1024)} KB; nullifier ${bundle.nullifier}; the request names no human and no member index`);
  results.push(['a member proves; the validator answers 100', res.response === 100]);

  // 4a. The same human again, same context: the nullifier repeats and the validator refuses it.
  const again = JSON.parse(zkpv(bin, ['prove', prover.secret, String(prover.agentId), ctx.toString(), group.join(',')]).out) as ProofBundle;
  const res2 = validate(buildRequest(prover.agentId, again, registry), again);
  results.push(['a second use in the same context repeats the nullifier and is refused (0)', again.nullifier === bundle.nullifier && res2.response === 0]);

  // 4b. The same human, another context: a different nullifier that nothing links to the first.
  const otherCtx = contextFor({ chainId: CHAIN_ID, validationRegistry: registry, agentId: prover.agentId, purpose: `${PURPOSE}.another-site` });
  const other = JSON.parse(zkpv(bin, ['nullifier', prover.secret, otherCtx.toString()]).out).nullifier as number;
  results.push(['another context gives an unlinkable nullifier', other !== bundle.nullifier]);

  // 4c. One changed byte in the proof: rejected.
  const p = bundle.proof;
  const i = Math.floor(p.length / 2);
  const tampered: ProofBundle = { ...bundle, proof: p.slice(0, i) + (p[i] === '0' ? '1' : '0') + p.slice(i + 1) };
  results.push(['a changed byte is rejected (0)', validate(buildRequest(prover.agentId, tampered, registry), tampered).response === 0]);

  // 4d. Someone outside the group cannot produce a proof at all.
  results.push(['a non-member cannot prove', zkpv(bin, ['prove', secret(), String(prover.agentId), ctx.toString(), group.join(',')]).code === 2]);

  console.log('');
  for (const [what, ok] of results) console.log(`${ok ? 'VERIFIED' : 'FAILED  '}  ${what}`);
  console.log('NOT_CHECKED  the group is staked humans (staking is preview-only); court-order reveal (D-020) is not built');
  console.log(`\nfiles: ${outDir}/request.json, ${outDir}/response.json`);
  return results.every(([, ok]) => ok) ? 0 : 1;
}

if (require.main === module) {
  main().then(
    (code) => process.exit(code),
    (err) => {
      console.error(err);
      process.exit(1);
    },
  );
}
