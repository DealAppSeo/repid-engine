/**
 * The L1 dry-run scenarios, on any arena chain: a Hardhat devnet at chain id 84532 (scripts/l1/dry-run.ts) or the
 * in-memory twin (tests/l1-dryrun.test.ts, so CI runs the same list). Every key is generated in memory for this
 * run and dropped with it: the "owner" here is a throwaway wallet standing in for the owner's, never the owner's.
 *
 * Each scenario states what it expects BEFORE it runs, records what happened, and the buyer's on-chain
 * transaction count before and after, so "refused" is checked against the chain, not just the return value.
 */
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Wallet } from 'ethers';
import { generatePrivateKey, privateKeyToAccount, privateKeyToAddress } from 'viem/accounts';
import { dryDecision } from '../../src/kernel/gate';
import { buildL1, l1LedgerPathProblem, renderReviewSheet, type L1Artifacts } from '../../src/kernel/l1';
import { hashArgs } from '../../src/kernel/receipt';
import { PolicyNonceError, StoreLedger, createJsonlStore } from '../../src/kernel/store';
import type { SignedOwnerPolicy } from '../../src/kernel/types';
import { jcs, sha256Hex, type Presentation } from '../../src/services/npa-preflight';
import type { TestChain } from '../e2e-local/arena/chain';
import { serviceHashOf, signNpa, type Hex, type Npa } from '../e2e-local/arena/core';
import { openL1, presentL1, type L1Attempt, type L1Runner } from './executor';
import { initL1Ledger } from './init-ledger';

export interface ScenarioResult {
  name: string;
  expect: string;
  pass: boolean;
  got: string;
  buyer_tx_before: number;
  buyer_tx_after: number;
}

const offline = { getCode: async () => '0x', call: async () => { throw new Error('the dry run reaches no chain for a signature'); } };
const ORACLE = join(__dirname, '..', 'e2e-local', 'arena', 'oracle.ts');
const usdc = (n: number): string => String(Math.round(n * 1e6));

/** Sign exactly what a wallet would sign for eth_signTypedData_v4: the payload's own domain, types and message. */
export async function signPayload(owner: Pick<Wallet, 'signTypedData'>, payload: string): Promise<string> {
  const t = JSON.parse(payload) as { domain: Record<string, unknown>; types: Record<string, unknown>; message: Record<string, unknown> };
  const { EIP712Domain: _d, ...types } = t.types;
  return owner.signTypedData(t.domain, types as never, t.message);
}

