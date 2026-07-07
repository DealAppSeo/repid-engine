/**
 * Faucet routes — the "get testnet tokens" step of the E2E user journey.
 *
 * PUBLIC, read-only. Mounted BEFORE authMiddleware (no API key required), like the
 * other public read surfaces. NO writes, NO keys, NO tx. We do NOT dispense tokens —
 * we point the user at the PUBLIC Base-Sepolia faucets and let them confirm their own
 * balance is enough to stake.
 *
 *   GET /api/v1/faucet/info                 → public faucet URLs, chain, staking min, USDC token
 *   GET /api/v1/faucet/balance?address=0x.. → read-only balance + enough_to_stake gate + next step
 *
 * NO-LOCK-IN (E:\dev\living-docs\NO_LOCK_IN_INVARIANTS.md):
 *   chain / RPC / USDC token come from getActiveNetwork() (env-overridable); faucet URLs +
 *   staking min come from src/config/faucet.ts (env-overridable). Nothing chain-specific is
 *   hardcoded in this handler, so a different chain/token/faucet slots in via config alone.
 */
import { Router, Request, Response } from 'express';
import { ethers } from 'ethers';
import { getActiveNetwork } from '../config/network';
import {
  getFaucetSources,
  STAKING_MIN_ETH,
  STAKING_SUGGESTED_ETH,
} from '../config/faucet';

const router = Router();

// Minimal ERC-20 read ABI — balance + decimals only. No write methods on purpose.
const ERC20_READ_ABI = [
  'function balanceOf(address account) external view returns (uint256)',
  'function decimals() external view returns (uint8)',
];

/**
 * GET /api/v1/faucet/info
 * Static/config-driven. Tells the client where to fund a wallet and what "enough" means.
 * Honest: we point at public faucets; we do not dispense.
 */
router.get('/faucet/info', (_req: Request, res: Response): void => {
  const network = getActiveNetwork();
  res.json({
    dispenses: false,
    message:
      'We do not run a faucet. Fund your wallet from one of the public faucets below, then check your balance at /api/v1/faucet/balance.',
    chain_id: network.chainId,
    network: network.name,
    usdc_token_address: network.contracts.usdc,
    staking_min_eth: STAKING_MIN_ETH,
    staking_suggested_eth: STAKING_SUGGESTED_ETH,
    faucets: getFaucetSources(),
  });
});

/**
 * GET /api/v1/faucet/balance?address=0x...
 * Read-only Base-Sepolia balance lookup + enough_to_stake gate + a next_step hint.
 * Reuses the ethers JsonRpcProvider pattern from src/services/erc8004-minter.ts.
 */
router.get('/faucet/balance', async (req: Request, res: Response): Promise<void> => {
  const address = (req.query.address as string | undefined)?.trim();

  if (!address) {
    res.status(400).json({
      error: 'MISSING_ADDRESS',
      message: 'Provide an EVM address, e.g. /api/v1/faucet/balance?address=0xYourWallet',
    });
    return;
  }
  if (!ethers.isAddress(address)) {
    res.status(400).json({
      error: 'INVALID_ADDRESS',
      message: `"${address}" is not a valid EVM address (expected 0x + 40 hex chars).`,
    });
    return;
  }

  const network = getActiveNetwork();
  const faucets = getFaucetSources();
  const minWei = ethers.parseEther(STAKING_MIN_ETH);
  const suggestedWei = ethers.parseEther(STAKING_SUGGESTED_ETH);
  const primaryFaucet = faucets[0]?.url ?? null;

  try {
    const provider = new ethers.JsonRpcProvider(network.rpcUrl);

    // Native ETH balance (always available).
    const ethWei = await provider.getBalance(address);

    // USDC balance — best-effort. If the token read reverts (e.g. token not deployed on
    // this chain), we still return the ETH-based gate rather than failing the whole request.
    let usdcBalance: string | null = null;
    if (network.contracts.usdc) {
      try {
        const usdc = new ethers.Contract(network.contracts.usdc, ERC20_READ_ABI, provider);
        const [rawBal, decimals] = await Promise.all([
          (usdc as any).balanceOf(address) as Promise<bigint>,
          (usdc as any).decimals() as Promise<bigint>,
        ]);
        usdcBalance = ethers.formatUnits(rawBal, Number(decimals));
      } catch {
        usdcBalance = null; // token not readable on this network — non-fatal.
      }
    }

    const enoughToStake = ethWei >= minWei;
    const enoughForGas = ethWei >= suggestedWei;

    let nextStep: string;
    if (!enoughToStake) {
      nextStep = primaryFaucet
        ? `Fund your wallet at ${primaryFaucet} — you need at least ${STAKING_MIN_ETH} ETH to stake.`
        : `Fund your wallet at a public Base Sepolia faucet — you need at least ${STAKING_MIN_ETH} ETH to stake.`;
    } else if (!enoughForGas) {
      nextStep = primaryFaucet
        ? `You meet the ${STAKING_MIN_ETH} ETH minimum, but top up toward ${STAKING_SUGGESTED_ETH} ETH at ${primaryFaucet} to also cover gas for the stake tx.`
        : `You meet the ${STAKING_MIN_ETH} ETH minimum; top up toward ${STAKING_SUGGESTED_ETH} ETH to also cover gas for the stake tx.`;
    } else {
      nextStep = 'Ready to stake.';
    }

    res.json({
      address,
      chain_id: network.chainId,
      network: network.name,
      eth_balance: ethers.formatEther(ethWei),
      usdc_balance: usdcBalance,
      usdc_token_address: network.contracts.usdc,
      staking_min_eth: STAKING_MIN_ETH,
      staking_suggested_eth: STAKING_SUGGESTED_ETH,
      enough_to_stake: enoughToStake,
      enough_for_gas: enoughForGas,
      next_step: nextStep,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    res.status(502).json({
      error: 'RPC_ERROR',
      message: `Could not read balance from the ${network.name} RPC endpoint.`,
      detail: msg,
    });
  }
});

export default router;
