import { db } from '../../src/db';
import { ethers } from 'ethers';
import fs from 'fs';
import path from 'path';

async function captureEvidence() {
  console.log('Fetching evidence for patent class micro-transaction...');

  // 1. Find the real settlement
  const { data: settlements, error: setErr } = await db
    .from('x402_settlements')
    .select('*')
    .eq('is_simulated', false)
    .order('created_at', { ascending: false })
    .limit(1);

  if (setErr || !settlements || settlements.length === 0) {
    console.error('No real settlement found in x402_settlements.');
    process.exit(1);
  }

  const settlement = settlements[0];
  console.log(`Found settlement: ${settlement.id}`);

  // 2. Find agent details
  const { data: agent, error: agErr } = await db
    .from('repid_mvp_agents')
    .select('id, wallet_address, name, current_repid')
    .eq('wallet_address', settlement.recipient_wallet)
    .single();

  if (agErr || !agent) {
    console.error(`Could not fetch agent details for wallet ${settlement.recipient_wallet}`);
    process.exit(1);
  }

  // 3. Fetch Base Sepolia tx receipt
  let txReceipt = null;
  if (settlement.tx_hash) {
    try {
      const provider = new ethers.JsonRpcProvider(process.env.BASE_SEPOLIA_RPC_URL || 'https://sepolia.base.org');
      txReceipt = await provider.getTransactionReceipt(settlement.tx_hash);
    } catch (e: any) {
      console.error(`Failed to fetch tx receipt for ${settlement.tx_hash}: ${e.message}`);
    }
  }

  // 4. Generate Markdown
  const markdown = `# X402 Patent Evidence Payload

**Date Generated**: ${new Date().toISOString()}
**Event Type**: First Real-World X402 Micro-Transaction
**Network**: Base Sepolia

## 1. Settlement Record
\`\`\`json
${JSON.stringify(settlement, null, 2)}
\`\`\`

## 2. Receiver Agent Context
- **Name**: ${agent.name}
- **Agent ID**: ${agent.id}
- **Wallet**: ${agent.wallet_address}
- **Current RepID Score**: ${agent.current_repid || 'N/A'}

## 3. On-Chain Verification
- **Transaction Hash**: ${settlement.tx_hash || 'PENDING/FAILED'}
- **Block Number**: ${txReceipt ? txReceipt.blockNumber : 'N/A'}
- **Gas Used**: ${txReceipt ? txReceipt.gasUsed.toString() : 'N/A'}
- **Status**: ${txReceipt ? (txReceipt.status === 1 ? 'SUCCESS' : 'FAILED') : 'N/A'}

## 4. Cryptographic Proof
(Attach the HAL or Proof payload here if applicable)
`;

  const outDir = path.join(__dirname, '../../docs/patent');
  if (!fs.existsSync(outDir)) {
    fs.mkdirSync(outDir, { recursive: true });
  }

  const outPath = path.join(outDir, 'X402_EVIDENCE_PAYLOAD.md');
  fs.writeFileSync(outPath, markdown, 'utf8');

  console.log(`\nEvidence captured successfully at ${outPath}`);
}

if (require.main === module) {
  captureEvidence().catch(console.error);
}
