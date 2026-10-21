/**
 * The L1 payment path for the DRY RUN: L1 policy checks + NPA preflight -> kernel -> send -> read back.
 *
 * The decisions are not made here. They are src/kernel/l1.ts (`checkL1Presentation`, which also runs
 * src/services/npa-preflight.ts) and the kernel (`runUnderKernel`), both covered by tsc and CI. This file
 * is the I/O around them: read the experiment policy file and the kill-switch file, read the durable
 * ledger, ask the chain, send, read back. It is the same shape as the L0 arena's `present`
 * (scripts/e2e-local/arena/world.ts). Not here, and needed before L1 is armed: the x402 tier gate
 * (`checkTransactionAuthority`, which can only refuse more) and an unattended runner.
 *
 * The buyer key is a DISPOSABLE testnet key held by this process only. No model ever sees it, and
 * nothing here prints or writes it.
 */
import { existsSync, readFileSync } from 'node:fs';
import { runUnderKernel } from '../../src/kernel/gate';
import { L1_CHAIN_ID, checkL1Presentation, l1Tally } from '../../src/kernel/l1';
import { StoreLedger, createJsonlStore } from '../../src/kernel/store';
import type { GateDeps, KernelSink, ReceiptEnv } from '../../src/kernel/types';
import type { SignatureChain } from '../../src/services/wallet-signature';
import { npaHashOrNull, type PreflightRefusal, type Presentation } from '../../src/services/npa-preflight';
import type { ChainPort } from '../e2e-local/arena/chain';
import { classifySettlement, type Hex, type TxReadback } from '../e2e-local/arena/core';

export interface L1ExecConfig {
  experimentPath: string;
  pinnedExperimentId: string;
  /** L1_OWNER_ADDRESS: set by the owner out of band, never read from the policy. */
  pinnedOwner: string;
  subject: string;
  /** Must already exist (scripts/l1/init-ledger.ts). Never created here. */
  ledgerPath: string;
  chain: ChainPort;
  buyerKey: Hex;
  now: () => number;
  /** For a smart-wallet owner signature. The dry run passes one that refuses to reach any chain. */
  signatureChain: SignatureChain;
  env: ReceiptEnv;
}

export interface L1Attempt {
  label: string;
  status: 'SETTLED' | 'REFUSED' | 'FAILED' | 'UNKNOWN';
  refusals: PreflightRefusal[];
  kernel: { verdict: string; executed: boolean; reasons: string[] } | null;
  tx_hash: Hex | null;
  why: string | null;
}

export interface L1Runner {
  cfg: L1ExecConfig;
  sink: KernelSink;
  deps: GateDeps;
  /** One presentation at a time. */
  queue: Promise<unknown>;
}

/** Open the executor over its durable ledger. Calling it again is a restart: nothing survives but the file. */
export function openL1(cfg: L1ExecConfig): L1Runner {
  const sink = createJsonlStore(cfg.ledgerPath, { create: false });
  const deps: GateDeps = {
    ledger: new StoreLedger(sink),
    resolveOwner: async () => ({ status: 'resolved', wallet: cfg.pinnedOwner, assurance: 'wallet-proven' }),
    now: cfg.now,
    env: cfg.env,
    chain: cfg.signatureChain,
  };
  return { cfg, sink, deps, queue: Promise.resolve() };
}

/**
 * Serialised: the 24 h payment COUNT is read from the ledger outside the kernel's lock, so two presentations
 * in flight could both see 19. ponytail: one global queue; per-subject queues if L1 ever needs throughput.
 */
export function presentL1(r: L1Runner, pres: Presentation, label: string): Promise<L1Attempt> {
  const run = r.queue.then(() => presentOnce(r, pres, label));
  r.queue = run.catch(() => undefined);
  return run;
}

const refused = (label: string, refusals: PreflightRefusal[], kernel: L1Attempt['kernel'] = null): L1Attempt => ({ label, status: 'REFUSED', refusals, kernel, tx_hash: null, why: null });

