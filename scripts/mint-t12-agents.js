#!/usr/bin/env node
/**
 * S-CHAIN Phase 3/4: Minting script for all 12 T12 agents on Base Sepolia.
 * Uses ethers + the live IdentityRegistry (ERC-8004 register(string) ).
 * Produces REAL tx hashes when run with funded ERC8004_MINTER_PRIVATE_KEY (Trinity deployer).
 *
 * Usage (after Sean funds the deployer):
 *   node scripts/mint-t12-agents.js
 *   (or with --dry for gas estimates only)
 *
 * After successful run:
 *   - Copy the txHashes + tokenIds into repid_agents rows (erc8004_token_id, mint_tx_hash, conservator_address, minted_at etc).
 *   - Or enhance to also POST to local engine /api/v1/agents/:uuid/mint if server up with same PK.
 *   - Marco can then `https://sepolia.basescan.org/tx/<tx>` for each and see Registered + Transfer events.
 *
 * When Marco checks basescan, every agent will have a verifiable transaction from the Trinity deployer.
 */
const path = require('path');
const fs = require('fs');
require('dotenv').config({ path: path.resolve(__dirname, '../.env.railway') });
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });

const { ethers } = require('ethers');

// === CONFIG (match agents-onchain + erc8004-minter) ===
const RPC_URL = process.env.BASE_SEPOLIA_RPC_URL || 'https://sepolia.base.org';
const CHAIN_ID = 84532;
const IDENTITY_REGISTRY = process.env.TRUST_IDENTITY_REGISTRY || '0x8004A818BFB912233c491871b3d84c89A494BD9e';
const PK = process.env.ERC8004_MINTER_PRIVATE_KEY || process.env.DEPLOYER_PRIVATE_KEY;

const isDry = process.argv.includes('--dry') || process.argv.includes('-d');

if (!PK && !isDry) {
  console.error('FATAL: ERC8004_MINTER_PRIVATE_KEY (or DEPLOYER_PRIVATE_KEY) required in env to sign mint txs.');
  console.error('Sean: export the key (testnet only) then re-run. Never commit.');
  process.exit(1);
}

const T12 = [
  { name: 'trinity-veritas',   uuid: 'aaaaaaaa-1111-4111-8111-111111111111' },
  { name: 'trinity-sophia',    uuid: 'bbbbbbbb-2222-4222-8222-222222222222' },
  { name: 'trinity-harmonia',  uuid: 'cccccccc-3333-4333-8333-333333333333' },
  { name: 'trinity-apollon',   uuid: 'dddddddd-4444-4444-8444-444444444444' },
  { name: 'trinity-melodia',   uuid: 'eeeeeeee-5555-4555-8555-555555555555' },
  { name: 'trinity-arkhe',     uuid: 'ffffffff-6666-4666-8666-666666666666' },
  { name: 'trinity-selene',    uuid: '99999999-7777-4777-8777-777777777777' },
  { name: 'trinity-hephaistos',uuid: '88888888-8888-4888-8888-888888888888' },
  { name: 'trinity-athena',    uuid: '77777777-9999-4999-8999-999999999999' },
  { name: 'trinity-eros',      uuid: '66666666-aaaa-4aaa-8aaa-aaaaaaaaaaaa' },
  { name: 'trinity-hermes',    uuid: '55555555-bbbb-4bbb-8bbb-bbbbbbbbbbbb' },
  { name: 'trinity-gaia',      uuid: '44444444-cccc-4ccc-8ccc-cccccccccccc' }
];

const ABI = require(path.join(__dirname, '..', 'src', 'contracts', 'IdentityRegistry.abi.json'));

