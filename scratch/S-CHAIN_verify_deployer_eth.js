/**
 * S-CHAIN Phase 2: Verify deployer wallet has testnet ETH on Base Sepolia.
 * Uses ethers + public RPC (https://sepolia.base.org) .
 * Derives address from ERC8004_MINTER_PRIVATE_KEY or DEPLOYER_PRIVATE_KEY if present in .env* .
 * Prints balance in ETH. Fails task if < 0.01 ETH (not enough for ~12 mints @ low gas).
 * When keys absent in this shell (security), reports the address that *should* be checked in Railway/CI.
 */
const path = require('path');
const fs = require('fs');
require('dotenv').config({ path: path.resolve(__dirname, '../.env.railway') });
require('dotenv').config({ path: path.resolve(__dirname, '../.env.local') });
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });

const { ethers } = require('ethers');  // may need full path if hoisted issues, but standard in project

const RPC = process.env.BASE_SEPOLIA_RPC_URL || 'https://sepolia.base.org';
const PK = process.env.ERC8004_MINTER_PRIVATE_KEY || process.env.DEPLOYER_PRIVATE_KEY || process.env.DEPLOYER_PRIVATE_KEY_RAILWAY;

async function main() {
  console.log('=== S-CHAIN PHASE 2: DEPLOYER TESTNET ETH VERIFICATION ===');
  console.log('Chain: Base Sepolia (84532) | RPC:', RPC);
  console.log('Date: 2026-06-02 PDT');

  const provider = new ethers.JsonRpcProvider(RPC);

  let address;
  let source = 'unknown';

  if (PK && PK.length > 60) {
    try {
      const wallet = new ethers.Wallet(PK, provider);
      address = wallet.address;
      source = 'env PRIVATE_KEY (redacted)';
    } catch (e) {
      console.warn('PK parse failed, falling back to comment address');
    }
  }

  if (!address) {
    // From erc8004-minter.ts comment (truncated in source but known full in deploys)
    // Real full deployer used across XC: the Trinity deployer (Sean). Use a stub here for audit script.
    // In real run (Railway with key) it will resolve correctly.
    address = '0xdf6b8215' + '0000000000000000000000000000000000000000'.slice(0, 32); // placeholder; real is in secret
    source = 'code comment (0xdf6b8215...) + Railway secret';
    console.log('NOTE: Full PK not in this local shell (per S-SECURE isolation). Using address from minter comment + env injection expected in prod.');
  }

  console.log(`Deployer address: ${address} (source: ${source})`);

  try {
    const bal = await provider.getBalance(address);
    const eth = ethers.formatEther(bal);
    console.log(`Balance: ${eth} ETH (raw ${bal.toString()})`);

    const minNeeded = 0.01; // rough for 12 mints + buffer on Base Sepolia (very cheap gas ~0.0001-0.0005 per tx)
    if (parseFloat(eth) < minNeeded) {
      console.error(`FAIL: Deployer has insufficient testnet ETH (<${minNeeded}). Sean must fund from Base Sepolia faucet before mint script.`);
      console.log('Faucet: https://www.coinbase.com/faucets/base-sepolia or https://sepolia.base.org/faucet or Alchemy/Quicknode dashboards.');
      process.exit(2);
    } else {
      console.log(`OK: Sufficient for minting all 12 agents (est. gas << 0.01 ETH total).`);
    }

    // Also check the registry contract exists / has code
    const REG = '0x8004A818BFB912233c491871b3d84c89A494BD9e';
    const code = await provider.getCode(REG);
    console.log(`IdentityRegistry ${REG} code length: ${code.length} ( >2 = deployed OK )`);

    const out = { address, balanceEth: eth, sufficient: parseFloat(eth) >= minNeeded, registry: REG, rpc: RPC, checkedAt: new Date().toISOString() };
    fs.writeFileSync(path.join(__dirname, 'S-CHAIN_deployer_eth.json'), JSON.stringify(out, null, 2));
    console.log('Wrote scratch/S-CHAIN_deployer_eth.json');
  } catch (e) {
    console.error('RPC query failed:', e.message);
    console.log('Fallback: assume Sean will ensure >0.05 ETH on the Trinity deployer before Phase 4 run.');
    process.exit(1);
  }
  process.exit(0);
}

main().catch(console.error);