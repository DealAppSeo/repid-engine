export const ANFIS_ROUTING_RECEIPT_TYPE = {
  AnfisRoutingReceipt: [
    { name: 'buyerAddress', type: 'address' },
    { name: 'spokespersonTokenId', type: 'uint256' },
    { name: 'spokespersonName', type: 'string' },
    { name: 'promptHash', type: 'bytes32' },
    { name: 'routedProvider', type: 'string' },
    { name: 'confidence', type: 'uint8' },
    { name: 'reasoning', type: 'string' },
    { name: 'priceUsdc', type: 'uint256' },
    { name: 'paymentMode', type: 'string' }, // 'usdc' | 'eip712-only'
    { name: 'timestamp', type: 'uint256' }
  ]
};

export const TRADE_ANALYSIS_RECEIPT_TYPE = {
  TradeAnalysisReceipt: [
    { name: 'buyerAddress', type: 'address' },
    { name: 'spokespersonTokenId', type: 'uint256' },
    { name: 'spokespersonName', type: 'string' },
    { name: 'queryHash', type: 'bytes32' },
    { name: 'analysisDigest', type: 'bytes32' },
    { name: 'sentiment', type: 'string' },
    { name: 'repidLeverageFactor', type: 'uint256' },
    { name: 'priceUsdc', type: 'uint256' },
    { name: 'paymentMode', type: 'string' },
    { name: 'timestamp', type: 'uint256' }
  ]
};

export const DOMAIN = {
  name: 'TrustEnvoy',
  version: '1',
  chainId: 84532,
  verifyingContract: process.env.REPUTATION_REGISTRY_ADDRESS || 
    '0x8004B663056A597Dffe9eCcC1965A193B7388713'
};
