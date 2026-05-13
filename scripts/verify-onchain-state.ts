import { createClient } from '@supabase/supabase-js';
import { ethers } from 'ethers';
import * as dotenv from 'dotenv';
import path from 'path';
import fs from 'fs';

dotenv.config({ path: path.join(__dirname, '../.env') });

const supabaseUrl = process.env.SUPABASE_URL || '';
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_ANON_KEY || '';

const supabase = createClient(supabaseUrl, supabaseKey);

const CANONICAL_REGISTRY = '0x8004A818BFB912233c491871b3d84c89A494BD9e';
const USDC_ADDRESS = '0x036CbD53842c5426634e7929541eC2318f3dCF7e';

const ERC721_ABI = ["function ownerOf(uint256 tokenId) view returns (address)"];
const ERC20_ABI = ["function balanceOf(address account) view returns (uint256)"];

async function main() {
  console.log('--- Track 1: On-chain State Verification ---\n');

  console.log('1. Fetching repid_agents from DB...');
  const { data: agents, error: agentError } = await supabase
    .from('repid_agents')
    .select('agent_name, squad_id, squad_role, wallet_address, erc8004_token_id')
    .ilike('agent_name', 'trinity-%')
    .order('squad_id', { ascending: true })
    .order('squad_role', { ascending: false })
    .order('agent_name', { ascending: true });

  if (agentError) {
    console.error('Error fetching agents:', agentError.message);
    process.exit(1);
  }

  const provider = new ethers.JsonRpcProvider('https://sepolia.base.org');
  const usdcContract = new ethers.Contract(USDC_ADDRESS, ERC20_ABI, provider);
  const registryContract = new ethers.Contract(CANONICAL_REGISTRY, ERC721_ABI, provider);

  let markdownOutput = '| Agent | Wallet | ETH | USDC | Token | Owner | OK? |\n';
  markdownOutput += '|---|---|---|---|---|---|---|\n';

  console.log('Agent | Wallet | ETH | USDC | Token | Owner | OK?');
  console.log('-----------------------------------------------------');

  for (const agent of agents || []) {
    const wallet = agent.wallet_address || 'NULL';
    let ethStr = '0.000';
    let usdcStr = '0.000';
    let tokenStr = agent.erc8004_token_id ? agent.erc8004_token_id.toString() : '-';
    let ownerStr = '-';
    let isOk = '✅';

    if (wallet && wallet !== 'NULL' && wallet.startsWith('0x')) {
      try {
        const ethBalance = await provider.getBalance(wallet);
        ethStr = parseFloat(ethers.formatEther(ethBalance)).toFixed(3);
        
        const usdcBalance = await usdcContract.balanceOf(wallet);
        usdcStr = parseFloat(ethers.formatUnits(usdcBalance, 6)).toFixed(3);
      } catch(e: any) {
        ethStr = 'ERR';
        usdcStr = 'ERR';
        isOk = '❌';
      }
    } else {
      isOk = '❌';
    }

    if (agent.erc8004_token_id) {
      try {
        const owner = await registryContract.ownerOf(agent.erc8004_token_id);
        const isDeployer = owner.toLowerCase() === '0xdf6b8215D193b11B4903d223729c3CF7A6de271d'.toLowerCase();
        ownerStr = isDeployer ? `${owner.substring(0,6)}...(Deployer)` : `${owner.substring(0,6)}...`;
      } catch (err) {
        ownerStr = 'ERR';
        isOk = '❌';
      }
    }

    const shortWallet = wallet !== 'NULL' ? `${wallet.substring(0,6)}...` : 'NULL';
    
    const row = `| ${agent.agent_name} | ${shortWallet} | ${ethStr} | ${usdcStr} | ${tokenStr} | ${ownerStr} | ${isOk} |`;
    console.log(row);
    markdownOutput += row + '\n';
  }

  const reportPath = 'E:/dev/reports/2026-05-13/ONCHAIN_STATE_VERIFY.md';
  fs.writeFileSync(reportPath, markdownOutput);
  console.log(`\nSaved verification report to ${reportPath}`);
}

main().catch(console.error);
