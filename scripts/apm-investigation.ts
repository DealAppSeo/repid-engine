// APM On-Chain Investigation
//
// Sprint 6 audit found APM's stored erc8004_address (0xceD17F65...)
// looks like a wallet, not a contract. APM's token #1585 may not exist
// on the canonical IdentityRegistry. This script answers three questions
// via on-chain reads (no signing, no gas):
//
//   1. Is 0xceD17F65... a contract or an EOA?
//   2. Does token #1585 exist on canonical IdentityRegistry (0x8004A818...)?
//   3. If so, who owns it on-chain?
//
// Classifies the result into Case X / Y / Z per sprint Phase A1.2.
//
// Usage: npx ts-node scripts/apm-investigation.ts
import { ethers } from 'ethers';
import IDENTITY_REGISTRY_ABI from '../src/contracts/IdentityRegistry.abi.json';

const APM_STORED_ADDRESS = '0xceD17F65E03e7b3a77D5321A2d3715840317199C';
const APM_STORED_TOKEN_ID = '1585';
const CANONICAL_REGISTRY = '0x8004A818BFB912233c491871b3d84c89A494BD9e';
const BASE_SEPOLIA_RPC =
  process.env.BASE_SEPOLIA_RPC_URL || 'https://sepolia.base.org';

interface Findings {
  apmStoredAddress: string;
  apmStoredAddressCode: string;
  apmStoredAddressIsContract: boolean;
  canonicalRegistry: string;
  tokenIdQueried: string;
  ownerOfResult: string | null;
  ownerOfError: string | null;
  classification: 'X' | 'Y' | 'Z' | 'UNKNOWN';
  classificationReason: string;
  recommendedAction: string;
  recommendedSql: string | null;
}

