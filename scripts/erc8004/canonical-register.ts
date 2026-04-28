// @ts-nocheck
import { ethers } from 'ethers';
import { createClient } from '@supabase/supabase-js';
import * as dotenv from 'dotenv';
dotenv.config();

async function run() {
  const rpcUrl = process.env.BASE_SEPOLIA_RPC_URL || 'https://sepolia.base.org';
  const provider = new ethers.JsonRpcProvider(rpcUrl);
  
  const registryAddress = '0x7177a6867296406881E20d6647232314736Dd09A';
  
  const fs = require('fs');
  const abi = JSON.parse(fs.readFileSync('../hyperdag-protocol/abi/canonical/IdentityRegistry.json', 'utf8'));
  
  const db = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_KEY!);
  
  const agentNames = [
    'TORCH', 'GCM', 'CHESED', 'MEL', 'SOPHIA', 
    'NEXUS', 'HDM', 'ORCH', 'W3C', 'SHOFET'
  ];
  
  const agents = agentNames.map(name => ({
    name,
    pk: process.env[`${name}_PRIVATE_KEY`]
  }));
  
  const logFile = 'canonical-register-all-output-2026-04-28.log';
  fs.writeFileSync(logFile, `Canonical Registration Log - ${new Date().toISOString()}\n\n`);
  
  function logOutput(msg: string) {
    console.log(msg);
    fs.appendFileSync(logFile, msg + '\n');
  }
  
  for (const agent of agents) {
    if (!agent.pk) {
      logOutput(`${agent.name} canonical registration failed: Missing private key`);
      continue;
    }
    
    try {
      const wallet = new ethers.Wallet(agent.pk, provider);
      const contract = new ethers.Contract(registryAddress, abi, wallet);
      
      logOutput(`Registering ${agent.name}...`);
      const tx = await contract['register()']();
      const receipt = await tx.wait();
      
      // agentId is returned or emitted in Registered event
      // Wait, register returns uint256, but in ethers tx.wait() doesn't return the return value.
      // We can parse the Transfer event or Registered event.
      // ERC721 Transfer(address from, address to, uint256 tokenId)
      // Registered(uint256 indexed agentId, string agentURI, address indexed owner)
      
      let agentId = null;
      for (const log of receipt.logs) {
        try {
          const parsed = contract.interface.parseLog(log);
          // Registered event might not be in the human readable ABI I saved, but Transfer is standard ERC721
          // I will just use the returned agentId from static call, or check the db
          // Wait, I can do a static call first to get the ID!
        } catch (e) {}
      }
      
      // Let's do staticCall to get agentId
      agentId = await contract['register()'].staticCall();
      // Wait, staticCall will return the ID that WOULD be minted. But we already sent tx.
      // Let's just find the Transfer event. The Transfer event has topic0 = keccak256("Transfer(address,address,uint256)")
      const transferTopic = ethers.id("Transfer(address,address,uint256)");
      for (const log of receipt.logs) {
        if (log.topics[0] === transferTopic) {
           agentId = BigInt(log.topics[3]).toString();
        }
      }
      
      if (!agentId) {
         logOutput(`${agent.name} registration failed: Could not find agentId in logs`);
         continue;
      }

      await db.from('repid_agents').update({ canonical_agent_id: agentId }).eq('agent_name', agent.name);
      logOutput(`${agent.name} canonical agentId: ${agentId}, tx: ${tx.hash}`);
      
    } catch (err: any) {
      logOutput(`${agent.name} canonical registration failed: ${err.message}`);
    }
  }
}

run().catch(console.error);
