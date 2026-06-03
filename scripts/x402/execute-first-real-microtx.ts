import { settleX402Payment } from '../../src/services/x402-real-settler';
import { ethers } from 'ethers';
import crypto from 'crypto';

const USDC_CONTRACT_ADDRESS = '0x036CbD53842c5426634e7929541eC2318f3dCF7e';
const RPC_URL = process.env.BASE_SEPOLIA_RPC_URL || 'https://sepolia.base.org';

async function main() {
  console.log('Starting execute-first-real-microtx on Base Sepolia...');


  const provider = new ethers.JsonRpcProvider(RPC_URL);
  const veritasPk = process.env.BASE_SEPOLIA_PRIVATE_KEY;
  if (!veritasPk) {
    console.error('BASE_SEPOLIA_PRIVATE_KEY is missing from env.');
    process.exit(1);
  }

  const wallet = new ethers.Wallet(veritasPk, provider);
  console.log(`Base Sepolia Sender Address: ${wallet.address}`);

  const ethBalance = await provider.getBalance(wallet.address);
  console.log(`ETH Balance: ${ethers.formatEther(ethBalance)} ETH`);

  const usdcContract = new ethers.Contract(
    USDC_CONTRACT_ADDRESS,
    ['function balanceOf(address) view returns (uint256)'],
    provider
  );
  const usdcBalance = await (usdcContract as any).balanceOf(wallet.address);
  console.log(`USDC Balance: ${ethers.formatUnits(usdcBalance, 6)} USDC`);

  if (ethBalance < ethers.parseEther('0.0001')) {
    console.error('Insufficient ETH for gas.');
    process.exit(1);
  }
  if (usdcBalance < ethers.parseUnits('0.01', 6)) {
    console.error('Insufficient USDC balance (needs at least 0.01 USDC).');
    process.exit(1);
  }

  const betId = 'microtx-' + crypto.randomUUID();
  console.log(`Initiating real micro-transaction with betId: ${betId}`);
  const result = await settleX402Payment('BASE_SEPOLIA', 'SOPHIA', 0.01, betId);
  console.log('Execution result:', JSON.stringify(result, null, 2));
}

main().catch(console.error);
