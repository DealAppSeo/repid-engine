/**
 * The L1 dry run, OFFLINE: a throwaway Hardhat node on 127.0.0.1 at chain id 84532 (so the policy under test is
 * byte-for-byte the Base Sepolia shape), throwaway keys in memory, the scenarios in scripts/l1/scenarios.ts.
 * Any fetch to a host other than 127.0.0.1 throws and is counted, so "offline" is measured, not assumed.
 *
 *   npx ts-node --transpile-only scripts/l1/dry-run.ts [--devnet E:\dev\ops\loop\l1\devnet] [--out E:\dev\ops\loop\l1\dryrun-<stamp>]
 *
 * --devnet is any folder with its OWN local Hardhat 3 install (hardhat@3.12.0) and a config with no networks
 * (`export default {}`); the chain id comes from --chain-id. Writes results.json, review-sheet.md and summary.txt to --out.
 * Exit 0 only when every scenario held and nothing left the machine.
 */
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { l1LedgerPathProblem } from '../../src/kernel/l1';
import { ViemChain } from '../e2e-local/arena/chain';
import { runScenarios } from './scenarios';

const arg = (k: string, d: string): string => {
  const i = process.argv.indexOf(`--${k}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1]! : d;
};

const freePort = (): Promise<number> =>
  new Promise((ok, no) => {
    const s = createServer();
    s.listen(0, '127.0.0.1', () => {
      const a = s.address();
      s.close(() => (typeof a === 'object' && a ? ok(a.port) : no(new Error('no port'))));
    });
  });

async function main(): Promise<number> {
  const devnet = resolve(arg('devnet', 'E:\\dev\\ops\\loop\\l1\\devnet'));
  const out = resolve(arg('out', `E:\\dev\\ops\\loop\\l1\\dryrun-${new Date().toISOString().replace(/[:.]/g, '-')}`));
  const bad = l1LedgerPathProblem(join(out, 'kernel-ledger.jsonl'), tmpdir());
  if (bad) throw new Error(`--out: ${bad}`);
  mkdirSync(out, { recursive: true });

  const blocked: string[] = [];
  const realFetch = global.fetch;
  (global as { fetch: typeof fetch }).fetch = ((input: unknown, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : String((input as { url?: string })?.url ?? input);
    if (!/^http:\/\/127\.0\.0\.1:\d+\//.test(url)) {
      blocked.push(url);
      return Promise.reject(new Error('the dry run reaches no host but 127.0.0.1'));
    }
    return realFetch(input as never, init);
  }) as typeof fetch;
  // The tripwire must be able to say "blocked" before its zero means anything (LESSONS 5).
  await fetch('https://tripwire-self-test.invalid/').catch(() => undefined);
  if (blocked.length !== 1) throw new Error('the egress tripwire did not catch its own self-test');
  blocked.length = 0;

  const port = await freePort();
  const node = spawn(process.execPath, [join(devnet, 'node_modules', 'hardhat', 'dist', 'src', 'cli.js'), 'node', '--config', './hardhat.config.mjs', '--chain-id', '84532', '--hostname', '127.0.0.1', '--port', String(port)], { cwd: devnet, stdio: 'ignore', windowsHide: true });
  try {
    const rpc = `http://127.0.0.1:${port}/`;
    const chain = new ViemChain(rpc, 84532);
    let id = 0;
    for (let i = 0; i < 60 && id === 0; i++) {
      try {
        id = await chain.chainId();
      } catch {
        await new Promise((r) => setTimeout(r, 500));
      }
    }
    if (id !== 84532) throw new Error(`the devnet did not answer as chain 84532 (got ${id})`);
    const started = new Date().toISOString();
    const { results, sheet, artifacts } = await runScenarios(chain, out);
    const held = results.filter((r) => r.pass).length;
    const lines = [
      `L1 dry run  ${started}  Hardhat devnet chain ${id} at ${rpc} (throwaway)  out ${out}`,
      `policy digest ${artifacts.digest}  experiment ${artifacts.experiment.policy_id}`,
      '',
      ...results.map((r) => `${r.pass ? 'HELD' : 'FAIL'}  ${r.name}\n      expected: ${r.expect}\n      got:      ${r.got}\n      buyer tx: ${r.buyer_tx_before} -> ${r.buyer_tx_after}`),
      '',
      `${held}/${results.length} held; non-local requests blocked: ${blocked.length}${blocked.length ? ` (${blocked.join(', ')})` : ''}`,
    ];
    writeFileSync(join(out, 'results.json'), JSON.stringify({ started, chain_id: id, rpc, digest: artifacts.digest, experiment_id: artifacts.experiment.policy_id, results, blocked }, null, 2));
    writeFileSync(join(out, 'review-sheet.md'), sheet);
    writeFileSync(join(out, 'summary.txt'), lines.join('\n') + '\n');
    console.log(lines.join('\n'));
    return held === results.length && blocked.length === 0 ? 0 : 1;
  } finally {
    node.kill();
  }
}

main().then(
  (code) => process.exit(code),
  (e) => {
    console.error(`DRY RUN ERROR: ${(e as Error).message}`);
    process.exit(2);
  },
);
