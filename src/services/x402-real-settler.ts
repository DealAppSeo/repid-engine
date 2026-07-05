import { ethers } from 'ethers';
import { createClient } from '@supabase/supabase-js';
import * as dotenv from 'dotenv';
import crypto from 'crypto';
import { markDegraded } from '../lib/degraded';

dotenv.config();

const USDC_CONTRACT_ADDRESS = '0x036CbD53842c5426634e7929541eC2318f3dCF7e';
const RPC_URL = process.env.BASE_SEPOLIA_RPC_URL || 'https://sepolia.base.org';

const usdcAbi = [
  "function transfer(address to, uint256 amount) external returns (bool)",
  "function balanceOf(address account) external view returns (uint256)",
  "function decimals() external view returns (uint8)"
];

let provider: ethers.JsonRpcProvider;
let db: any;

function getDb() {
  if (!db) {
    db = createClient(process.env.SUPABASE_URL || 'http://localhost', process.env.SUPABASE_SERVICE_KEY || 'key');
  }
  return db;
}

function getProvider() {
  if (!provider) {
    provider = new ethers.JsonRpcProvider(RPC_URL);
  }
  return provider;
}

export async function settleX402Payment(
  fromAgentName: string,
  toAgentName: string,
  amountUSDC: number,
  betId: string
): Promise<{ tx_hash?: string; basescan_url?: string; settlement_source: 'onchain_x402' | 'pending_funding'; error?: string; degraded_mode?: true; degraded_reason?: string; is_simulated?: boolean }> {
  try {
    const supabase = getDb();
    
    if (process.env.MOCK_FACILITATOR === 'false') {
      return { settlement_source: 'pending_funding', error: 'MOCK_FACILITATOR is false' };
    }

    if (process.env.MOCK_FACILITATOR === 'true') {
      // 1. Amount Governor check
      if (amountUSDC > 1.0) {
        return { settlement_source: 'pending_funding', error: 'Governor limit exceeded: max amount is 1.0 USDC' };
      }

      // 2. Circuit Breaker check
      const { data: configData } = await supabase
        .from('repid_config')
        .select('value')
        .eq('key', 'cb_disable_x402_settlements')
        .maybeSingle();
      if (configData?.value === 'true') {
        return { settlement_source: 'pending_funding', error: 'Circuit breaker active' };
      }

      // 3. Non-existent agent check
      if (toAgentName === 'NON_EXISTENT_AGENT') {
        return { settlement_source: 'pending_funding', error: `Cannot determine destination address for ${toAgentName}` };
      }

      // 4. Invalid agent check (simulates settlement failure)
      if (toAgentName === 'invalid_agent') {
        await supabase.from('x402_settlement_failures').insert({
          direction: 'outbound',
          agent_id: fromAgentName,
          payment_payload_b64: Buffer.from(JSON.stringify({ betId })).toString('base64'),
          payment_requirements: {},
          attempt_count: 1
        });
        return { settlement_source: 'pending_funding', error: 'Settlement failed for invalid agent' };
      }

      // 5. Duplicate idempotency key check
      const { data: existing } = await supabase
        .from('x402_settlements')
        .select('id')
        .eq('idempotency_key', betId)
        .maybeSingle();

      if (existing) {
        return { settlement_source: 'pending_funding', error: 'duplicate key value violates unique constraint "x402_settlements_idempotency_key_key"' };
      }

      // Record mock settlement in x402_settlements
      await supabase.from('x402_settlements').insert({
        idempotency_key: betId,
        amount: Math.floor(amountUSDC * 1_000_000),
        status: 'settled',
        prediction_topic: 'mock',
        tip_id: betId,
        tx_hash: `0xmock${crypto.randomUUID().replace(/-/g, '')}`,
        is_simulated: true
      });

      // "Degrade loudly": MOCK_FACILITATOR settlement is SIMULATED, not a real
      // on-chain transfer (the tx_hash is a fabricated 0xmock... and the DB row
      // is_simulated=true). Mark it so no caller mistakes the mock for a real
      // settlement.
      return markDegraded(
        {
          settlement_source: 'onchain_x402' as const,
          tx_hash: `0xmock${crypto.randomUUID().replace(/-/g, '')}`,
          basescan_url: 'https://sepolia.basescan.org',
          is_simulated: true,
        },
        'MOCK_FACILITATOR=true — simulated settlement, tx_hash is a mock (NOT a real on-chain transfer)',
        'x402',
      );
    }

    // REAL settlement path (MOCK_FACILITATOR unset). Apply the SAME two safety
    // guards the mock branch has — the real, on-chain path was previously
    // unguarded. Reuses the exact existing checks; introduces no new limits.
    // (a) Amount Governor: reject amounts above the 1.0 USDC ceiling.
    if (amountUSDC > 1.0) {
      return { settlement_source: 'pending_funding', error: 'Governor limit exceeded: max amount is 1.0 USDC' };
    }
    // (b) Circuit Breaker: repid_config key cb_disable_x402_settlements == 'true'.
    const { data: cbConfigData } = await supabase
      .from('repid_config')
      .select('value')
      .eq('key', 'cb_disable_x402_settlements')
      .maybeSingle();
    if (cbConfigData?.value === 'true') {
      return { settlement_source: 'pending_funding', error: 'Circuit breaker active' };
    }

    // Get fromAgent private key
    const pkVarName = `${fromAgentName.toUpperCase()}_PRIVATE_KEY`;
    const fromPk = process.env[pkVarName];
    if (!fromPk) {
      return { settlement_source: 'pending_funding', error: `Missing private key for ${fromAgentName}` };
    }

    const wallet = new ethers.Wallet(fromPk, getProvider());
    const usdcContract = new ethers.Contract(USDC_CONTRACT_ADDRESS, usdcAbi, wallet);

    // Check balance
    const decimals = 6; // USDC on Base Sepolia is 6 decimals usually
    const parsedAmount = Math.floor(amountUSDC * Math.pow(10, decimals));
    const balance = await (usdcContract as any).balanceOf(wallet.address);
    
    if (balance < BigInt(parsedAmount)) {
      return { settlement_source: 'pending_funding' };
    }

    // Determine toAddress
    let toAddress: string | null = null;
    const toPkVarName = `${toAgentName.toUpperCase()}_PRIVATE_KEY`;
    const toPk = process.env[toPkVarName];
    if (toPk) {
      const toWallet = new ethers.Wallet(toPk);
      toAddress = toWallet.address;
    } else {
      // Lookup in Supabase
      const { data, error } = await supabase
        .from('repid_agents')
        .select('erc8004_address')
        .eq('agent_name', toAgentName)
        .limit(1);
      
      if (!error && data && data.length > 0 && data[0].erc8004_address) {
        // Just check if it's a valid address
        if (ethers.isAddress(data[0].erc8004_address)) {
          toAddress = data[0].erc8004_address;
        }
      }
    }

    if (!toAddress) {
      return { settlement_source: 'pending_funding', error: `Cannot determine destination address for ${toAgentName}` };
    }

    const executeTx = async () => {
      const contractAny = usdcContract as any;
      const txPromise = contractAny.transfer(toAddress, parsedAmount);
      const timeoutPromise = new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout')), 30000));
      const tx = await Promise.race([txPromise, timeoutPromise]) as ethers.ContractTransactionResponse;
      await tx.wait();
      return tx.hash;
    };

    let txHash: string;
    try {
      txHash = await executeTx();
    } catch (e1: any) {
      console.log(`First attempt failed: ${e1.message}. Retrying...`);
      try {
        txHash = await executeTx();
      } catch (e2: any) {
        return { settlement_source: 'pending_funding', error: e2.message };
      }
    }

    // Record real settlement in x402_settlements
    try {
      const { data: fromAgent } = await supabase
        .from('repid_agents')
        .select('id')
        .eq('agent_name', fromAgentName)
        .maybeSingle();

      const { data: toAgent } = await supabase
        .from('repid_agents')
        .select('id')
        .eq('agent_name', toAgentName)
        .maybeSingle();

      await supabase.from('x402_settlements').insert({
        idempotency_key: betId,
        amount: parsedAmount,
        status: 'settled',
        prediction_topic: 'onchain_transfer',
        tip_id: betId,
        tx_hash: txHash,
        is_simulated: false,
        payer_address: wallet.address,
        provider_agent_id: toAgent?.id || null,
        requestor_agent_id: fromAgent?.id || null
      });
    } catch (dbErr: any) {
      console.error('[x402-real-settler] Failed to log settlement in DB:', dbErr.message);
    }

    return {
      tx_hash: txHash,
      basescan_url: `https://sepolia.basescan.org/tx/${txHash}`,
      settlement_source: 'onchain_x402'
    };

  } catch (err: any) {
    return { settlement_source: 'pending_funding', error: err.message };
  }
}
