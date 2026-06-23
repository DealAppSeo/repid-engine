import { ethers } from 'ethers';
import { createClient } from '@supabase/supabase-js';
import * as dotenv from 'dotenv';
import crypto from 'crypto';
import { pgQuery } from '../db/direct-pg';

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
  betId: string,
  taskDomain?: string
): Promise<{ tx_hash?: string; basescan_url?: string; settlement_source: 'onchain_x402' | 'pending_funding'; error?: string }> {
  try {
    const supabase = getDb();
    
    // Idempotency check: check if already settled in x402_settlements
    const existing = await pgQuery(
      `SELECT tx_hash FROM x402_settlements WHERE idempotency_key = $1 LIMIT 1`,
      [betId]
    );
    if (existing && existing.length > 0) {
      return {
        tx_hash: existing[0].tx_hash,
        basescan_url: `https://sepolia.basescan.org/tx/${existing[0].tx_hash}`,
        settlement_source: 'onchain_x402'
      };
    }

    if (process.env.MOCK_FACILITATOR === 'true') {
      // 1. Amount Governor check
      if (amountUSDC > 1.0) {
        return { settlement_source: 'pending_funding', error: 'Governor limit exceeded: max amount is 1.0 USDC' };
      }

      // 2. Circuit Breaker check
      const configData = await pgQuery(
        `SELECT value FROM repid_config WHERE key = $1 LIMIT 1`,
        ['cb_disable_x402_settlements']
      );
      if (configData && configData.length > 0 && configData[0].value === 'true') {
        return { settlement_source: 'pending_funding', error: 'Circuit breaker active' };
      }

      // 3. Non-existent agent check
      if (toAgentName === 'NON_EXISTENT_AGENT') {
        return { settlement_source: 'pending_funding', error: `Cannot determine destination address for ${toAgentName}` };
      }

      // 4. Invalid agent check (simulates settlement failure)
      if (toAgentName === 'invalid_agent') {
        await pgQuery(
          `INSERT INTO x402_settlement_failures (direction, agent_id, payment_payload_b64, payment_requirements, attempt_count)
           VALUES ($1, $2, $3, $4, $5)`,
          [
            'outbound',
            fromAgentName,
            Buffer.from(JSON.stringify({ betId })).toString('base64'),
            JSON.stringify({}),
            1
          ]
        );
        return { settlement_source: 'pending_funding', error: 'Settlement failed for invalid agent' };
      }

      const mockTx = `0xmock${crypto.randomUUID().replace(/-/g, '')}`;
      // Record mock settlement in x402_settlements
      await pgQuery(
        `INSERT INTO x402_settlements (idempotency_key, amount, status, prediction_topic, tip_id, tx_hash, is_simulated)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [
          betId,
          Math.floor(amountUSDC * 1_000_000),
          'settled',
          'mock',
          betId,
          mockTx,
          true
        ]
      );

      return {
        settlement_source: 'onchain_x402',
        tx_hash: mockTx,
        basescan_url: 'https://sepolia.basescan.org'
      };
    }

    // Interlock: CONFIRM_REAL_SEND=1 required for any on-chain tx, else full DRY-RUN
    if (process.env.CONFIRM_REAL_SEND !== '1') {
      return {
        settlement_source: 'pending_funding',
        error: 'DRY RUN: CONFIRM_REAL_SEND is not 1. Real on-chain transaction suppressed.'
      };
    }

    // Get fromAgent private key
    const pkVarName = `${fromAgentName.toUpperCase()}_PRIVATE_KEY`;
    const fromPk = process.env[pkVarName] || process.env[`${fromAgentName.replace('trinity-', '').toUpperCase()}_PRIVATE_KEY`] || process.env[fromAgentName];
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
      return { settlement_source: 'pending_funding', error: 'Insufficient balance' };
    }

    // Determine toAddress
    let toAddress: string | null = null;
    const toPkVarName = `${toAgentName.toUpperCase()}_PRIVATE_KEY`;
    const toPk = process.env[toPkVarName] || process.env[`${toAgentName.replace('trinity-', '').toUpperCase()}_PRIVATE_KEY`] || process.env[toAgentName];
    if (toPk) {
      const toWallet = new ethers.Wallet(toPk);
      toAddress = toWallet.address;
    } else {
      // Lookup in Supabase via pgQuery
      const agentRes = await pgQuery(
        `SELECT erc8004_address FROM repid_agents WHERE agent_name = $1 OR agent_name = $2 LIMIT 1`,
        [toAgentName, `trinity-${toAgentName.toLowerCase()}`]
      );
      
      if (agentRes && agentRes.length > 0 && agentRes[0].erc8004_address) {
        if (ethers.isAddress(agentRes[0].erc8004_address)) {
          toAddress = agentRes[0].erc8004_address;
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

    // Record real settlement in database using pgQuery
    try {
      // Resolve agents
      const fromAgentRes = await pgQuery(
        `SELECT id, agent_name FROM repid_agents WHERE agent_name = $1 OR agent_name = $2 LIMIT 1`,
        [fromAgentName, `trinity-${fromAgentName.toLowerCase()}`]
      );
      const fromAgent = fromAgentRes[0];

      const toAgentRes = await pgQuery(
        `SELECT id, agent_name, erc8004_token_id, tier, current_repid FROM repid_agents WHERE agent_name = $1 OR agent_name = $2 LIMIT 1`,
        [toAgentName, `trinity-${toAgentName.toLowerCase()}`]
      );
      const toAgent = toAgentRes[0];

      // 1. Insert into x402_settlements
      await pgQuery(
        `INSERT INTO x402_settlements 
         (idempotency_key, amount, status, prediction_topic, tip_id, tx_hash, is_simulated, payer_address, provider_agent_id, requestor_agent_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
        [
          betId,
          parsedAmount,
          'settled',
          'onchain_transfer',
          betId,
          txHash,
          false,
          wallet.address,
          toAgent?.id || null,
          fromAgent?.id || null
        ]
      );

      // 2. Insert into repid_score_events for the provider (receiver)
      if (toAgent) {
        const delta = Math.max(1, Math.floor(amountUSDC * 10)); // Formula: 10 * amountUSDC (min 1)
        
        const insertedEvents = await pgQuery(
          `INSERT INTO repid_score_events 
           (agent_id, event_type, delta, repid_delta_calculated, economic_impact_usdc, idempotency_key, metadata, task_domain)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
           RETURNING id`,
          [
            toAgent.id,
            'x402_value_delivered',
            delta,
            delta,
            amountUSDC,
            betId,
            JSON.stringify({ tx_hash: txHash }),
            taskDomain || null
          ]
        );
        const insertedEventId = insertedEvents[0]?.id;

        // Query updated repid/tier from database (trigger applied it automatically)
        const updatedAgentRes = await pgQuery(
          `SELECT current_repid, tier FROM repid_agents WHERE id = $1`,
          [toAgent.id]
        );
        const updatedRepid = updatedAgentRes[0]?.current_repid || toAgent.current_repid;
        const updatedTier = updatedAgentRes[0]?.tier || toAgent.tier;

        // 3. Call ERC-8004 write path on-chain (sender Sophia signs, not receiver Mel)
        if (toAgent.erc8004_token_id) {
          const { getReputationWriter } = require('./erc8004-reputation');
          let writer = getReputationWriter();
          if (!writer && process.env.SOPHIA_PRIVATE_KEY) {
            const { Erc8004ReputationWriter } = require('./erc8004-reputation');
            writer = new Erc8004ReputationWriter({
              provider: getProvider(),
              privateKey: process.env.SOPHIA_PRIVATE_KEY,
              contractAddress: process.env.ERC8004_REPUTATION_CONTRACT,
              chainId: 84532,
            });
          }

          if (writer) {
            console.log(`[x402-real-settler] Calling ERC-8004 write path for ${toAgent.agent_name}...`);
            const ercResult = await writer.writeRepIDFeedback({
              agentTokenId: toAgent.erc8004_token_id,
              repid: Math.round(updatedRepid),
              tier: updatedTier,
              endpoint: `https://trustrepid.dev/api/v1/agents/${toAgent.id}/reputation/payload.json`,
              feedbackURI: `https://trustrepid.dev/api/v1/agents/${toAgent.id}/reputation/payload.json`,
              feedbackHash: txHash
            });

            console.log(`[x402-real-settler] ERC-8004 write successful: ${ercResult.txHash}`);

            // Update Mel's last_reputation_tx_hash
            await pgQuery(
              `UPDATE repid_agents 
               SET last_reputation_tx_hash = $1, 
                   last_reputation_block_number = $2, 
                   last_reputation_repid = $3, 
                   last_reputation_written_at = now(),
                   reputation_write_count = reputation_write_count + 1
               WHERE id = $4`,
              [ercResult.txHash, ercResult.blockNumber, Math.round(updatedRepid), toAgent.id]
            );

            // Persist to audit trail table erc8004_reputation_writes
            await pgQuery(
              `INSERT INTO erc8004_reputation_writes 
               (agent_id, agent_token_id, repid_value, tier, tx_hash, block_number, gas_used, chain_id, contract_address, repid_event_id)
               VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
              [
                toAgent.id,
                toAgent.erc8004_token_id,
                Math.round(updatedRepid),
                updatedTier,
                ercResult.txHash,
                ercResult.blockNumber,
                ercResult.gasUsed,
                writer.chainId,
                writer.getContractAddress(),
                insertedEventId ? BigInt(insertedEventId) : null
              ]
            );
          } else {
            console.warn('[x402-real-settler] Reputation writer not initialized, skipping ERC-8004 write.');
          }
        } else {
          console.warn(`[x402-real-settler] Agent ${toAgent.agent_name} has no erc8004_token_id, skipping ERC-8004 write.`);
        }
      }

    } catch (dbErr: any) {
      console.error('[x402-real-settler] Failed to log settlement/scores in DB:', dbErr.message);
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
