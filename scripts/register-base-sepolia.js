require('dotenv').config();
const { ethers } = require('ethers');
const { createClient } = require('@supabase/supabase-js');

// Base Sepolia RPC
const provider = new ethers.JsonRpcProvider('https://sepolia.base.org');

// Load wallet from env — NEVER hardcode key
const wallet = new ethers.Wallet(process.env.DEPLOYER_PRIVATE_KEY, provider);

// Supabase client for receipt storage (writes tx hash → repid_agents.erc8004_address)
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

// ABI from hyperdag-protocol/packages/contracts/abis/IdentityRegistry.json
// Contract is ERC-721 — each agent is an NFT; agentId == tokenId.
// Reputation is NOT on this contract — it lives on ReputationRegistry.
const ABI = [
  'function register(string agentURI, (string metadataKey, bytes metadataValue)[] metadata) external returns (uint256 agentId)',
  'function setAgentURI(uint256 agentId, string newURI) external',
  'function setMetadata(uint256 agentId, string metadataKey, bytes metadataValue) external',
  'function getAgentWallet(uint256 agentId) external view returns (address)',
  'function ownerOf(uint256 tokenId) external view returns (address)',
  'event Registered(uint256 indexed agentId, string agentURI, address indexed owner)'
];

// ERC-8004 IdentityRegistry proxy (UUPS) — Base Sepolia, chainId 84532
// Source: hyperdag-protocol/packages/contracts/README.md
// https://sepolia.basescan.org/address/0x8004A818BFB912233c491871b3d84c89A494BD9e
const IDENTITY_REGISTRY = '0x8004A818BFB912233c491871b3d84c89A494BD9e';

async function main() {
  console.log('Wallet:', wallet.address);
  const balance = await provider.getBalance(wallet.address);
  console.log('Balance:', ethers.formatEther(balance), 'ETH');

  if (balance === 0n) {
    console.log('NEEDS FUNDING: go to faucet.base.org');
    console.log('Address:', wallet.address);
    process.exit(1);
  }

  const contract = new ethers.Contract(IDENTITY_REGISTRY, ABI, wallet);

  // Squad leads — register in order
  const agents = [
    { name: 'SOPHIA',   repid: 10000, tier: 'AUTONOMOUS'       }, // Squad 1 lead
    { name: 'GUARDIAN', repid: 1400,  tier: 'EARNING_AUTONOMY' }, // Squad 2 lead
    { name: 'TORCH',    repid: 1420,  tier: 'EARNING_AUTONOMY' }, // Squad 3 lead
    { name: 'GCM',      repid: 980,   tier: 'CUSTODIED_DBT'    }  // Orchestration lead
  ];

  for (const agent of agents) {
    console.log(`\n→ ${agent.name} (repid=${agent.repid}, tier=${agent.tier})`);
    try {
      // Agent card as data URI — swap to ipfs:// or https:// once hosted
      const card = {
        name: agent.name,
        repid: agent.repid,
        tier: agent.tier,
        protocol: 'HyperDAG',
        version: 'v11'
      };
      const agentURI = 'data:application/json;base64,' +
        Buffer.from(JSON.stringify(card)).toString('base64');

      // Indexed metadata — emitted via MetadataSet event on-chain
      const metadata = [
        { metadataKey: 'name',     metadataValue: ethers.toUtf8Bytes(agent.name) },
        { metadataKey: 'tier',     metadataValue: ethers.toUtf8Bytes(agent.tier) },
        { metadataKey: 'protocol', metadataValue: ethers.toUtf8Bytes('HyperDAG') }
      ];

      const tx = await contract.register(agentURI, metadata);
      console.log(`  tx hash: ${tx.hash}`);
      const receipt = await tx.wait();

      // Parse Registered event for the minted agentId
      let agentId = null;
      for (const log of receipt.logs) {
        try {
          const parsed = contract.interface.parseLog(log);
          if (parsed && parsed.name === 'Registered') {
            agentId = parsed.args.agentId.toString();
            break;
          }
        } catch { /* not our event */ }
      }
      console.log(`  confirmed: agentId=${agentId ?? '?'}, block=${receipt.blockNumber} ✅`);

      // Persist tx hash to Supabase as receipt marker
      const { data: updated, error: dbError } = await supabase
        .from('repid_agents')
        .update({ erc8004_address: tx.hash })
        .eq('agent_name', agent.name)
        .select('id, agent_name, erc8004_address');

      if (dbError) {
        console.log(`  DB write FAILED: ${dbError.message}`);
      } else if (!updated || updated.length === 0) {
        console.log(`  DB write: no row matched agent_name='${agent.name}' — tx hash NOT stored`);
      } else {
        console.log(`  DB write: ${updated.length} row(s) updated ✅  (id=${updated[0].id})`);
      }
    } catch (e) {
      console.log(`  Error: ${e.message}`);
    }
  }

  console.log('\nAll 4 agents processed.');
}

main().catch(console.error);
