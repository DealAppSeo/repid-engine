/**
 * R4 (2026-11-16): an unbind does not touch an on-chain USDC approval, so the unbind answer states it.
 *
 * WHY THIS IS NOT A TEST OF THE CHAIN. revokeBinding writes `revoked_at` and nothing else; an ERC-20
 * approval changes only when the owner's wallet calls approve (or the spender uses it). So in wallet
 * mode (AGENT_SPEND_SOURCE=wallet) the approval outlives the unbind by construction. What this file
 * pins is that the unbind answer SAYS so, from a live read, and that a failed read is NOT_CHECKED,
 * never "0". The chain here is a fake; nothing is read from a chain.
 */
import { approvalAfterUnbind, approvalForAgentRow } from '../src/services/agent-spend';

const OWNER = '0x' + 'aa'.repeat(20);
const AGENT = '0x' + 'bb'.repeat(20);
const chain = (allowance: bigint | Error, chainId = 84532n) => ({
  chainId: async () => chainId,
  allowance: async () => {
    if (allowance instanceof Error) throw allowance;
    return allowance;
  },
});

test('wallet mode: an approval that outlives the unbind is stated, with the amount and how to end it', async () => {
  const out = await approvalAfterUnbind(chain(2_500_000n), OWNER, AGENT);
  expect(out).toMatchObject({ checked: true, live: true, allowance_usdc: '2.5' });
  if (out.checked && out.live) {
    expect(out.statement).toMatch(/does not change your on-chain USDC approval/);
    expect(out.statement).toMatch(/2\.5 USDC/);
    expect(out.how_to_end).toMatch(/approve\(0x[bB]{40}, 0\)/);
  }
});

test('stake mode (no approval): reads 0 and says nothing is live', async () => {
  await expect(approvalAfterUnbind(chain(0n), OWNER, AGENT)).resolves.toEqual({ checked: true, live: false, allowance_usdc: '0.0' });
});

test('a failed read is NOT_CHECKED and says it may still be live, never "0"', async () => {
  const out = await approvalAfterUnbind(chain(new Error('rpc down')), OWNER, AGENT);
  expect(out.checked).toBe(false);
  if (!out.checked) expect(out.reason).toMatch(/may still be live/);
});

test('a failed read never echoes the RPC error, which carries the provider URL and any key in it (Strix on #1559)', async () => {
  const err = new Error('server response 401 (request={ }, response={ }, error=null, info={ "requestUrl": "https://rpc.example.invalid/v2/NOT-A-REAL-KEY-123" })');
  const spy = jest.spyOn(console, 'error').mockImplementation(() => {});
  try {
    const out = await approvalAfterUnbind(chain(err), OWNER, AGENT);
    expect(out.checked).toBe(false);
    const text = JSON.stringify(out);
    expect(text).not.toMatch(/NOT-A-REAL-KEY-123|rpc\.example|https?:\/\//);
  } finally {
    spy.mockRestore();
  }
});

test('the wrong chain is NOT_CHECKED', async () => {
  const out = await approvalAfterUnbind(chain(5n, 1n), OWNER, AGENT);
  expect(out).toMatchObject({ checked: false });
});

test('no owner wallet on record is NOT_CHECKED; an agent with no wallet can have no approval', async () => {
  await expect(approvalAfterUnbind(chain(5n), null, AGENT)).resolves.toMatchObject({ checked: false });
  await expect(approvalAfterUnbind(chain(5n), 'not-an-address', AGENT)).resolves.toMatchObject({ checked: false });
  await expect(approvalAfterUnbind(chain(5n), OWNER, null)).resolves.toMatchObject({ checked: true, live: false });
});

test('a read that never answers times out to NOT_CHECKED', async () => {
  jest.useFakeTimers();
  try {
    const hanging = { chainId: async () => 84532n, allowance: () => new Promise<bigint>(() => {}) };
    const p = approvalAfterUnbind(hanging, OWNER, AGENT);
    await jest.advanceTimersByTimeAsync(10_001);
    await expect(p).resolves.toMatchObject({ checked: false });
  } finally {
    jest.useRealTimers();
  }
});

describe('approvalForAgentRow: the agent row as the unbind route read it (Grok r2 on #1559)', () => {
  const untouched = {
    chainId: async (): Promise<bigint> => { throw new Error('the chain must not be read'); },
    allowance: async (): Promise<bigint> => { throw new Error('the chain must not be read'); },
  };

  test('NO row is NOT_CHECKED, never "no wallet, 0", and reads no chain', async () => {
    const out = await approvalForAgentRow(untouched, OWNER, null, false);
    expect(out).toMatchObject({ checked: false });
    if (!out.checked) expect(out.reason).toMatch(/may still be live/);
  });

  test('a read error is NOT_CHECKED and reads no chain', async () => {
    await expect(approvalForAgentRow(untouched, OWNER, { wallet_address: AGENT }, true)).resolves.toMatchObject({ checked: false });
  });

  test('a row READ with no wallet is the one case that says no approval can exist', async () => {
    await expect(approvalForAgentRow(untouched, OWNER, { wallet_address: null }, false)).resolves.toMatchObject({ checked: true, live: false });
  });

  test('a row with a wallet reads the chain', async () => {
    await expect(approvalForAgentRow(chain(2_500_000n), OWNER, { wallet_address: AGENT }, false)).resolves.toMatchObject({ checked: true, live: true, allowance_usdc: '2.5' });
  });
});
