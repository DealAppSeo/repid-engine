/**
 * S-ONCHAIN Phase 1.5: Verify txs on basescan for all T12 after mint backfill.
 * Run after updating repid_agents with real txs.
 * Usage: node scratch/S-ONCHAIN_verify_basescan.js (or with specific tx via arg)
 */
const https = require('https');

const T12 = ['trinity-veritas','trinity-sophia','trinity-harmonia','trinity-apollon','trinity-melodia','trinity-arkhe','trinity-selene','trinity-hephaistos','trinity-athena','trinity-eros','trinity-hermes','trinity-gaia'];

async function checkTx(txHash) {
  return new Promise((resolve) => {
    const url = `https://sepolia.basescan.org/api?module=transaction&action=gettxreceiptstatus&txhash=${txHash}`;
    https.get(url, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const j = JSON.parse(data);
          resolve({ tx: txHash, status: j?.result?.status || 'unknown', raw: j });
        } catch (e) {
          resolve({ tx: txHash, status: 'parse_error', error: e.message });
        }
      });
    }).on('error', (e) => resolve({ tx: txHash, status: 'http_error', error: e.message }));
  });
}

async function main() {
  console.log('=== S-ONCHAIN Phase 1.5 Basescan Verification ===');
  const argTx = process.argv[2];
  if (argTx) {
    const r = await checkTx(argTx);
    console.log('Single tx:', JSON.stringify(r, null, 2));
    process.exit(r.status === '1' ? 0 : 1);
  }

  // In real: pull from DB after backfill. For now, note that user must provide txs from mint-t12-correct-results.json
  console.log('No tx arg provided. In production run:');
  console.log('1. After funded mint + DB backfill, query repid_agents for mint_tx_hash where agent_name LIKE "trinity-%"');
  console.log('2. For each, run: node scratch/S-ONCHAIN_verify_basescan.js <txhash>');
  console.log('Expected: {"status":"1"} for success on all 12.');
  console.log('Example curl (from spec): curl "https://sepolia.basescan.org/api?module=transaction&action=gettxreceiptstatus&txhash=<HASH>"');
  process.exit(0);
}

main();