/**
 * Shared test fixtures for the kernel suites. Not a test file (jest only runs *.test.ts).
 *
 * The owner wallet is `Wallet.createRandom()`: it exists in memory for one test and is never
 * written anywhere. Nothing here is funded, and nothing dials a chain.
 */
import { Wallet } from 'ethers';
import { POLICY_DOMAIN, POLICY_TYPES, policyTypedValue } from '../policy';
import { hashArgs } from '../receipt';
import { StoreLedger, createMemoryStore } from '../store';
import type { GateDeps, OwnerPolicy, SignedOwnerPolicy } from '../types';

export const NOW_MS = 1_800_000_000_000;
export const NOW_S = NOW_MS / 1000;
export const AGENT_ID = '11111111-1111-4111-8111-111111111111';
export const PAYEE = '0x000000000000000000000000000000000000dEaD';
export const iso = new Date(NOW_MS).toISOString();

export function harness(over: Partial<GateDeps> = {}) {
  const sink = createMemoryStore();
  const ledger = new StoreLedger(sink);
  const owner = Wallet.createRandom(); // in memory only; never written anywhere
  let n = 0;
  const deps: GateDeps = {
    ledger,
    resolveOwner: async () => ({ status: 'resolved', wallet: owner.address, assurance: 'wallet-proven' }),
    now: () => NOW_MS,
    newId: () => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`,
    ...over,
  };
  return { sink, ledger, owner, deps };
}

export async function signedPolicy(signer: Wallet, over: Partial<OwnerPolicy> & { claimedOwner?: string } = {}): Promise<SignedOwnerPolicy> {
  const { claimedOwner, ...rest } = over;
  const policy: OwnerPolicy = {
    subject: AGENT_ID,
    owner: claimedOwner ?? signer.address,
    actions: ['spend', 'post', 'tool'],
    payees: [PAYEE],
    per_tx_raw: '1000000',
    daily_raw: '5000000',
    total_raw: '20000000',
    expires_at: NOW_S + 3600,
    nonce: '1',
    ...rest,
  };
  const signature = await signer.signTypedData(POLICY_DOMAIN, POLICY_TYPES, policyTypedValue(policy));
  return { policy, signature };
}

export function spendRequest(over: Record<string, unknown> = {}) {
  return {
    agent: { agent_id: AGENT_ID, agent_name: 'kernel-demo-agent' },
    tool: { name: 'x402.pay', class: 'spend' },
    origin: 'Cli',
    args_hash: hashArgs({ resource: 'https://example.invalid/paid' }),
    amount_raw: 10000,
    payee: PAYEE,
    asset: 'USDC',
    chain_id: 84532,
    ...over,
  };
}

/**
 * A stand-in for the Supabase client, holding the one table the durable ledger sink uses
 * (`seq`, `line`) in memory. A "restart" is a NEW ledger over the SAME table: what a redeploy leaves
 * when the ledger lives in the database. `pageCap` models a server row cap below the page the sink
 * asks for; `down` makes every call fail the way an unreachable database does; a duplicate `seq` fails
 * like the primary key does (23505).
 */
export function fakeLedgerTable(opts: { pageCap?: number } = {}) {
  const rows: Array<{ seq: number; line: string }> = [];
  const state = { down: false };
  const done = <T>(v: T) => ({ abortSignal: () => Promise.resolve(v) });
  const unreachable = { message: 'connect ECONNREFUSED' };
  const client = {
    from: () => ({
      select: () => ({
        order: () => ({
          range: (a: number, b: number) =>
            done(state.down ? { data: null, error: unreachable } : { data: [...rows].sort((x, y) => x.seq - y.seq).slice(a, Math.min(b, a + (opts.pageCap ?? Infinity) - 1) + 1), error: null }),
        }),
      }),
      insert: (row: { seq: number; line: string }) => {
        if (state.down) return done({ error: unreachable });
        if (rows.some((r) => r.seq === row.seq)) return done({ error: { code: '23505', message: 'duplicate key value violates unique constraint "kernel_ledger_pkey"' } });
        rows.push({ ...row });
        return done({ error: null });
      },
    }),
  };
  return { client: client as never, rows, state };
}

export function postRequest(over: Record<string, unknown> = {}) {
  return {
    agent: { agent_id: AGENT_ID, agent_name: 'kernel-demo-agent' },
    tool: { name: 'social.post', class: 'post' },
    origin: 'Cli',
    args_hash: hashArgs({ channel: 'demo' }),
    ...over,
  };
}
