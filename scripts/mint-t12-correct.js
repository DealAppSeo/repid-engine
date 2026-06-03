const { ethers } = require('ethers');
const fs = require('fs');
const path = require('path');
try { require('dotenv').config(); } catch(e) {}
const REGISTRY_ADDRESS = '0x8004A818BFB912233c491871b3d84c89A494BD9e';
const RPC = process.env.BASE_SEPOLIA_RPC || 'https://sepolia.base.org';
const CUSTODIAN = '0xdf6b8215D193b11B4903d223729c3CF7A6de271d';
const DRY = process.argv.includes('--dry');
const AGENTS = [
  { name: 'trinity-orch',   wallet: '0x28Ee130b0500b580967952EE396d4a66Adf9c9E8', squad: 'ORCHESTRATION' },
  { name: 'trinity-w3c',    wallet: '0x7aA57A05A61dd20e0F07B82cC827F5d4a9B848F6', squad: 'ORCHESTRATION' },
  { name: 'trinity-torch',  wallet: '0x3A9061616331B779264A39757c84c46B64955ABF', squad: 'ALPHA' },
  { name: 'trinity-gcm',    wallet: '0x99b2f3A741923A58dA5fF10fB440351ed63178Cc', squad: 'ALPHA' },
  { name: 'trinity-chesed', wallet: '0x62cdd257B9F6ed27320112C13167aC0726630178', squad: 'BETA' },
  { name: 'trinity-mel',    wallet: '0xEf033B6f9cC649d8aD099d7A8e194Eb13AbDB666', squad: 'BETA' },
  { name: 'trinity-apm',    wallet: '0xceD17F65E0e7b3a77D5321A2d3715840317199C', squad: 'BETA' },
  { name: 'trinity-sophia', wallet: '0x7b84CCE5502d393DAa6533285eF3e2f8D3A13261', squad: 'GAMMA' },
  { name: 'trinity-nexus',  wallet: '0x038Fd84EFf76513913d9A39bEB41b8189F3a8a2d', squad: 'GAMMA' },
  { name: 'trinity-hdm',    wallet: '0x74ea6d9565B8E125BaB2FFb491B39E2fA0bA8928', squad: 'GAMMA' },
];
const ABI = require('../src/contracts/IdentityRegistry.abi.json');
async function main() {
  console.log('=== MINT 10 UNMINTED T12 AGENTS (Base Sepolia) ===');
  console.log('Registry:', REGISTRY_ADDRESS);
  console.log('Custodian:', CUSTODIAN);
  console.log('Dry run:', DRY);
  AGENTS.forEach((a,i) => console.log('  '+(i+1)+'. '+a.name+' ('+a.squad+') wallet: '+a.wallet));
  console.log('EXCLUDED (already minted): trinity-shofet, trinity-veritas');
  if (DRY) { console.log('DRY RUN - no transactions.'); return; }
  const pk = process.env.DEPLOYER_PRIVATE_KEY || process.env.ERC8004_MINTER;
  if (!pk) { console.error('No DEPLOYER_PRIVATE_KEY in env.'); process.exit(1); }
  const provider = new ethers.JsonRpcProvider(RPC);
  const wallet = new ethers.Wallet(pk, provider);
  const balance = await provider.getBalance(wallet.address);
  console.log('Signer:', wallet.address, 'Balance:', ethers.formatEther(balance), 'ETH');
  if (balance < ethers.parseEther('0.003')) { console.error('Balance too low.'); process.exit(1); }
  const registry = new ethers.Contract(REGISTRY_ADDRESS, ABI, wallet);
  const results = [];
  for (let i = 0; i < AGENTS.length; i++) {
    const a = AGENTS[i];
    const uri = 'https://trustrepid.dev/agents/' + a.name;
    const metadata = [
      { metadataKey: 'name', metadataValue: ethers.toUtf8Bytes(a.name) },
      { metadataKey: 'squad', metadataValue: ethers.toUtf8Bytes(a.squad) },
      { metadataKey: 'wallet', metadataValue: ethers.toUtf8Bytes(a.wallet) },
      { metadataKey: 'custodian', metadataValue: ethers.toUtf8Bytes(CUSTODIAN) },
      { metadataKey: 'protocol', metadataValue: ethers.toUtf8Bytes('hyperdag') }
    ];
    console.log('\n['+(i+1)+'/'+AGENTS.length+'] Minting: '+a.name+' ('+a.squad+') wallet: '+a.wallet);
    try {
      const tx = await registry['register(string)'](uri, {gasLimit:500000});
      console.log('  TX:', tx.hash);
      const receipt = await tx.wait();
      let tokenId = 'unknown';
      for (const log of receipt.logs) { try { const p = registry.interface.parseLog(log); if (p && p.args && p.args.agentId) tokenId = p.args.agentId.toString(); } catch(e){} }
      if (tokenId === 'unknown') { for (const log of receipt.logs) { try { const p = registry.interface.parseLog(log); if (p && p.args && p.args.tokenId) tokenId = p.args.tokenId.toString(); } catch(e){} } }
      console.log('  SUCCESS tokenId='+tokenId+' https://sepolia.basescan.org/tx/'+tx.hash);
      results.push({agent_name:a.name,wallet:a.wallet,token_id:tokenId,tx_hash:tx.hash,block:receipt.blockNumber,status:'success'});
    } catch(err) { console.error('  FAILED:', err.message); results.push({agent_name:a.name,status:'failed',error:err.message}); }
    await new Promise(r => setTimeout(r, 5000));
  }
  fs.writeFileSync(path.join(__dirname,'..','scratch','mint-t12-correct-results.json'), JSON.stringify(results,null,2));
  console.log('\nSuccess: '+results.filter(r=>r.status==='success').length+'/'+AGENTS.length);
  console.log('\n-- SQL BACKFILL --');
  results.filter(r=>r.status==='success').forEach(r => console.log("UPDATE repid_agents SET erc8004_token_id='"+r.token_id+"', mint_tx_hash='"+r.tx_hash+"', mint_block_number="+r.block+", minted_at=NOW(), mint_chain_id=84532 WHERE agent_name='"+r.agent_name+"';"));
}
main().catch(err => { console.error('Fatal:', err.message); process.exit(1); });
