// @ts-nocheck
import { ethers } from 'ethers';
import * as dotenv from 'dotenv';
dotenv.config();

async function run() {
  const rpcUrl = process.env.BASE_SEPOLIA_RPC_URL || 'https://sepolia.base.org';
  const provider = new ethers.JsonRpcProvider(rpcUrl);
  const proxyAddress = '0x8004A818BFB912233c491871b3d84c89A494BD9e';
  
  const fs = require('fs');
  const abi = JSON.parse(fs.readFileSync('../hyperdag-protocol/abi/AgentIdentity.json', 'utf8'));
  const contract = new ethers.Contract(proxyAddress, abi, provider);
  
  const apmErc8004 = '0x8004Apm0001122334455667788990066FF11'; // Not valid hex
  // Let's test the hash of the agent name
  const nameHash = ethers.id('APM');
  console.log('Testing ID from name hash:', nameHash);
  try {
     const wallet = await contract.getAgentWallet(nameHash);
     console.log('getAgentWallet returned:', wallet);
  } catch(e) {}
  
  // Try to test events using chunking backwards
  const currentBlock = await provider.getBlockNumber();
  const step = 9999;
  console.log(`Current block: ${currentBlock}, searching for Transfer events...`);
  
  for (let b = currentBlock; b > currentBlock - 200000; b -= step) {
      const fromBlock = b - step;
      const events = await contract.queryFilter(contract.filters.Transfer(null, '0xceD17F65E03e7b3a77D5321A2d3715840317199C'), fromBlock, b);
      if (events.length > 0) {
          console.log(`Found APM events in block ${fromBlock}-${b}:`, events.map(e => e.args ? e.args[2].toString() : ''));
          break;
      }
  }
}
run().catch(console.error);
