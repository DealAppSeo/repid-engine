/**
 * THE CHAIN ID WE PUBLISH MUST BE THE CHAIN WE ARE ON, and until now nothing
 * compared the two.
 *
 * MEASURED 2026-09-04 against production: `/health` reported `hashkeyChainId:
 * 177`, read live from the chain via `provider.getNetwork()`. Three places in
 * this repo published **133** — `config.ts`'s default, `HASHKEY_CONFIG` as a
 * hardcoded literal, and `challenge.ts` through it — and `CLAUDE.md` documented
 * 133 as canonical.
 *
 * The one that matters is `GET /hashkey/config`, whose own comment says it is
 * "public chain/contract metadata for judges and clients". A client that
 * configures a wallet from it signs under EIP-155 for a chain the RPC is not on,
 * and the transaction is rejected. The endpoint existed to answer "which chain",
 * and answered wrongly with no way to notice.
 *
 * Two separate defects, fixed separately, because conflating them is how this
 * survived:
 *   1. TWO SOURCES OF TRUTH that could disagree. `HASHKEY_CONFIG.chainId` is now
 *      derived from `config.hashkeyChainId`, so one env var feeds every surface.
 *   2. NOBODY CHECKED EITHER AGAINST THE CHAIN. Unifying two wrong numbers into
 *      one wrong number is not a fix, so `chainIdAgreesWithRpc` compares what we
 *      publish against what the RPC reports and `/health` surfaces the verdict.
 */
import { chainIdAgreesWithRpc, HASHKEY_CONFIG } from '../src/routes/hashkey';
import { config } from '../src/config';

describe('the published chain id has ONE source', () => {
  /**
   * THIS TEST WAS WRITTEN WRONG FIRST, and the mistake is worth keeping visible.
   *
   * It asserted `HASHKEY_CONFIG.chainId === config.hashkeyChainId` and passed —
   * but it passed with the OLD hardcoded literal still in place, because the
   * config default is also 133, so both sides read 133 and the assertion could
   * not tell a derived value from a coincidence. Restoring the literal did not
   * turn it red. A test that cannot fail when the defect returns is not a test.
   *
   * The property only becomes observable when the env var moves the config AWAY
   * from the default, so that is what this does: load the modules fresh with
   * HSK_CHAIN_ID set to a value the literal never had.
   */
  const withChainId = (value: string) => {
    let cfg: typeof import('../src/config').config;
    let hk: typeof import('../src/routes/hashkey');
    jest.isolateModules(() => {
      process.env.HSK_CHAIN_ID = value;
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      cfg = require('../src/config').config;
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      hk = require('../src/routes/hashkey');
    });
    return { cfg: cfg!, hk: hk! };
  };

  const original = process.env.HSK_CHAIN_ID;
  afterEach(() => {
    if (original === undefined) delete process.env.HSK_CHAIN_ID;
    else process.env.HSK_CHAIN_ID = original;
  });

  it('follows HSK_CHAIN_ID away from the default — a literal could not', () => {
    const { cfg, hk } = withChainId('177');
    expect(cfg.hashkeyChainId).toBe(177);
    expect(hk.HASHKEY_CONFIG.chainId).toBe(177); // the literal would still say 133
  });

  it('follows it to an arbitrary value, so nothing is special-cased', () => {
    const { cfg, hk } = withChainId('4242');
    expect(cfg.hashkeyChainId).toBe(4242);
    expect(hk.HASHKEY_CONFIG.chainId).toBe(4242);
  });

  it('every surface serving a chain id reads that one value', () => {
    const { cfg, hk } = withChainId('177');
    // /hashkey/config (judges and clients) and the challenge receipt both go
    // through HASHKEY_CONFIG; /hashkey goes through config directly.
    expect(hk.HASHKEY_CONFIG.chainId).toBe(cfg.hashkeyChainId);
  });
});

describe('chainIdAgreesWithRpc: three outcomes, never two', () => {
  it('true when what we publish is what the chain reports', () => {
    expect(chainIdAgreesWithRpc(177, 177)).toBe(true);
  });

  it('FALSE for the exact production mismatch this was written for', () => {
    // We served 133; the RPC answered 177.
    expect(chainIdAgreesWithRpc(133, 177)).toBe(false);
  });

  /**
   * The whole point. An unreachable RPC compared nothing, and "nothing was
   * compared" is not "they agree" — reporting `true` here would recreate the
   * defect one level up, which is this codebase's signature failure.
   */
  it('NULL when the RPC could not be reached — not true, and not false', () => {
    expect(chainIdAgreesWithRpc(133, undefined)).toBeNull();
    expect(chainIdAgreesWithRpc(133, NaN)).toBeNull();
    expect(chainIdAgreesWithRpc(133, Infinity)).toBeNull();
  });

  it('does not coerce a numeric string into agreement', () => {
    expect(chainIdAgreesWithRpc(133, '133' as unknown as number)).toBeNull();
  });

  it('0 is a value, not an absence', () => {
    // A falsy-but-present reading must still be compared, not treated as missing.
    expect(chainIdAgreesWithRpc(0, 0)).toBe(true);
    expect(chainIdAgreesWithRpc(133, 0)).toBe(false);
  });
});
