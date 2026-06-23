import { ethers } from 'ethers';
import { db } from '../db';
import { updateRepId } from '../engine/repid-update';
import { getProvider } from '../clients/rpc-with-failover';

// ABI for the Transfer event of the ERC-721/ERC-8004 IdentityRegistry contract
const ERC8004_TRANSFER_ABI = [
  'event Transfer(address indexed from, address indexed to, uint256 indexed tokenId)'
];

const IDENTITY_REGISTRY_ADDRESS = '0x8004A818BFB912233c491871b3d84c89A494BD9e';

export async function listenForErc8004Transfers() {
  const provider = getProvider();
  const contract = new ethers.Contract(
    IDENTITY_REGISTRY_ADDRESS,
    ERC8004_TRANSFER_ABI,
    provider
  );

  console.log(`[erc8004-listener] Subscribing to Transfer events on ${IDENTITY_REGISTRY_ADDRESS}`);

  contract.on('Transfer', async (from: string, to: string, tokenId: any, event: any) => {
    try {
      const tokenIdStr = tokenId.toString();
      console.log(`[erc8004-listener] Detected Transfer: tokenId=${tokenIdStr}, from=${from}, to=${to}`);

      // We only care about actual transfers, not mints (from == address(0)) or burns (to == address(0))
      if (from === ethers.ZeroAddress || to === ethers.ZeroAddress) {
        console.log(`[erc8004-listener] Mint/burn detected. Skipping.`);
        return;
      }

      // Lookup the agent by erc8004_token_id
      const { data: agent, error } = await db
        .from('repid_agents')
        .select('id, agent_name, current_repid')
        .eq('erc8004_token_id', tokenIdStr)
        .maybeSingle();

      if (error) {
        console.error(`[erc8004-listener] DB lookup error for token ID ${tokenIdStr}:`, error.message);
        return;
      }

      if (!agent) {
        console.log(`[erc8004-listener] No agent registered with erc8004_token_id=${tokenIdStr}. Skipping.`);
        return;
      }

      console.log(`[erc8004-listener] Mapping token transfer to RepID drop for agent ${agent.agent_name} (${agent.id}). Current RepID: ${agent.current_repid}`);

      // Trigger SALE_DROP update
      const result = await updateRepId({
        agentId: agent.id,
        eventType: 'SALE_DROP'
      });

      console.log(`[erc8004-listener] SALE_DROP processed for ${agent.agent_name}: ${result.repIdBefore} -> ${result.repIdAfter} (delta: ${result.delta})`);

    } catch (err: any) {
      console.error('[erc8004-listener] Error processing Transfer event:', err.message || err);
    }
  });
}
