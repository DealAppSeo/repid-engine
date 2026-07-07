/**
 * check-testnet-balance.ts — read-only Base Sepolia balance checker.
 *
 * Tells a new user whether their wallet has enough test ETH to stake against the
 * on-chain RepIDStaking contract (MIN_STAKE = 0.0001 ETH), and points them at the
 * public faucet if not.
 *
 * This script NEVER signs, sends, or writes anything. It needs no private keys and
 * no API keys — it only calls a public JSON-RPC endpoint (eth_getBalance).
 *
 * Usage (matches repo convention — other scripts run the same way):
 *   npx ts-node scripts/check-testnet-balance.ts 0xYourWalletAddress
 *   WALLET_ADDRESS=0xYourWalletAddress npx ts-node scripts/check-testnet-balance.ts
 *
 * Optional env:
 *   BASE_SEPOLIA_RPC_URL   override the default public RPC (https://sepolia.base.org)
 *
 * Exit codes: 0 = enough to stake, 1 = not enough / no address, 2 = RPC/network error.
 */
import { JsonRpcProvider, formatEther, isAddress, parseEther } from 'ethers';

const DEFAULT_RPC_URL = 'https://sepolia.base.org';
const FAUCET_URL = 'https://www.coinbase.com/faucets/base-sepolia';
const FAUCET_URL_ALT = 'https://sepolia.base.org/faucet';
// RepIDStaking.sol: uint256 public constant MIN_STAKE = 0.0001 ether;
const MIN_STAKE_ETH = '0.0001';
// A small buffer so the user can also pay gas for the stake transaction itself.
const SUGGESTED_MIN_ETH = '0.001';

function resolveAddress(): string | null {
  const fromArg = process.argv[2]?.trim();
  const fromEnv = process.env.WALLET_ADDRESS?.trim();
  return fromArg || fromEnv || null;
}

async function main(): Promise<number> {
  const address = resolveAddress();

  if (!address) {
    console.error('No wallet address provided.');
    console.error('  Usage: npx ts-node scripts/check-testnet-balance.ts 0xYourWalletAddress');
    console.error('  or set WALLET_ADDRESS in the environment.');
    return 1;
  }

  if (!isAddress(address)) {
    console.error(`"${address}" is not a valid Ethereum address (expected 0x + 40 hex chars).`);
    return 1;
  }

  const rpcUrl = process.env.BASE_SEPOLIA_RPC_URL?.trim() || DEFAULT_RPC_URL;
  console.log(`Network : Base Sepolia (chainId 84532)`);
  console.log(`RPC     : ${rpcUrl}`);
  console.log(`Wallet  : ${address}`);

  let balanceWei: bigint;
  try {
    const provider = new JsonRpcProvider(rpcUrl);
    balanceWei = await provider.getBalance(address);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`\nCould not reach the RPC endpoint: ${msg}`);
    console.error('Check your internet connection, or set a different BASE_SEPOLIA_RPC_URL.');
    return 2;
  }

  const balanceEth = formatEther(balanceWei);
  const minStakeWei = parseEther(MIN_STAKE_ETH);
  const suggestedWei = parseEther(SUGGESTED_MIN_ETH);

  console.log(`\nBalance : ${balanceEth} ETH`);

  if (balanceWei >= suggestedWei) {
    console.log(`\n[OK] You have enough test ETH to stake and pay gas.`);
    console.log(`     Minimum on-chain stake is ${MIN_STAKE_ETH} ETH (RepIDStaking.MIN_STAKE).`);
    return 0;
  }

  if (balanceWei >= minStakeWei) {
    console.log(`\n[TIGHT] You meet the ${MIN_STAKE_ETH} ETH minimum stake, but you are below`);
    console.log(`        the suggested ${SUGGESTED_MIN_ETH} ETH that also covers gas for the stake tx.`);
    console.log(`        Consider topping up from the faucet before staking:`);
    console.log(`          ${FAUCET_URL}`);
    console.log(`          ${FAUCET_URL_ALT}`);
    return 0;
  }

  console.log(`\n[NEED FUNDS] Balance is below the ${MIN_STAKE_ETH} ETH minimum stake.`);
  console.log(`             Get free Base Sepolia test ETH (~0.05 ETH per drip) from the public faucet:`);
  console.log(`               ${FAUCET_URL}`);
  console.log(`               ${FAUCET_URL_ALT}`);
  console.log(`             There is no in-app faucet — funding comes from the public Base Sepolia faucet.`);
  return 1;
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error('Unexpected error:', err);
    process.exit(2);
  });
