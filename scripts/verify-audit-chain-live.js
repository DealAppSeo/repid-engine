// One-off live verification script for the audit chain.
// Fires a single HAL event through the production write path
// (logHalProductionEvent → .insert → appendToAuditChain RPC)
// then queries the chain and calls the public verify endpoint.
require('dotenv').config();
const { logHalProductionEvent, hashPrompt } = require('../dist/engine/production-logger');

(async () => {
  const promptText = `live-verify-${Date.now()}`;
  const promptHash = hashPrompt(promptText);
  console.log('[live-verify] firing HAL event, prompt_hash=%s', promptHash);

  await logHalProductionEvent({
    agentDomain: '__live_verify__',
    promptHash,
    halVerdict: 'PASS',
    halMode: 1,
    layersActive: { sbfa: true, live_verify: true },
  });

  const port = process.env.PORT || 3099;
  const res = await fetch(`http://localhost:${port}/api/v1/audit/verify`);
  const body = await res.json();
  console.log('[live-verify] /audit/verify →', JSON.stringify(body));
  console.log('[live-verify] HTTP status', res.status);

  if (!body.valid) {
    console.error('[live-verify] FAIL — chain reports broken');
    process.exit(1);
  }
  if (body.total_entries !== 1) {
    console.error('[live-verify] FAIL — expected 1 entry, got', body.total_entries);
    process.exit(1);
  }
  console.log('[live-verify] OK');
})();