async function main(): Promise<void> {
  const provider = new ethers.JsonRpcProvider(BASE_SEPOLIA_RPC);

  console.log('=== APM Investigation ===');
  console.log(`RPC:               ${BASE_SEPOLIA_RPC}`);
  console.log(`APM stored addr:   ${APM_STORED_ADDRESS}`);
  console.log(`APM stored token:  ${APM_STORED_TOKEN_ID}`);
  console.log(`Canonical reg:     ${CANONICAL_REGISTRY}`);
  console.log('');

  // Step 1: is APM's stored address a contract?
  console.log('Step 1: provider.getCode(APM_STORED_ADDRESS)...');
  const code = await provider.getCode(APM_STORED_ADDRESS);
  const isContract = code !== '0x' && code !== '0x0';
  console.log(
    `  code = ${code.slice(0, 80)}${code.length > 80 ? '...' : ''}`
  );
  console.log(`  → ${isContract ? 'CONTRACT' : 'EOA (wallet)'}`);

  // Step 2: does token #1585 exist on canonical registry?
  console.log('\nStep 2: canonical.ownerOf(1585)...');
  const registry = new ethers.Contract(
    CANONICAL_REGISTRY,
    IDENTITY_REGISTRY_ABI,
    provider
  );
  let onChainOwner: string | null = null;
  let ownerOfError: string | null = null;
  try {
    onChainOwner = await (registry as any).ownerOf(APM_STORED_TOKEN_ID);
    console.log(`  → ${onChainOwner}`);
  } catch (e: unknown) {
    ownerOfError = e instanceof Error ? e.message : String(e);
    console.log(`  → REVERT: ${ownerOfError.slice(0, 120)}`);
  }

  // Classify
  let classification: Findings['classification'] = 'UNKNOWN';
  let classificationReason = '';
  let recommendedAction = '';
  let recommendedSql: string | null = null;

  if (onChainOwner && onChainOwner.toLowerCase() === APM_STORED_ADDRESS.toLowerCase()) {
    classification = 'Z';
    classificationReason =
      `Token ${APM_STORED_TOKEN_ID} exists on canonical registry and is owned ` +
      `by APM's stored address (which is APM's wallet, not the registry contract). ` +
      `APM's erc8004_address field is being used to store the OWNER wallet, not the contract.`;
    recommendedAction =
      `Update erc8004_address to point at the canonical contract; ` +
      `keep token_id=1585; move owner-wallet into conservator_address.`;
    recommendedSql = `
-- APM repair (Case Z): rewire stored fields to canonical semantics
UPDATE repid_agents
   SET erc8004_address     = '${CANONICAL_REGISTRY}',
       conservator_address = COALESCE(conservator_address, '${APM_STORED_ADDRESS}'),
       mint_chain_id       = 84532
 WHERE agent_name = 'APM' AND erc8004_token_id = '${APM_STORED_TOKEN_ID}';
`.trim();
  } else if (isContract && !ownerOfError) {
    classification = 'X';
    classificationReason =
      `APM's stored address is a contract AND canonical.ownerOf(${APM_STORED_TOKEN_ID}) returned ${onChainOwner}. ` +
      `That implies APM may be minted on a DIFFERENT registry (the stored contract), not the canonical one. ` +
      `The canonical token #${APM_STORED_TOKEN_ID} is owned by ${onChainOwner}, which is unrelated to APM.`;
    recommendedAction =
      `Leave APM data untouched. Document that APM uses an alternative registry. ` +
      `Do not re-mint.`;
    recommendedSql = null;
  } else if (!isContract && ownerOfError) {
    classification = 'Y';
    classificationReason =
      `APM's stored address ${APM_STORED_ADDRESS} is an EOA (wallet), ` +
      `and canonical.ownerOf(${APM_STORED_TOKEN_ID}) reverts (token doesn't exist on canonical registry). ` +
      `APM's mint history is fictional — token #${APM_STORED_TOKEN_ID} has no on-chain backing.`;
    recommendedAction =
      `Re-mint APM via the canonical mint flow (Erc8004Minter on 0x8004A818...). ` +
      `The new token_id will be auto-assigned by _lastId++.`;
    recommendedSql = `
-- APM repair (Case Y): clear fictional mint data; let Erc8004Minter re-mint
UPDATE repid_agents
   SET erc8004_address  = NULL,
       erc8004_token_id = NULL,
       mint_tx_hash     = NULL,
       mint_block_number = NULL,
       minted_at        = NULL,
       mint_chain_id    = NULL
 WHERE agent_name = 'APM' AND erc8004_token_id = '${APM_STORED_TOKEN_ID}';
-- Then call POST /api/v1/agents/{APM_UUID}/mint (Sprint 6 route).
`.trim();
  } else if (!isContract && onChainOwner) {
    classification = 'Z';
    classificationReason =
      `APM's stored address is an EOA, and canonical.ownerOf(${APM_STORED_TOKEN_ID}) returned ${onChainOwner}. ` +
      `Token #${APM_STORED_TOKEN_ID} exists on canonical but is owned by ${onChainOwner} (not APM's stored wallet ${APM_STORED_ADDRESS}). ` +
      `APM's stored erc8004_address is the wrong field for this data.`;
    recommendedAction =
      `Update erc8004_address to canonical contract; set conservator_address to ${onChainOwner} (the real on-chain owner); ` +
      `evaluate whether APM should "own" this token (transfer needed) or this is a different APM entirely.`;
    recommendedSql = `
-- APM repair (Case Z variant): on-chain owner differs from stored address
UPDATE repid_agents
   SET erc8004_address     = '${CANONICAL_REGISTRY}',
       conservator_address = '${onChainOwner}',
       mint_chain_id       = 84532
 WHERE agent_name = 'APM' AND erc8004_token_id = '${APM_STORED_TOKEN_ID}';
-- Caveat: APM's stored address (${APM_STORED_ADDRESS}) is no longer in the picture.
-- Decide manually whether to transfer the token or re-mint with APM's wallet as signer.
`.trim();
  }

  const findings: Findings = {
    apmStoredAddress: APM_STORED_ADDRESS,
    apmStoredAddressCode: code,
    apmStoredAddressIsContract: isContract,
    canonicalRegistry: CANONICAL_REGISTRY,
    tokenIdQueried: APM_STORED_TOKEN_ID,
    ownerOfResult: onChainOwner,
    ownerOfError,
    classification,
    classificationReason,
    recommendedAction,
    recommendedSql,
  };

  console.log('\n=== Classification ===');
  console.log(`Case: ${classification}`);
  console.log(`Reason: ${classificationReason}`);
  console.log(`\nRecommended action:`);
  console.log(`  ${recommendedAction}`);
  if (recommendedSql) {
    console.log(`\nRecommended SQL:`);
    console.log(recommendedSql);
  }

  console.log('\n=== Machine-readable findings JSON ===');
  console.log(JSON.stringify(findings, null, 2));
}

main().catch((e) => {
  console.error('apm-investigation failed:', e);
  process.exit(1);
});
