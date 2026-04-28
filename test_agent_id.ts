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
  
  const apmReal = '0xceD17F65E03e7b3a77D5321A2d3715840317199C';
  
  const agentIdFromAddress = BigInt(apmReal);
  console.log('Testing agentId:', agentIdFromAddress.toString());
  
  try {
     const wallet = await contract.getAgentWallet(agentIdFromAddress);
     console.log('getAgentWallet returned:', wallet);
  } catch(e: any) {
     console.log('getAgentWallet error:', e.message);
  }
}
run().catch(console.error);
