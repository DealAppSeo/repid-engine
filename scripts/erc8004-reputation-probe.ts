// ERC-8004 ReputationRegistry probe.
//
// Read-only sanity check: confirms the canonical ReputationRegistry
// contract is deployed at the expected address on Base Sepolia AND
// that the ABI in this repo matches its surface (no signing, no gas).
//
// Usage: npx ts-node scripts/erc8004-reputation-probe.ts
import { ethers } from 'ethers';
import reputationAbiRaw from '../src/contracts/ReputationRegistry.abi.json';

const CANONICAL_BASE_SEPOLIA_REPUTATION =
  '0x8004B663056A597Dffe9eCcC1965A193B7388713';
const CANONICAL_BASE_SEPOLIA_IDENTITY =
  '0x8004A818BFB912233c491871b3d84c89A494BD9e';
const RPC = process.env.BASE_SEPOLIA_RPC_URL || 'https://sepolia.base.org';
const APM_TOKEN_ID = '1585';

// Support both bare-array and {abi: [...]} formats.
const REPUTATION_ABI =
  (reputationAbiRaw as any).abi ?? (reputationAbiRaw as unknown[]);

async function main(): Promise<void> {
  const provider = new ethers.JsonRpcProvider(RPC);

  console.log('=== ReputationRegistry probe ===');
  console.log(`RPC:              ${RPC}`);
  console.log(`Contract:         ${CANONICAL_BASE_SEPOLIA_REPUTATION}`);
  console.log(`ABI entries:      ${REPUTATION_ABI.length}`);
  console.log('');

  // Step 1: confirm the address has code (i.e., it's a contract).
  const code = await provider.getCode(CANONICAL_BASE_SEPOLIA_REPUTATION);
  console.log(`Step 1: provider.getCode(${CANONICAL_BASE_SEPOLIA_REPUTATION})`);
  console.log(`  code length: ${code.length} chars`);
  console.log(`  → ${code === '0x' || code === '0x0' ? 'NO CONTRACT (FAIL)' : 'contract present'}`);

  const reputation = new ethers.Contract(
    CANONICAL_BASE_SEPOLIA_REPUTATION,
    REPUTATION_ABI,
    provider
  );

  // Step 2: read getVersion()
  console.log(`\nStep 2: reputation.getVersion()`);
  try {
    const version: string = await (reputation as any).getVersion();
    console.log(`  → "${version}"`);
  } catch (e: unknown) {
    console.log(`  REVERT: ${e instanceof Error ? e.message.slice(0, 120) : String(e)}`);
  }

  // Step 3: read getIdentityRegistry() — should return the canonical IdentityRegistry.
  console.log(`\nStep 3: reputation.getIdentityRegistry()`);
  try {
    const ident: string = await (reputation as any).getIdentityRegistry();
    console.log(`  → ${ident}`);
    if (ident.toLowerCase() !== CANONICAL_BASE_SEPOLIA_IDENTITY.toLowerCase()) {
      console.log(`  ⚠️  Expected ${CANONICAL_BASE_SEPOLIA_IDENTITY}, got ${ident}`);
    } else {
      console.log(`  ✅ Matches canonical IdentityRegistry`);
    }
  } catch (e: unknown) {
    console.log(`  REVERT: ${e instanceof Error ? e.message.slice(0, 120) : String(e)}`);
  }

  // Step 4: probe getSummary() for APM (known-real token #1585).
  // Anti-Sybil: caller must specify clientAddresses to filter feedback by.
  // We pass the zero address as a probe — likely returns count=0 because
  // no one has written feedback as 0x0.
  console.log(`\nStep 4: reputation.getSummary(${APM_TOKEN_ID}, [0x0], "", "")`);
  try {
    const summary = await (reputation as any).getSummary(
      BigInt(APM_TOKEN_ID),
      ['0x0000000000000000000000000000000000000000'],
      '',
      ''
    );
    console.log(`  count=${summary[0]} summaryValue=${summary[1]} valueDecimals=${summary[2]}`);
    console.log(`  → call succeeded (count=0 expected since no one has filed feedback as 0x0)`);
  } catch (e: unknown) {
    console.log(`  REVERT: ${e instanceof Error ? e.message.slice(0, 200) : String(e)}`);
  }

  // Step 5: list clients who HAVE written feedback for APM.
  console.log(`\nStep 5: reputation.getClients(${APM_TOKEN_ID})`);
  try {
    const clients: string[] = await (reputation as any).getClients(BigInt(APM_TOKEN_ID));
    console.log(`  clients: ${JSON.stringify(clients)}`);
    console.log(`  client count: ${clients.length}`);
  } catch (e: unknown) {
    console.log(`  REVERT: ${e instanceof Error ? e.message.slice(0, 200) : String(e)}`);
  }
}

main().catch((e) => {
  console.error('erc8004-reputation-probe failed:', e);
  process.exit(1);
});