async function main() {
  const isDry = process.argv.includes('--dry') || process.argv.includes('-d');
  console.log('=== S-CHAIN MINT T12 AGENTS (Base Sepolia) ===');
  console.log('Registry:', IDENTITY_REGISTRY);
  console.log('RPC:', RPC_URL);
  console.log('Dry run:', isDry);
  console.log('Agents:', T12.length);

  const provider = new ethers.JsonRpcProvider(RPC_URL);
  let signer, contract;
  if (PK) {
    signer = new ethers.Wallet(PK, provider);
    contract = new ethers.Contract(IDENTITY_REGISTRY, ABI, signer);
  } else {
    // dry-only mode: use read-only provider + dummy for estimate (gas only, no send)
    signer = { address: '0x000000000000000000000000000000000000dEaD' }; // placeholder for logs
    contract = new ethers.Contract(IDENTITY_REGISTRY, ABI, provider);
  }

  const effectiveAddr = (signer && signer.address) ? signer.address : 'DRY-READONLY';
  console.log('Signer (deployer):', effectiveAddr);
  let bal = 0n;
  try {
    bal = await provider.getBalance(effectiveAddr === 'DRY-READONLY' ? '0x000000000000000000000000000000000000dEaD' : effectiveAddr);
  } catch {}
  console.log('Signer balance (or dry placeholder):', ethers.formatEther(bal), 'ETH');

  if (PK && parseFloat(ethers.formatEther(bal)) < 0.005) {
    console.error('\n*** INSUFFICIENT FUNDS ***');
    console.error('Fund this address on Base Sepolia faucet:');
    console.error('  https://sepolia.base.org/faucet  or Coinbase/Base faucet');
    console.error('Address:', effectiveAddr);
    console.error('Then re-run: node scripts/mint-t12-agents.js');
    process.exit(2);
  }

  const results = [];
  const resultsFile = path.join(__dirname, '..', 'scratch', 'S-CHAIN_mint_results.json');
  const correctResultsFile = path.join(__dirname, '..', 'scratch', 'mint-t12-correct-results.json'); // per S-ONCHAIN spec Step 1.3

  for (let i = 0; i < T12.length; i++) {
    const a = T12[i];
    const uri = `https://repid.dev/agents/${a.uuid}/metadata`;
    console.log(`\n[${i+1}/${T12.length}] Minting ${a.name} (uuid=${a.uuid})`);
    console.log('  URI:', uri);

    try {
      if (isDry) {
        if (PK) {
          try {
            const gas = await contract['register(string)'].estimateGas(uri);
            console.log('  DRY: gas estimate =', gas.toString());
            results.push({ name: a.name, uuid: a.uuid, uri, dry: true, gas: gas.toString() });
          } catch (estErr) {
            console.log('  DRY: estimate failed (', estErr.message?.slice(0,80) || estErr, '), using simulated gas 150000');
            results.push({ name: a.name, uuid: a.uuid, uri, dry: true, gas: '150000', note: 'estimate reverted, simulated' });
          }
        } else {
          console.log('  DRY (no PK): simulated gas 150000 (production uses register(string) as in Erc8004Minter)');
          results.push({ name: a.name, uuid: a.uuid, uri, dry: true, gas: '150000', note: 'no PK, simulated; uses production register(string) overload' });
        }
        continue;
      }

      const tx = await contract['register(string)'](uri);
      console.log('  TX submitted:', tx.hash);
      const receipt = await tx.wait(1);
      if (receipt.status !== 1) throw new Error('tx reverted');

      // Extract tokenId from Registered or Transfer
      let tokenId = null;
      const regTopic = ethers.id('Registered(uint256,string,address)');
      const xferTopic = ethers.id('Transfer(address,address,uint256)');
      for (const log of receipt.logs) {
        if (log.topics[0] === regTopic && log.topics[1]) {
          tokenId = ethers.toBigInt(log.topics[1]).toString();
          break;
        }
      }
      if (!tokenId) {
        for (const log of receipt.logs) {
          if (log.topics[0] === xferTopic && log.topics[3]) {
            tokenId = ethers.toBigInt(log.topics[3]).toString();
            break;
          }
        }
      }
      if (!tokenId) tokenId = 'unknown';

      const res = {
        name: a.name,
        uuid: a.uuid,
        uri,
        txHash: tx.hash,
        tokenId,
        blockNumber: receipt.blockNumber,
        gasUsed: receipt.gasUsed.toString(),
        owner: (signer && signer.address) ? signer.address : 'DRY',
        basescan: `https://sepolia.basescan.org/tx/${tx.hash}`,
        contract: IDENTITY_REGISTRY,
        chainId: CHAIN_ID
      };
      results.push(res);
      console.log('  SUCCESS: tokenId=', tokenId, 'tx=', tx.hash);
      console.log('  BASESCAN:', res.basescan);
    } catch (e) {
      console.error('  ERROR:', e.message || e);
      results.push({ name: a.name, uuid: a.uuid, error: e.message || String(e) });
    }
    // polite delay between txs
    await new Promise(r => setTimeout(r, 1500));
  }

  const summary = {
    date: new Date().toISOString(),
    chain: 'base-sepolia',
    registry: IDENTITY_REGISTRY,
    deployer: signer.address,
    total: T12.length,
    success: results.filter(r => r.txHash).length,
    results
  };

  fs.writeFileSync(resultsFile, JSON.stringify(summary, null, 2));
  fs.writeFileSync(correctResultsFile, JSON.stringify(summary, null, 2));
  console.log('\n=== MINT COMPLETE ===');
  console.log('Wrote', resultsFile);
  console.log('Wrote', correctResultsFile, '(per S-ONCHAIN spec)');
  console.log('Success count:', summary.success, '/', T12.length);
  console.log('\nTo make Marco see real txs on basescan:');
  console.log('1. Run this script with funded key (it will produce the txs above).');
  console.log('2. For each success, update repid_agents row:');
  console.log('   UPDATE repid_agents SET erc8004_address=$REG, erc8004_token_id=$TOKEN, mint_tx_hash=$TX, conservator_address=$OWNER, minted_at=now() WHERE agent_name=$NAME;');
  console.log('3. Verify: curl or visit the basescan links.');

  // Also print a ready-to-paste SQL snippet for the successful ones (Sean can apply)
  const success = results.filter(r => r.txHash);
  if (success.length) {
    console.log('\n-- SQL backfill (apply after run) --');
    success.forEach(r => {
      console.log(`UPDATE repid_agents SET erc8004_address='${r.contract}', erc8004_token_id='${r.tokenId}', mint_tx_hash='${r.txHash}', conservator_address='${r.owner}', mint_block_number=${r.blockNumber}, minted_at=NOW(), mint_chain_id=${r.chainId} WHERE agent_name='${r.name}';`);
    });
  }
}

main().catch(e => { console.error(e); process.exit(1); });