/**
 * Mint a long-lived OPERATOR controller token for a server-side caller, e.g. controller-pwa's
 * CONTROLLER_TOKEN (its Approve/Deny calls POST /api/v1/controller/requests/:id/decide).
 *
 * WHY [S1 2026-10-14]. An agent API key is now at most a controller viewer, so a server that
 * decides HITL requests needs a credential that is not an agent key. This is the least-privilege
 * one: operator (not admin), signed with CONTROLLER_QR_SECRET, and it expires. POST /token caps
 * tokens at 24h, which a static env var cannot live with, hence this one-shot script.
 *
 * Revoking it early means rotating CONTROLLER_QR_SECRET, which also voids every other controller
 * token. Re-mint before it expires; the expiry is printed to stderr.
 *
 * Usage (where CONTROLLER_QR_SECRET is set, i.e. the engine's env):
 *   railway run -s repid-engine npx ts-node scripts/controller/mint-service-token.ts [days=90]
 * The token goes to stdout only. Paste it into the caller's secret store; never commit it.
 */
import { mintQrToken } from '../../src/middleware/controller-auth';

const days = Number(process.argv[2] ?? 90);
if (!Number.isInteger(days) || days < 1 || days > 365) {
  console.error('days must be an integer from 1 to 365');
  process.exit(2);
}
const ms = days * 24 * 60 * 60 * 1000;
process.stdout.write(mintQrToken('operator', ms) + '\n');
console.error(`operator controller token, expires ${new Date(Date.now() + ms).toISOString()}`);
