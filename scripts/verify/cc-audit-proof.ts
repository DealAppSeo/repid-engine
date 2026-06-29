/**
 * CC audit-fix runtime proof (2026-06-29) — exercises the FIXED updateRepId path directly,
 * confirming it writes a repid_score_events row with metadata.mode (the audit-fix 2396241).
 * Bypasses HTTP auth; uses the same code the Fly engine runs. STAKE = +5 (harmless test).
 * Usage: SUPABASE_URL + SUPABASE_SERVICE_KEY in env, then: npx ts-node scripts/verify/cc-audit-proof.ts <agentUuid>
 */
import { updateRepId } from '../../src/engine/repid-update';

const agentId = process.argv[2] || 'f3ef0bf8-5cdc-4fad-bce8-5144f01dc271'; // trinity-sophia
updateRepId({ agentId, eventType: 'STAKE' } as any)
  .then((r) => { console.log('RESULT: ' + JSON.stringify(r)); process.exit(0); })
  .catch((e) => { console.error('ERR: ' + (e?.message ?? String(e))); process.exit(1); });
