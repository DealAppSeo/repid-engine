-- S-ONCHAIN Phase 1.4 Backfill (run after funded mint with real txs from mint-t12-correct-results.json)
-- Chain: Base Sepolia (84532), Registry: 0x8004A818BFB912233c491871b3d84c89A494BD9e
-- Use the SAME register(string) overload as src/services/erc8004-minter.ts

-- For each of 12 T12 (replace placeholders with real from funded script run):
UPDATE repid_agents SET 
  erc8004_address = '0x8004A818BFB912233c491871b3d84c89A494BD9e',
  erc8004_token_id = '<TOKEN_ID>',
  mint_tx_hash = '<REAL_TX_HASH>',
  mint_block_number = <BLOCK_NUMBER>,
  minted_at = NOW(),
  mint_chain_id = 84532
WHERE agent_name = 'trinity-veritas';

-- Repeat for: trinity-sophia, trinity-harmonia, trinity-apollon, trinity-melodia, trinity-arkhe,
-- trinity-selene, trinity-hephaistos, trinity-athena, trinity-eros, trinity-hermes, trinity-gaia

-- Verification query:
-- SELECT agent_name, erc8004_token_id, mint_tx_hash, mint_block_number, conservator_address FROM repid_agents WHERE agent_name LIKE 'trinity-%' ORDER BY agent_name;