async function presentOnce(r: L1Runner, pres: Presentation, label: string): Promise<L1Attempt> {
  const { cfg } = r;
  const nowS = Math.floor(cfg.now() / 1000);

  let experiment: { kill_switch_path?: unknown; assets?: Array<{ contract?: unknown }> } | null;
  try {
    experiment = JSON.parse(readFileSync(cfg.experimentPath, 'utf8'));
  } catch {
    return refused(label, [{ stage: 'policy', code: 'experiment_unreadable' }]);
  }
  const killPath = typeof experiment?.kill_switch_path === 'string' ? experiment.kill_switch_path : '';
  let records;
  let signed;
  try {
    records = await r.sink.readAll();
    signed = await r.deps.ledger.latestPolicy(cfg.subject);
  } catch {
    return refused(label, [{ stage: 'policy', code: 'ledger_unreadable', detail: 'the durable ledger is missing or damaged; nothing is recreated' }]);
  }
  const token = String(experiment?.assets?.[0]?.contract ?? '') as Hex;
  const refusals = checkL1Presentation({
    experiment,
    pinned_experiment_id: cfg.pinnedExperimentId,
    signed,
    pinned_owner: cfg.pinnedOwner,
    now_s: nowS,
    kill_switch_present: killPath !== '' && existsSync(killPath),
    pres,
    tally: l1Tally(records, cfg.subject, nowS),
    connected_chain_id: await cfg.chain.chainId(),
    token_info: /^0x[0-9a-fA-F]{40}$/.test(token) ? await cfg.chain.tokenInfo(token) : null,
  });
  if (refusals.length) return refused(label, refusals);

  // The kernel alone authorises. The class is set HERE, never taken from a model: `spend`.
  const npaHash = npaHashOrNull(pres.npa.npa)!;
  const seen: { hash?: Hex; rb?: TxReadback } = {};
  const tool = async () => {
    if (existsSync(killPath)) throw Object.assign(new Error('kill switch'), { name: 'KillSwitchError' });
    const hash = await cfg.chain.send({ key: cfg.buyerKey, asset: pres.request.asset, to: pres.request.recipient, amount: BigInt(pres.request.amount_raw) });
    seen.hash = hash;
    seen.rb = await cfg.chain.readback(hash);
    return hash;
  };
  const out = await runUnderKernel(
    {
      agent: { agent_id: cfg.subject, agent_name: 'l1-buyer' },
      tool: { name: 'l1.pay', class: 'spend' },
      origin: 'l1',
      args_hash: `0x${npaHash}`,
      amount_raw: pres.request.amount_raw,
      payee: pres.request.recipient,
      asset: 'USDC',
      chain_id: L1_CHAIN_ID,
    },
    tool,
    r.deps,
    {
      observePayment: () => ({
        scheme: 'erc20-transfer',
        payer: pres.npa.npa.buyer,
        tx_hash: seen.hash ?? null,
        block: seen.rb?.block !== undefined ? Number(seen.rb.block) : null,
        observed_amount_raw: (seen.rb?.transfers.reduce((s, t) => s + t.amount, 0n) ?? 0n).toString(),
        measured: seen.rb?.success === true,
      }),
    },
  );
  const kernel = { verdict: out.verdict, executed: out.executed, reasons: out.reasons.map((x) => x.code) };
  if (!out.executed) return refused(label, [{ stage: 'presentation', code: `kernel_${out.verdict}`, detail: kernel.reasons.join(',') }], kernel);
  if (out.tool_error === 'KillSwitchError') return refused(label, [{ stage: 'policy', code: 'kill_switch', detail: 'appeared after the checks, before the broadcast; nothing was sent' }], kernel);
  if (out.tool_error) return { label, status: 'FAILED', refusals: [], kernel, tx_hash: seen.hash ?? null, why: `the payment tool threw (${out.tool_error})` };
  const c = classifySettlement(pres.npa.npa, seen.rb ?? null);
  return { label, status: c.status, refusals: [], kernel, tx_hash: seen.hash ?? null, why: c.why };
}
