-- S-ONCHAIN Phase 1.4: Backfill repid_agents with mint results
-- Run AFTER Sean runs the funded mint-t12-agents.js and provides real tx/token from mint-t12-correct-results.json
-- All 12 T12 agents on Base Sepolia (chain 84532)
-- Registry: 0x8004A818BFB912233c491871b3d84c89A494BD9e

-- TEMPLATE (replace <TOKEN>, <TX>, <BLOCK> from actual mint run output)
-- Example for one:

UPDATE repid_agents SET 
  erc8004_address = '0x8004A818BFB912233c491871b3d84c89A494BD9e',
  erc8004_token_id = '<TOKEN_FROM_MINT>',
  mint_tx_hash = '<REAL_TX_HASH>',
  mint_block_number = <BLOCK>,
  minted_at = NOW(),
  mint_chain_id = 84532,
  conservator_address = '<DEPLOYER_ADDRESS_FROM_RECEIPT>'
WHERE agent_name = 'trinity-veritas';

-- Repeat for all:
-- trinity-sophia, trinity-harmonia, trinity-apollon, trinity-melodia, trinity-arkhe,
-- trinity-selene, trinity-hephaistos, trinity-athena, trinity-eros, trinity-hermes, trinity-gaia

-- After update, verify with:
-- SELECT agent_name, erc8004_token_id, mint_tx_hash, mint_block_number FROM repid_agents WHERE agent_name LIKE 'trinity-%';

-- Then for each tx:
-- curl "https://sepolia.basescan.org/api?module=transaction&action=gettxreceiptstatus&txhash=<HASH>&apikey=YourApiKeyToken"

-- Phase 1.5 verification should return {"status":"1"} for success on all.