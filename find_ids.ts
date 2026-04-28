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
  
  const apmReal = '0xceD17F65E03e7b3a77D5321A2d3715840317199C'.toLowerCase();
  const veritasReal = '0x2832eB385cbe9e71aCf2351489eb62F970EEbe9b'.toLowerCase();
  
  console.log('Scanning for APM and VERITAS agent IDs...');
  
  for (let i = 1; i <= 50; i++) {
     try {
         const owner = await contract.ownerOf(i);
         if (owner.toLowerCase() === apmReal) {
             console.log(`Found APM agentId: ${i}`);
         }
         if (owner.toLowerCase() === veritasReal) {
             console.log(`Found VERITAS agentId: ${i}`);
         }
     } catch (e: any) {
         // ERC721NonexistentToken or something, skip
     }
  }
}
run().catch(console.error);
