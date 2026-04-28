import { ethers } from 'ethers';
import * as dotenv from 'dotenv';
dotenv.config();

async function run() {
  const rpcUrl = process.env.BASE_SEPOLIA_RPC_URL || 'https://sepolia.base.org';
  const provider = new ethers.JsonRpcProvider(rpcUrl);
  
  const proxyAddress = '0x8004A818BFB912233c491871b3d84c89A494BD9e';
  
  // EIP-1967 Implementation Slot
  const slot = '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc';
  const implStorage = await provider.getStorage(proxyAddress, slot);
  const implAddress = ethers.getAddress('0x' + implStorage.slice(-40));
  
  console.log('Implementation address:', implAddress);
  
  // Try to use a common V1 Etherscan endpoint if that works
  const url = `https://api-sepolia.basescan.org/api?module=contract&action=getabi&address=${implAddress}`;
  console.log('Fetching ABI from:', url);
  const res = await fetch(url);
  const data = await res.json() as any;
  if (data.status === '1') {
      const fs = require('fs');
      fs.writeFileSync('AgentIdentity_ABI.json', data.result);
      console.log('Saved AgentIdentity_ABI.json');
  } else {
      console.log('Error fetching ABI:', data);
  }
}

run().catch(console.error);
