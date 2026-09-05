/**
 * trustshell-tool-receipt.test.ts — the single write path to trustshell_tool_receipts.
 * It must go via the RPC, validate hashes, and never throw.
 */
import { writeToolReceipt, toolReceiptsEnabled, ToolReceiptInput } from '../src/services/trustshell-tool-receipt';

const HEX = 'a'.repeat(64);
const input = (over: Partial<ToolReceiptInput> = {}): ToolReceiptInput => ({
  vertical: 'trustshell',
  agentId: 'agent-1',
  toolName: 'hal-evaluate',
  inputHash: HEX,
  outputHash: 'b'.repeat(64),
  ...over,
});

const fakeDb = (impl: (fn: string, args: any) => Promise<{ data: unknown; error: unknown }>) =>
  ({ rpc: impl } as any);

describe('writeToolReceipt', () => {
  it('calls the write_tool_receipt RPC (never a direct insert) and returns the id', async () => {
    let calledFn = '';
    let calledArgs: any = null;
    const db = fakeDb(async (fn, args) => { calledFn = fn; calledArgs = args; return { data: 'rcpt-uuid', error: null }; });
    const id = await writeToolReceipt(db, input());
    expect(calledFn).toBe('write_tool_receipt');
    expect(calledArgs.p_input_hash).toBe(HEX);
    expect(calledArgs.p_agent_id).toBe('agent-1');
    expect(id).toBe('rcpt-uuid');
  });

  it('refuses (returns null) and does NOT call the RPC on a malformed hash', async () => {
    let called = false;
    const db = fakeDb(async () => { called = true; return { data: null, error: null }; });
    const id = await writeToolReceipt(db, input({ inputHash: 'not-hex' }));
    expect(called).toBe(false);
    expect(id).toBeNull();
  });

  it('returns null (never throws) when the RPC errors', async () => {
    const db = fakeDb(async () => ({ data: null, error: { message: 'RECEIPT_SIGNING_KEY_UNPROVISIONED' } }));
    expect(await writeToolReceipt(db, input())).toBeNull();
  });

  it('returns null (never throws) when the RPC throws', async () => {
    const db = fakeDb(async () => { throw new Error('network'); });
    expect(await writeToolReceipt(db, input())).toBeNull();
  });

  it('defaults to off (opt-in)', () => {
    expect(toolReceiptsEnabled()).toBe(false);
  });
});