export async function runScenarios(chain: TestChain, dir: string): Promise<{ results: ScenarioResult[]; sheet: string; artifacts: L1Artifacts }> {
  let nowMs = Date.now();
  const now = () => nowMs;
  const nowS = () => Math.floor(nowMs / 1000);
  const owner = Wallet.createRandom();
  const attacker = Wallet.createRandom();
  const keys = { buyer: generatePrivateKey(), seller: generatePrivateKey() };
  const buyer = privateKeyToAddress(keys.buyer) as Hex;
  const seller = privateKeyToAddress(keys.seller) as Hex;

  await chain.fundNative(buyer, 20_000_000_000_000_000n); // 0.02 test ETH, the spec's ceiling
  const token = await chain.deployToken('Mock USD Coin (L1 dry run)', 'USDC');
  await chain.mint(token, buyer, 20_000_000n); // 20 test USDC, the spec's ceiling

  const killPath = join(dir, 'KILL');
  const experimentPath = join(dir, 'l1-experiment-policy.json');
  const subject = `l1-dryrun-${randomUUID()}`;
  const t0 = nowS();
  const artifacts = buildL1({
    subject, owner: owner.address, buyer, seller, usdc: token,
    per_tx_raw: usdc(1), daily_raw: usdc(10), total_raw: usdc(20), tx_per_day: 20, max_fee_wei: '100000000000000',
    not_before: t0 - 60, expires_at: t0 + 72 * 3600, kill_switch_path: killPath,
    evaluator_sha256: createHash('sha256').update(readFileSync(ORACLE, 'utf8').replace(/\r\n/g, '\n')).digest('hex'), nonce: '1',
  });
  writeFileSync(experimentPath, JSON.stringify(artifacts.experiment, null, 2));
  const sheet = renderReviewSheet(artifacts.payload, readFileSync(experimentPath, 'utf8'));
  const signature = await signPayload(owner, artifacts.payload);
  const signed: SignedOwnerPolicy = { policy: artifacts.policy, signature };

  const results: ScenarioResult[] = [];
  const txCount = () => chain.txCount(buyer);
  const record = async (name: string, expect: string, fn: () => Promise<{ pass: boolean; got: string }>) => {
    const before = await txCount();
    let r: { pass: boolean; got: string };
    try {
      r = await fn();
    } catch (e) {
      r = { pass: false, got: `threw: ${String((e as Error).message).slice(0, 160)}` };
    }
    results.push({ name, expect, ...r, buyer_tx_before: before, buyer_tx_after: await txCount() });
  };
  const show = (a: L1Attempt) => `${a.status} ${a.refusals.map((x) => x.code).join(',')}${a.kernel ? ` kernel=${a.kernel.verdict}(${a.kernel.reasons.join(',')})` : ''}`;
  const codes = (a: L1Attempt) => a.refusals.map((x) => x.code);

  const npaFor = async (amountRaw: string, over: Partial<Npa> = {}): Promise<Presentation> => {
    const npa: Npa = {
      buyer, seller, service_hash: serviceHashOf('dry-run deliverable', ['returns 200']), chain_id: 84532, asset: token, decimals: 6,
      amount_raw: amountRaw, quote_source: 'l1-dry-run', quote_expires_at: nowS() + 600, max_fee_wei: '100000000000000',
      settlement: 'onchain-readback', nonce: `0x${randomBytes(32).toString('hex')}` as Hex, ...over,
    };
    const [buyer_sig, seller_sig] = [await signNpa(privateKeyToAccount(keys.buyer), npa), await signNpa(privateKeyToAccount(keys.seller), npa)];
    return { operation: 'pay', npa: { npa, buyer_sig, seller_sig }, request: { chain_id: 84532, asset: token, recipient: seller, amount_raw: amountRaw, payer: buyer } };
  };
  const cfgFor = (ledgerPath: string, pinnedOwner = owner.address) => ({
    experimentPath, pinnedExperimentId: artifacts.experiment.policy_id, pinnedOwner, subject, ledgerPath, chain, buyerKey: keys.buyer as Hex,
    now, signatureChain: offline, env: { network: 'hardhat-local', chain_id: 84532, is_simulated: true },
  });
  /** A ledger written around init-ledger's checks, to show what the KERNEL does with what init would refuse. */
  const rawLedger = async (name: string, s: SignedOwnerPolicy | null): Promise<L1Runner> => {
    const p = join(dir, `${name}.jsonl`);
    writeFileSync(p, '');
    if (s) await new StoreLedger(createJsonlStore(p, { create: false })).appendPolicy(s, new Date(nowMs).toISOString());
    return openL1(cfgFor(p));
  };
  const kernelAlone = async (r: L1Runner, cls: string, amountRaw: string | null) => {
    const d = await dryDecision({
      agent: { agent_id: subject, agent_name: 'l1-buyer' }, tool: { name: 'l1.pay', class: cls }, origin: 'l1', args_hash: hashArgs({ probe: randomUUID() }),
      ...(cls === 'spend' ? { amount_raw: amountRaw, payee: seller, asset: 'USDC', chain_id: 84532 } : {}),
    }, r.deps);
    return 'malformed' in d ? `DENY(${d.malformed.map((x) => x.code).join(',')})` : `${d.verdict}(${d.reasons.map((x) => x.code).join(',')})`;
  };

  // ── refusals before anything is armed ──────────────────────────────────────────────────────────────
  const initArgs = (ledgerPath: string, s: unknown) => ({ ledgerPath, signed: s, experiment: artifacts.experiment, pinnedOwner: owner.address, chain: offline, recordedAt: new Date(nowMs).toISOString() });
  await record('unsigned policy: init refuses it and creates no ledger', 'init REFUSED, no file', async () => {
    const p = join(dir, 'unsigned.jsonl');
    const r = await initL1Ledger(initArgs(p, { policy: artifacts.policy, signature: `0x${'00'.repeat(65)}` }));
    return { pass: !r.ok && !existsSync(p), got: r.ok ? 'init accepted it' : `init: ${r.error}; file exists: ${existsSync(p)}` };
  });
  await record('unsigned policy smuggled into the ledger: the kernel refuses', 'REFUSED, kernel DENY policy_signature_invalid', async () => {
    const a = await presentL1(await rawLedger('unsigned-raw', { policy: artifacts.policy, signature: `0x${'00'.repeat(65)}` }), await npaFor(usdc(1)), 'unsigned-raw');
    return { pass: a.status === 'REFUSED' && !!a.kernel && a.kernel.reasons.includes('policy_signature_invalid'), got: show(a) };
  });
  await record('no policy at all in the ledger', 'REFUSED owner_policy_missing', async () => {
    const a = await presentL1(await rawLedger('empty', null), await npaFor(usdc(1)), 'empty');
    return { pass: a.status === 'REFUSED' && codes(a).includes('owner_policy_missing'), got: show(a) };
  });
  await record('wrong signer: an attacker signs the owner\'s policy', 'init REFUSED; smuggled in, kernel DENY policy_signature_invalid', async () => {
    const forged = { policy: artifacts.policy, signature: await signPayload(attacker, artifacts.payload) };
    const r = await initL1Ledger(initArgs(join(dir, 'forged.jsonl'), forged));
    const a = await presentL1(await rawLedger('forged-raw', forged), await npaFor(usdc(1)), 'forged-raw');
    return { pass: !r.ok && a.status === 'REFUSED' && !!a.kernel?.reasons.includes('policy_signature_invalid'), got: `init: ${r.ok ? 'accepted' : r.error}; present: ${show(a)}` };
  });
  await record('wrong signer: an attacker names itself owner and signs its own policy', 'init REFUSED; smuggled in, REFUSED owner_not_pinned_owner', async () => {
    const own = buildL1({ ...configOf(artifacts, owner.address, buyer, seller, token), owner: attacker.address });
    const s = { policy: own.policy, signature: await signPayload(attacker, own.payload) };
    const r = await initL1Ledger(initArgs(join(dir, 'self-owned.jsonl'), s));
    const a = await presentL1(await rawLedger('self-owned-raw', s), await npaFor(usdc(1)), 'self-owned-raw');
    return { pass: !r.ok && a.status === 'REFUSED' && codes(a).includes('owner_not_pinned_owner'), got: `init: ${r.ok ? 'accepted' : r.error}; present: ${show(a)}` };
  });
  await record('the ledger must not live in the OS temp directory', 'path rule refuses a ledger in the OS temp directory', async () => {
    const inTmp = l1LedgerPathProblem(join(tmpdir(), 'hyperdag-kernel', 'ledger.jsonl'), tmpdir());
    return { pass: inTmp !== null, got: `tmpdir path: ${inTmp ?? 'accepted'}` };
  });

  // ── armed (in this throwaway world only) ───────────────────────────────────────────────────────────
  const ledgerPath = join(dir, 'kernel-ledger.jsonl');
  const init = await initL1Ledger(initArgs(ledgerPath, signed));
  if (!init.ok) throw new Error(`the correctly signed policy was refused at init: ${init.error}`);
  let runner = openL1(cfgFor(ledgerPath));
  await record('init twice: an existing ledger is never replaced', 'init REFUSED (exists)', async () => {
    const r = await initL1Ledger(initArgs(ledgerPath, signed));
    return { pass: !r.ok, got: r.ok ? 'replaced' : r.error };
  });
  let first: Presentation | null = null;
  await record('correctly signed, within caps: 1 USDC', 'SETTLED, read back from the chain', async () => {
    first = await npaFor(usdc(1));
    const a = await presentL1(runner, first, 'within');
    return { pass: a.status === 'SETTLED' && (await chain.balance(token, seller)) === 1_000_000n, got: `${show(a)} seller=${await chain.balance(token, seller)}` };
  });
  await record('the same signed agreement presented again', 'REFUSED, kernel DENY authorization_consumed', async () => {
    const a = await presentL1(runner, first!, 'replay');
    return { pass: a.status === 'REFUSED' && !!a.kernel?.reasons.includes('authorization_consumed'), got: show(a) };
  });
  await record('over the per-payment cap: 1.000001 USDC', 'REFUSED over_per_tx_cap; kernel alone DENY spend_limit_exceeded', async () => {
    const a = await presentL1(runner, await npaFor('1000001'), 'over-per-tx');
    const k = await kernelAlone(runner, 'spend', '1000001');
    return { pass: a.status === 'REFUSED' && codes(a).includes('over_per_tx_cap') && k.startsWith('DENY') && k.includes('spend_limit_exceeded'), got: `${show(a)}; kernel alone: ${k}` };
  });
  await record('tampered field: the experiment policy file widened after signing (per payment 5 USDC), then also re-stamped with its new id', 'REFUSED experiment_hash_mismatch; re-stamped: REFUSED experiment_not_pinned + binding_mismatch', async () => {
    const orig = readFileSync(experimentPath, 'utf8');
    const t = JSON.parse(orig);
    t.per_tx_max_raw.USDC = usdc(5);
    try {
      writeFileSync(experimentPath, JSON.stringify(t, null, 2));
      const a = await presentL1(runner, await npaFor(usdc(2)), 'tamper-experiment');
      const { policy_id: _old, ...body } = t;
      writeFileSync(experimentPath, JSON.stringify({ policy_id: sha256Hex(jcs(body)), ...body }, null, 2));
      const b = await presentL1(runner, await npaFor(usdc(2)), 'tamper-experiment-restamped');
      return {
        pass: a.status === 'REFUSED' && codes(a).includes('experiment_hash_mismatch') && b.status === 'REFUSED' && codes(b).includes('experiment_not_pinned') && codes(b).includes('binding_mismatch'),
        got: `edited: ${show(a)}; re-stamped: ${show(b)}`,
      };
    } finally {
      writeFileSync(experimentPath, orig);
    }
  });
  await record('tampered field: the signed policy\'s payee swapped after signing', 'REFUSED; kernel alone DENY policy_signature_invalid', async () => {
    const t = JSON.parse(JSON.stringify(signed)) as SignedOwnerPolicy;
    t.policy.payees = [attacker.address];
    const r = await rawLedger('tampered-policy', t);
    const a = await presentL1(r, await npaFor(usdc(1)), 'tamper-policy');
    const k = await kernelAlone(r, 'spend', usdc(1));
    return { pass: a.status === 'REFUSED' && k.includes('policy_signature_invalid'), got: `${show(a)}; kernel alone: ${k}` };
  });
  await record('the executor holds a key that is not the approved buyer wallet', 'REFUSED buyer_key_not_approved_wallet, nothing sent from either key', async () => {
    const stray = generatePrivateKey();
    await chain.fundNative(privateKeyToAddress(stray) as Hex, 1_000_000_000_000_000n);
    const a = await presentL1(openL1({ ...cfgFor(ledgerPath), buyerKey: stray as Hex }), await npaFor(usdc(1)), 'stray-key');
    const sent = await chain.txCount(privateKeyToAddress(stray) as Hex);
    return { pass: a.status === 'REFUSED' && codes(a).includes('buyer_key_not_approved_wallet') && sent === 0, got: `${show(a)}; stray key sent ${sent}` };
  });
  await record('a call filed as read, other or post under this policy (the class is never the model\'s)', 'kernel DENY action_not_permitted for all three', async () => {
    const got = await Promise.all(['read', 'other', 'post'].map(async (c) => `${c}:${await kernelAlone(runner, c, null)}`));
    return { pass: got.every((g) => g.includes('DENY') && g.includes('action_not_permitted')), got: got.join(' ') };
  });
  await record('the daily cap: nine more 1 USDC payments, then a tenth', '9 SETTLED, then REFUSED over_aggregate_cap; kernel alone DENY (daily)', async () => {
    const settled: string[] = [];
    for (let i = 0; i < 9; i++) settled.push((await presentL1(runner, await npaFor(usdc(1)), `day1-${i}`)).status);
    const a = await presentL1(runner, await npaFor(usdc(1)), 'day1-over');
    const k = await kernelAlone(runner, 'spend', usdc(1));
    return { pass: settled.every((s) => s === 'SETTLED') && a.status === 'REFUSED' && codes(a).includes('over_aggregate_cap') && k.includes('DENY'), got: `${settled.join(',')}; then ${show(a)}; kernel alone: ${k}` };
  });
  await record('restart: a new executor over the same ledger file', 'history kept: still REFUSED for today; the older policy cannot be re-appended', async () => {
    runner = openL1(cfgFor(ledgerPath));
    const a = await presentL1(runner, await npaFor('500000'), 'after-restart');
    let reAppend = 'accepted';
    try {
      await new StoreLedger(createJsonlStore(ledgerPath, { create: false })).appendPolicy(signed, new Date(nowMs).toISOString());
    } catch (e) {
      reAppend = e instanceof PolicyNonceError ? 'refused (nonce)' : `refused (${(e as Error).name})`;
    }
    return { pass: a.status === 'REFUSED' && reAppend.startsWith('refused'), got: `${show(a)}; re-append old policy: ${reAppend}` };
  });
  await record('the ledger file is gone (wiped disk, wrong path)', 'REFUSED ledger_unreadable, and the file is NOT recreated', async () => {
    const moved = `${ledgerPath}.away`;
    renameSync(ledgerPath, moved);
    try {
      const a = await presentL1(openL1(cfgFor(ledgerPath)), await npaFor(usdc(1)), 'no-ledger');
      return { pass: a.status === 'REFUSED' && codes(a).includes('ledger_unreadable') && !existsSync(ledgerPath), got: `${show(a)}; recreated: ${existsSync(ledgerPath)}` };
    } finally {
      renameSync(moved, ledgerPath);
    }
  });
  nowMs += 25 * 3600 * 1000; // day 2: the rolling 24 h window has passed
  await record('day 2, the count cap: twenty 0.01 USDC payments, then a twenty-first', '20 SETTLED, then REFUSED tx_count_exhausted', async () => {
    const st: string[] = [];
    for (let i = 0; i < 20; i++) st.push((await presentL1(runner, await npaFor('10000'), `day2-${i}`)).status);
    const a = await presentL1(runner, await npaFor('10000'), 'day2-over-count');
    return { pass: st.every((s) => s === 'SETTLED') && a.status === 'REFUSED' && codes(a).includes('tx_count_exhausted'), got: `${st.join(',')}; then ${show(a)}` };
  });
  await record('kill switch: the file exists', 'REFUSED kill_switch, nothing sent', async () => {
    writeFileSync(killPath, 'stop');
    try {
      const a = await presentL1(runner, await npaFor(usdc(1)), 'kill');
      return { pass: a.status === 'REFUSED' && codes(a).includes('kill_switch'), got: show(a) };
    } finally {
      rmSync(killPath);
    }
  });
  nowMs = (artifacts.policy.expires_at + 1) * 1000;
  await record('expired: one second after expires_at', 'REFUSED policy_expired; kernel alone DENY policy_expired', async () => {
    const a = await presentL1(runner, await npaFor(usdc(1)), 'expired');
    const k = await kernelAlone(runner, 'spend', usdc(1));
    return { pass: a.status === 'REFUSED' && codes(a).includes('policy_expired') && k.includes('policy_expired'), got: `${show(a)}; kernel alone: ${k}` };
  });

  return { results, sheet, artifacts };
}

/** The config an artifact set was built from (for building a variant). */
function configOf(a: L1Artifacts, owner: string, buyer: string, seller: string, token: string) {
  return {
    subject: a.policy.subject, owner, buyer, seller, usdc: token, per_tx_raw: a.policy.per_tx_raw, daily_raw: a.policy.daily_raw,
    total_raw: a.policy.total_raw, tx_per_day: a.experiment.max_tx_count, max_fee_wei: a.experiment.max_fee_wei, not_before: a.experiment.not_before,
    expires_at: a.policy.expires_at, kill_switch_path: a.experiment.kill_switch_path, evaluator_sha256: a.experiment.evaluator_sha256, nonce: a.policy.nonce,
  };
}

