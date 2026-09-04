/**
 * UNION TEST — x402-real-settler.ts (staking ∪ multi-token).
 *
 * WHY THIS FILE EXISTS: the merge-wave integration branch is the FIRST place
 * that both settler behaviors coexist. No single source branch contained both:
 *   - staking (#4 feat/agent-wallets-and-real-staking) added recipient
 *     resolution from repid_agents.wallet_address (the custody/delegation path;
 *     used when the recipient has NO <NAME>_PRIVATE_KEY env var).
 *   - multi-token (#5 feat/multi-token-settlement) added BASE_SEPOLIA_TOKENS +
 *     alternate-token fallback (settle a DIFFERENT token when the requested one
 *     is short and accept_alternate is set).
 *
 * The existing tests/x402-real-settler.test.ts exercises multi-token fallback
 * ONLY with an env-keyed recipient (VERITAS_PRIVATE_KEY set), so the staking
 * DB-resolution path is never hit in the same test as the token fallback.
 *
 * This test drives BOTH at once: a wrong-token (USDC short) payment to a
 * recipient that has NO env key — so its address MUST come from the staking
 * wallet_address lookup — and asserts the funds route to the CORRECT resolved
 * recipient address WITH the correct alternate-token fallback (cbBTC).
 */
import { settleX402Payment, BASE_SEPOLIA_TOKENS } from '../src/services/x402-real-settler';
import { ethers } from 'ethers';
import { createClient } from '@supabase/supabase-js';

jest.mock('ethers');
jest.mock('@supabase/supabase-js');

describe('x402-real-settler UNION: staking recipient-resolution ∪ multi-token fallback', () => {
  // Recipient's REAL custodied wallet (staking path). A checksummed EVM address
  // so ethers.isAddress() (mocked to pass below) + the routing assertion are meaningful.
  const RESOLVED_RECIPIENT = '0x1111111111111111111111111111111111111111';

  beforeEach(() => {
    // Payer HAS an env key (keeps the payer side simple; the union under test is
    // recipient-resolution + token-fallback). Recipient has NO env key → forces
    // the staking DB wallet_address lookup.
    process.env.APM_PRIVATE_KEY = '0xpayerkey';
    delete process.env.VERITAS_PRIVATE_KEY;
    delete process.env.MOCK_FACILITATOR; // exercise the REAL settlement code path

    // Supabase mock:
    //   - repid_config (cb_disable_x402_settlements) via maybeSingle → off (null)
    //   - repid_agents recipient lookup via select(...).eq(...).limit(1) →
    //     returns wallet_address (the staking custody column). No erc8004_address,
    //     proving the wallet_address branch (the staking BUGFIX) is what routes.
    (createClient as jest.Mock).mockReturnValue({
      from: jest.fn((table: string) => ({
        select: jest.fn(() => ({
          eq: jest.fn(() => ({
            // recipient address lookup: repid_agents.wallet_address
            limit: jest.fn().mockResolvedValue(
              table === 'repid_agents'
                ? { data: [{ wallet_address: RESOLVED_RECIPIENT, erc8004_address: null }], error: null }
                : { data: [], error: null }
            ),
            order: jest.fn(() => ({
              limit: jest.fn(() => ({ maybeSingle: jest.fn().mockResolvedValue({ data: null }) })),
            })),
            // circuit-breaker + settlement-record reads
            maybeSingle: jest.fn().mockResolvedValue({ data: null }),
          })),
        })),
        insert: jest.fn().mockResolvedValue({ data: null, error: null }),
      })),
    });

    // ethers.isAddress must accept our resolved recipient so the wallet_address
    // branch keeps it. (ethers is fully mocked, so provide a real predicate.)
    (ethers.isAddress as unknown as jest.Mock).mockImplementation(
      (a: string) => typeof a === 'string' && /^0x[0-9a-fA-F]{40}$/.test(a)
    );
  });

  afterEach(() => {
    // Undo any per-test address confirmation so it cannot leak between tests.
    BASE_SEPOLIA_TOKENS.cbBTC!.address = '0x0000000000000000000000000000000000000000';
    jest.clearAllMocks();
    delete process.env.APM_PRIVATE_KEY;
  });

  it('wrong-token payment to a DB-resolved (delegated/custodied) recipient routes to the CORRECT recipient WITH correct token fallback', async () => {
    const usdcAddr = BASE_SEPOLIA_TOKENS.USDC.address;
    // cbBTC's address in the map is the ZERO ADDRESS (`TODO(review): confirm
    // Base Sepolia address`), and this test mocks `ethers.Contract` by address —
    // so it was asserting a settlement INTO an unconfigured token as correct.
    // The recipient-resolution ∪ token-fallback behaviour it covers is real; the
    // token it used to cover it was not. Confirm a stand-in for this test only.
    // (Restored in afterEach; the placeholder itself is pinned in
    // tests/x402-real-settler.test.ts.)
    BASE_SEPOLIA_TOKENS.cbBTC!.address = '0x1111111111111111111111111111111111111111';
    const cbBtcAddr = BASE_SEPOLIA_TOKENS.cbBTC!.address;

    // Capture the recipient the transfer is actually sent to.
    let cbBtcTransferTo: string | undefined;
    const cbBtcTransfer = jest.fn((to: string /*, amount */) => {
      cbBtcTransferTo = to;
      return Promise.resolve({ hash: '0xcbbtc_union', wait: jest.fn().mockResolvedValue({}) });
    });

    // Requested token USDC is SHORT (0 balance) → must fall back to cbBTC.
    (ethers.Contract as jest.Mock).mockImplementation((addr: string) => {
      if (addr === usdcAddr) {
        return { balanceOf: jest.fn().mockResolvedValue(0n), transfer: jest.fn() };
      }
      if (addr === cbBtcAddr) {
        // 1 cbBTC (8 decimals) — covers amount 1
        return { balanceOf: jest.fn().mockResolvedValue(100_000_000n), transfer: cbBtcTransfer };
      }
      return { balanceOf: jest.fn().mockResolvedValue(0n), transfer: jest.fn() };
    });

    // Payer wallet (from env key). Native ETH balance = 0 via provider.
    (ethers.Wallet as unknown as jest.Mock).mockImplementation(() => ({ address: '0xpayeraddr' }));
    (ethers.JsonRpcProvider as unknown as jest.Mock).mockImplementation(() => ({
      getBalance: jest.fn().mockResolvedValue(0n),
    }));

    const result = await settleX402Payment(
      'APM',        // payer (env-keyed)
      'VERITAS',    // recipient — NO env key → resolves via repid_agents.wallet_address (staking path)
      1,            // amount
      'bet_union',  // idempotency
      'USDC',       // requested token (short) → forces multi-token fallback
      { accept_alternate: true }
    );

    // --- MULTI-TOKEN behavior survived: fell back to cbBTC and settled ---
    expect(result.settlement_source).toBe('onchain_x402');
    expect(result.token).toBe('cbBTC');
    expect(result.token_address).toBe(cbBtcAddr);
    expect(result.tx_hash).toBe('0xcbbtc_union');
    expect(cbBtcTransfer).toHaveBeenCalled();

    // --- STAKING behavior survived: funds routed to the DB-resolved recipient,
    //     NOT to any env-keyed address (VERITAS_PRIVATE_KEY is unset) ---
    expect(cbBtcTransferTo).toBe(RESOLVED_RECIPIENT);
  });
});
