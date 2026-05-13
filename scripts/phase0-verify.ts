import { createClient } from '@supabase/supabase-js';
import { ethers } from 'ethers';
import * as dotenv from 'dotenv';
import path from 'path';

dotenv.config({ path: path.join(__dirname, '../.env') });

const supabaseUrl = process.env.SUPABASE_URL || '';
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_ANON_KEY || '';

const supabase = createClient(supabaseUrl, supabaseKey);

const DEPLOYER_WALLET = '0xdf6b8215D193b11B4903d223729c3CF7A6de271d';
const CANONICAL_REGISTRY = '0x8004A818BFB912233c491871b3d84c89A494BD9e';
const USDC_ADDRESS = '0x036CbD53842c5426634e7929541eC2318f3dCF7e';

const ERC721_ABI = [
  "function ownerOf(uint256 tokenId) view returns (address)"
];

const ERC20_ABI = [
  "function balanceOf(address account) view returns (uint256)"
];

async function main() {
  console.log('--- Phase 0: Pre-flight Verification ---\n');

  console.log('1. Fetching ANFIS_ROUTING_API_CONTRACT artifact from DB...');
  const { data: artifacts, error: artError } = await supabase
    .from('trinity_artifacts')
    .select('title, content')
    .ilike('title', '%ANFIS_ROUTING_API_CONTRACT%')
    .limit(1);

  if (artError) {
    console.error('Error fetching artifact:', artError.message);
  } else if (!artifacts || artifacts.length === 0) {
    console.error('Artifact not found! Try searching content?');
  } else {
    console.log(`Found Artifact: ${artifacts[0].title}`);
    console.log('--- CONTENT START ---');
    console.log(artifacts[0].content.substring(0, 500) + '...[truncated]');
    console.log('--- CONTENT END ---\n');
    
    const fs = require('fs');
    fs.writeFileSync('E:/dev/reports/2026-05-13/ANFIS_ROUTING_API_CONTRACT.md', artifacts[0].content);
    console.log('Saved artifact to E:/dev/reports/2026-05-13 folder.');
  }

  const provider = new ethers.JsonRpcProvider('https://sepolia.base.org');

  console.log('\n2. Checking Deployer ETH balance...');
  const ethBalance = await provider.getBalance(DEPLOYER_WALLET);
  const ethFormatted = ethers.formatEther(ethBalance);
  console.log(`Deployer ETH Balance: ${ethFormatted} ETH`);
  if (parseFloat(ethFormatted) < 0.005) {
    console.error('WARNING: ETH Balance is below 0.005 ETH');
  }

  console.log('\n3. Checking Deployer USDC balance...');
  const usdcContract = new ethers.Contract(USDC_ADDRESS, ERC20_ABI, provider);
  const usdcBalance = await usdcContract.balanceOf(DEPLOYER_WALLET);
  const usdcFormatted = ethers.formatUnits(usdcBalance, 6);
  console.log(`Deployer USDC Balance: ${usdcFormatted} USDC`);
  if (parseFloat(usdcFormatted) < 5) {
    console.error('WARNING: USDC Balance is below 5 USDC');
  }

  console.log('\n4. Checking ERC-8004 Token Ownership...');
  const registryContract = new ethers.Contract(CANONICAL_REGISTRY, ERC721_ABI, provider);
  try {
    const owner5864 = await registryContract.ownerOf(5864);
    console.log(`Token #5864 (trinity-veritas) owned by: ${owner5864}`);
  } catch (err: any) {
    console.error('Error fetching owner of #5864:', err.message);
  }

  try {
    const owner5863 = await registryContract.ownerOf(5863);
    console.log(`Token #5863 (trinity-shofet) owned by: ${owner5863}`);
  } catch (err: any) {
    console.error('Error fetching owner of #5863:', err.message);
  }

  console.log('\nPhase 0 Checks Complete.');
}

main().catch(console.error);
