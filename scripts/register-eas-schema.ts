/**
 * Register the constitutional-compliance-v1 EAS schema on Base Sepolia.
 *
 * WHY: attestProof (src/services/eas-attestation-service.ts) derives the schema UID
 * deterministically from (PROOF_SCHEMA_DEF, resolver=0x0, revocable=true) and calls
 * EAS.attest with it. If that schema was never registered in the SchemaRegistry, EAS
 * reverts with InvalidSchema() (0xbf37b20e) — the second blocker behind the funded-key
 * fix (the first was the env-var name). This registers it ONCE so attestation works.
 *
 * Permissionless: any wallet can register a schema. We use the funded attester wallet so
 * one funded key covers register + attest. Idempotent: if already registered, it no-ops.
 *
 * Run:  railway run --service repid-engine --environment production -- npx ts-node scripts/register-eas-schema.ts
 */
import 'dotenv/config';
import { ethers, Contract, Wallet, JsonRpcProvider, solidityPackedKeccak256 } from 'ethers';
import { SCHEMA_REGISTRY, PROOF_SCHEMA_DEF } from '../src/services/eas-attestation-service';

const RPC = process.env.BASE_SEPOLIA_RPC || 'https://sepolia.base.org';
const RESOLVER = '0x0000000000000000000000000000000000000000';
const REVOCABLE = true;

async function main() {
  const pk = (process.env.HYPERDAG_ATTESTOR_PRIVATE_KEY || process.env.EAS_ATTESTER_PRIVATE_KEY || '').trim();
  if (!pk) { console.log('BLOCKED: no attester key'); process.exit(0); }
  const provider = new JsonRpcProvider(RPC);
  const wallet = new Wallet(pk, provider);
  const expectedUid = solidityPackedKeccak256(['string', 'address', 'bool'], [PROOF_SCHEMA_DEF, RESOLVER, REVOCABLE]);
  console.log(`attester=${wallet.address} expectedSchemaUid=${expectedUid}`);

  const reg = new Contract(SCHEMA_REGISTRY, [
    'function register(string schema, address resolver, bool revocable) external returns (bytes32)',
    'function getSchema(bytes32 uid) view returns (tuple(bytes32 uid,address resolver,bool revocable,string schema))',
  ], wallet);

  const existing = await (reg as any).getSchema(expectedUid);
  if (existing.uid !== ethers.ZeroHash) {
    console.log(`ALREADY REGISTERED uid=${existing.uid} schema="${existing.schema}" — no-op`);
    return;
  }

  console.log(`registering: "${PROOF_SCHEMA_DEF}" resolver=${RESOLVER} revocable=${REVOCABLE}`);
  const tx = await (reg as any).register(PROOF_SCHEMA_DEF, RESOLVER, REVOCABLE);
  console.log(`  tx=${tx.hash} ...waiting`);
  const rc = await tx.wait(1);
  const after = await (reg as any).getSchema(expectedUid);
  const ok = after.uid === expectedUid;
  console.log(`REGISTERED block=${rc?.blockNumber} registry.uid=${after.uid} match=${ok}`);
  console.log(`  https://base-sepolia.easscan.org/schema/view/${expectedUid}`);
  if (!ok) { console.error('UID MISMATCH after register — investigate'); process.exit(1); }
}

main().catch(e => { console.error(e?.message || e); process.exit(1); });
