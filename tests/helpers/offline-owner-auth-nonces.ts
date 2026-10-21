/**
 * jest setupFiles entry: no unit test reaches a database to record a used owner approval.
 *
 * src/services/owner-authorization.ts claims each verified (signer, nonce) in a durable ledger, by
 * default the `owner_auth_nonces` table through `db`. In a unit test that would make a verdict depend
 * on the network (see jest.config.js). This in-process ledger stands in for the table: like the
 * table, it is NOT cleared by `__resetOwnerAuthNonces()` (what a restart does to process memory), so
 * a used approval stays used across a simulated restart. Tests of the table path pass their own client.
 */
import { __setOwnerAuthNonceLedger } from '../../src/services/owner-authorization';

const used = new Set<string>();
__setOwnerAuthNonceLedger({
  async claim(signer, nonce) {
    const key = `${signer}:${nonce}`;
    if (used.has(key)) return 'replayed';
    used.add(key);
    return 'claimed';
  },
});
