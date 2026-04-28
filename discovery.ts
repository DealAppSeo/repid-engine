// @ts-nocheck
import { ethers } from 'ethers';
import { createClient } from '@supabase/supabase-js';
import * as dotenv from 'dotenv';
dotenv.config();

async function run() {
  const rpcUrl = process.env.BASE_SEPOLIA_RPC_URL || 'https://sepolia.base.org';
  const provider = new ethers.JsonRpcProvider(rpcUrl);
  
  const proxyAddress = '0x8004A818BFB912233c491871b3d84c89A494BD9e';
  
  const fs = require('fs');
  const abi = JSON.parse(fs.readFileSync('../hyperdag-protocol/abi/AgentIdentity.json', 'utf8'));
  const contract = new ethers.Contract(proxyAddress, abi, provider);
  
  const owner = await contract.owner();
  console.log('Contract Owner (Deployer):', owner);
  
  const apmReal = ethers.getAddress('0xceD17F65E03e7b3a77D5321A2d3715840317199C'.toLowerCase());
  const veritasReal = ethers.getAddress('0x2832eB385cbe9e71aCf2351489eb62F970EEbe9b'.toLowerCase());
  
  try {
     const apmBal = await contract.balanceOf(apmReal);
     console.log('APM Balance:', apmBal.toString());
  } catch (e: any) { console.log('APM Balance err:', e.message); }
  
  try {
     const veritasBal = await contract.balanceOf(veritasReal);
     console.log('VERITAS Balance:', veritasBal.toString());
  } catch (e: any) { console.log('VERITAS Balance err:', e.message); }

  const db = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_KEY!);
  await db.from('repid_agents').update({ erc8004_address: apmReal }).eq('agent_name', 'APM');
  await db.from('repid_agents').update({ erc8004_address: veritasReal }).eq('agent_name', 'VERITAS');
  
  const latestBlock = await provider.getBlockNumber();
  const startBlock = 36304145; // Deployment block
  
  const filterAPM = contract.filters.Transfer(null, apmReal);
  const filterVERITAS = contract.filters.Transfer(null, veritasReal);

  console.log(`Querying events from block ${startBlock} to ${latestBlock}...`);
  
  let eventsAPM = [];
  let eventsVERITAS = [];
  
  const ranges = [];
  for (let from = startBlock; from <= latestBlock; from += 9999) {
    ranges.push({ from, to: Math.min(from + 9999, latestBlock) });
  }

  // Fetch in batches of 20 concurrent requests to avoid rate limits
  for (let i = 0; i < ranges.length; i += 20) {
    const batch = ranges.slice(i, i + 20);
    const promises = batch.map(async ({ from, to }) => {
      const p1 = contract.queryFilter(filterAPM, from, to).catch(() => []);
      const p2 = contract.queryFilter(filterVERITAS, from, to).catch(() => []);
      return Promise.all([p1, p2]);
    });
    
    const results = await Promise.all(promises);
    for (const [apmChunk, veritasChunk] of results) {
      eventsAPM.push(...apmChunk);
      eventsVERITAS.push(...veritasChunk);
    }
  }

  eventsAPM.sort((a, b) => a.blockNumber - b.blockNumber);
  const apmIds = eventsAPM.map(e => e.args ? e.args[2].toString() : '').filter(Boolean);
  console.log('APM token IDs:', apmIds);
  
  if (apmIds.length > 0) {
    const firstApmId = apmIds[0];
    await db.from('repid_agents').update({ erc8004_token_id: firstApmId }).eq('agent_name', 'APM');
    console.log(`APM agentId: ${firstApmId}`);
    try {
      const ownerApm = await contract.ownerOf(firstApmId);
      console.log(`Owner of APM agentId ${firstApmId}: ${ownerApm}`);
    } catch (err: any) {
      console.log(`Error getting ownerOf for APM: ${err.message}`);
    }
  } else {
    console.log("APM agentId: null");
  }

  eventsVERITAS.sort((a, b) => a.blockNumber - b.blockNumber);
  const veritasIds = eventsVERITAS.map(e => e.args ? e.args[2].toString() : '').filter(Boolean);
  console.log('VERITAS token IDs:', veritasIds);
  
  if (veritasIds.length > 0) {
    const firstVeritasId = veritasIds[0];
    await db.from('repid_agents').update({ erc8004_token_id: firstVeritasId }).eq('agent_name', 'VERITAS');
    console.log(`VERITAS agentId: ${firstVeritasId}`);
    try {
      const ownerVeritas = await contract.ownerOf(firstVeritasId);
      console.log(`Owner of VERITAS agentId ${firstVeritasId}: ${ownerVeritas}`);
    } catch (err: any) {
      console.log(`Error getting ownerOf for VERITAS: ${err.message}`);
    }
  } else {
    console.log("VERITAS agentId: null");
  }
}
run().catch(console.error);
