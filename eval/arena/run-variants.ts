/**
 * XC1 red-team variant runner: execute validated variants against the L0 arena executor and grade
 * them with the FROZEN grader (variants.ts). FROZEN with it (eval/arena/manifest.json).
 *
 *   npx ts-node --transpile-only --project <arena-repo>/tsconfig.json eval/arena/run-variants.ts \
 *        --arena-repo <dir> --variants <file.json> --out <file.json> [--rpc http://127.0.0.1:PORT]
 *
 * <arena-repo> is a checkout with scripts/e2e-local/arena (PR #1452) and the engine under test. Its
 * executor runs unmodified: the arena preflight, the x402 gate, the kernel. Without --rpc the chain is
 * the arena's in-memory twin. No model is called here and no key leaves the process: the loop
 * (E:\dev\ops\loop\redteam-loop.mjs) did the model calls and hands over JSON variants only.
 * Last stdout line: `REDTEAM_RESULT {json}`. Exit 0 when every variant ran, 2 on a crash.
 */
import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { gradeVariant, validateVariant, type AddressRef, type AmountRef, type SigRef, type TxRef, type VObserved, type VPresentation, type Variant } from './variants';

const arg = (k: string) => { const i = process.argv.indexOf(`--${k}`); return i >= 0 ? process.argv[i + 1] : undefined; };
const sha256 = (b: string | Buffer) => createHash('sha256').update(b).digest('hex');

async function main() {
  const repo = resolve(arg('arena-repo') ?? join(__dirname, '..', '..'));
  const A = (m: string) => require(join(repo, 'scripts', 'e2e-local', 'arena', m));
  const { bootEngine } = A('engine');
  const { MemoryChain, ViemChain } = A('chain');
  const world = A('world');
  const core = A('core');
  const { privateKeyToAccount } = require(require.resolve('viem/accounts', { paths: [repo] }));

  const engine = bootEngine();
  const rpc = arg('rpc');
  const chain = rpc ? new ViemChain(rpc) : new MemoryChain();
  const raw = JSON.parse(readFileSync(resolve(arg('variants')!), 'utf8')) as Array<{ id: string; variant: unknown }>;
  const frozen = {
    arena_repo_git_sha: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo }).toString().trim(),
    oracle_sha256: sha256(readFileSync(join(__dirname, 'oracle.ts'))),
    variants_sha256: sha256(readFileSync(join(__dirname, 'variants.ts'))),
    runner_sha256: sha256(readFileSync(__filename)),
    chain: rpc ? 'hardhat-devnet' : 'in-memory twin',
  };
  const results: unknown[] = [];

  for (const item of raw) {
    const v = validateVariant(item.variant);
    if (!v.ok) { results.push({ id: item.id, verdict: 'NOT_CHECKED', not_checked_reason: `invalid variant: ${v.why}` }); continue; }
    let w: any = null;
    try {
      w = await world.makeWorld({ chain, engine, evaluatorSha256: frozen.oracle_sha256 });
      results.push({ id: item.id, ...(await runOne(v.variant, w, core, world, privateKeyToAccount, engine, chain)), frozen: { ...frozen, policy_id: w.policy.policy_id, chain_id: w.policy.chain_id } });
    } catch (e) {
      results.push({ id: item.id, class: v.variant.class, verdict: 'NOT_CHECKED', not_checked_reason: `harness error: ${String((e as Error).message).slice(0, 160)}` });
    } finally {
      if (w) world.disposeWorld(w);
    }
  }
  writeFileSync(resolve(arg('out')!), JSON.stringify({ frozen, egress: engine.egress, results }, null, 1));
  const n = (s: string) => results.filter((r: any) => r.verdict === s).length;
  console.log(`REDTEAM_RESULT ${JSON.stringify({ variants: results.length, pass: n('PASS'), fail: n('FAIL'), not_checked: n('NOT_CHECKED'), egress_blocked: engine.egress.blocked.length, ...frozen })}`);
}

async function runOne(v: Variant, w: any, core: any, world: any, toAccount: (k: string) => any, engine: any, chain: any) {
  const zero = core.ZERO_ADDRESS as string;
  const flip = (a: string) => `0x${a.slice(2, 41)}${a[41]!.toLowerCase() === 'f' ? '0' : 'f'}` ;
  const addr: Record<AddressRef, string> = {
    seller: w.addr.seller, buyer: w.addr.buyer, attacker: w.addr.attacker, usdc: w.addr.usdc, decoy: w.addr.decoy, zero,
    seller_lower: w.addr.seller.toLowerCase(), seller_upper: `0x${w.addr.seller.slice(2).toUpperCase()}`, seller_flip: flip(w.addr.seller),
  };
  const keyOf = (a: string): string | null => (core.sameAddr(a, w.addr.buyer) ? w.keys.buyer : core.sameAddr(a, w.addr.seller) ? w.keys.seller : core.sameAddr(a, w.addr.attacker) ? w.keys.attacker : null);
  const entry = w.policy.assets.find((x: any) => x.symbol === v.asset);
  const perTx = BigInt(w.policy.per_tx_max_raw[v.asset]);
  const amount = (r: AmountRef): string =>
    typeof r === 'object' ? r.literal
      : ({ cap: perTx, cap_plus_1: perTx + 1n, half_cap: perTx / 2n, one: 1n, zero: 0n, double_cap: perTx * 2n } as Record<string, bigint>)[r]!.toString();
  const nowS = () => Math.floor(w.now() / 1000);

  // the NPA both parties sign, then the request presented with it
  const npa = {
    buyer: w.addr.buyer,
    seller: addr[v.npa.seller ?? 'seller'],
    service_hash: core.serviceHashOf(`XC1 red-team variant: ${v.label}`, ['non-empty answer']),
    chain_id: v.npa.chain_id ?? w.policy.chain_id,
    asset: addr[v.npa.asset ?? (v.asset === 'USDC' ? 'usdc' : 'zero')],
    decimals: v.npa.decimals ?? entry.decimals,
    amount_raw: amount(v.npa.amount ?? 'half_cap'),
    quote_source: v.npa.quote_source ?? 'l0:fixed-amount-in-payment-asset',
    quote_expires_at: nowS() + (v.npa.quote_expires_in_s ?? 300),
    max_fee_wei: v.npa.max_fee_wei ?? w.policy.max_fee_wei,
    settlement: v.npa.settlement ?? 'onchain-readback',
    nonce: `0x${randomBytes(32).toString('hex')}`,
  };
  const sign = async (slot: 'buyer' | 'seller', how: SigRef): Promise<string | null> => {
    const named = slot === 'buyer' ? npa.buyer : npa.seller;
    const other = slot === 'buyer' ? npa.seller : npa.buyer;
    const key = how === 'none' ? null : how === 'attacker' ? w.keys.attacker : how === 'counterparty' ? keyOf(other) : keyOf(named);
    if (!key) return null;
    try { return await core.signNpa(toAccount(key), npa); } catch { return null; } // an NPA no wallet can sign (a malformed amount) goes unsigned
  };
  const signed = { npa, buyer_sig: await sign('buyer', v.signatures.buyer), seller_sig: await sign('seller', v.signatures.seller) };
  const sigValid = async (slot: 'buyer' | 'seller') => {
    const got = await core.npaSigner(npa, slot === 'buyer' ? signed.buyer_sig : signed.seller_sig);
    return !!got && core.sameAddr(got, slot === 'buyer' ? npa.buyer : npa.seller);
  };
  const sig_valid = { buyer: await sigValid('buyer'), seller: await sigValid('seller') };
  const request = {
    chain_id: v.request.chain_id ?? npa.chain_id,
    asset: v.request.asset ? addr[v.request.asset] : npa.asset,
    recipient: v.request.recipient ? addr[v.request.recipient] : npa.seller,
    amount_raw: v.request.amount ? amount(v.request.amount) : npa.amount_raw,
    payer: v.request.payer ? addr[v.request.payer] : npa.buyer,
  };
  const operation = v.request.operation ?? 'pay';
  const pres = { operation, npa: signed, request };
  const npaHash = core.npaHashOf(npa);

  const snap = async () => {
    const one = async (a: string) => ({ ETH: (await chain.balance(zero, a)).toString(), USDC: (await chain.balance(w.addr.usdc, a)).toString(), DECOY: (await chain.balance(w.addr.decoy, a)).toString() });
    return { buyer: await one(w.addr.buyer), seller: await one(w.addr.seller), attacker: await one(w.addr.attacker) };
  };
  const repidOf = async (id: string) => (await engine.db.from('repid_agents').select('*').eq('id', id).single()).data.current_repid as number;
  const before = await snap();
  const nonceBefore = await chain.txCount(w.addr.buyer);
  const [provider0, buyer0] = [await repidOf(w.agents.seller.id), await repidOf(w.agents.buyer.id)];

  // present it: once, N times in sequence (optionally restarting the engine between), or N at once
  const presented: Array<{ at_s: number; att: any }> = [];
  const once = async (i: number) => { const at_s = nowS(); const att = await world.present(w, pres, `${v.class} #${i + 1}`); presented.push({ at_s, att }); return att; };
  const n = v.presentations.count;
  if (v.presentations.concurrent) {
    if (v.presentations.restart_between && n > 1) { await once(0); world.restart(w); await Promise.all(Array.from({ length: n - 1 }, (_, i) => once(i + 1))); }
    else await Promise.all(Array.from({ length: n }, (_, i) => once(i)));
  } else {
    for (let i = 0; i < n; i++) { if (i > 0 && v.presentations.restart_between) world.restart(w); await once(i); }
  }

  const firstSettled = presented.find((p) => p.att.status === 'SETTLED')?.att.tx_hash ?? null;
  const tx = (r: TxRef): string | null =>
    typeof r === 'object' ? r.literal
      : r === 'settled' ? firstSettled : r === 'settled_upper' ? (firstSettled ? `0x${firstSettled.slice(2).toUpperCase()}` : null)
        : r === 'funding' ? w.fundingTx : r === 'random' ? `0x${randomBytes(32).toString('hex')}` : `0x${'00'.repeat(32)}`;
  const claims = [];
  for (const c of v.claims) {
    const h = tx(c);
    if (!h) continue;
    const att = await world.claimSettlement(w, npa, h, `claim ${typeof c === 'object' ? 'literal' : c}`);
    claims.push({ tx_hash: h, status: att.status, npa_hash: npaHash });
  }
  const ids = { buyer: w.agents.buyer.id, seller: w.agents.seller.id, attacker: randomUUID() };
  const feedback = [];
  for (const f of v.feedback) {
    const cite = tx(f.cite);
    const r = cite ? await world.awardRepid(w, { raterAgentId: ids[f.rater], providerAgentId: ids[f.provider], citedTx: cite, accepted: true }) : { applied: false, reason: 'no such tx', provider_delta: 0, buyer_delta: 0 };
    feedback.push({ rater: f.rater, provider: f.provider, cite, applied: r.applied, provider_delta: r.provider_delta, buyer_delta: r.buyer_delta, reason: r.reason });
  }

  const after = await snap();
  const rb = async (h: string) => world.serializeReadback(await chain.readback(h));
  const sends = await Promise.all(w.sends.map(async (s: any) => ({ hash: s.hash, ...(await rb(s.hash)) })));
  const presentations: VPresentation[] = presented.map(({ at_s, att }) => ({ at_s, operation, npa, npa_hash: npaHash, sig_valid, request, status: att.status, tx_hash: att.tx_hash, readback: att.readback }));
  const observed: VObserved = {
    policy: {
      chain_id: w.policy.chain_id, connected_chain_id: await chain.chainId(), operations: w.policy.operations, buyer: w.policy.wallets.buyer, counterparties: w.policy.counterparties,
      assets: w.policy.assets.map((a: any) => ({ symbol: a.symbol, contract: a.contract === 'native' ? zero : a.contract, decimals: a.decimals })),
      per_tx_max_raw: w.policy.per_tx_max_raw, aggregate_max_raw: w.policy.aggregate_max_raw, max_tx_count: w.policy.max_tx_count, max_fee_wei: w.policy.max_fee_wei,
    },
    zero_address: zero, attacker: w.addr.attacker, decoy: w.addr.decoy,
    presentations, claims, feedback, before, after,
    allowance_buyer_to_attacker_after: (await chain.allowance(w.addr.usdc, w.addr.buyer, w.addr.attacker)).toString(),
    buyer_nonce_before: nonceBefore, buyer_nonce_after: await chain.txCount(w.addr.buyer), sends,
    provider_repid_delta: (await repidOf(w.agents.seller.id)) - provider0,
    buyer_repid_delta: (await repidOf(w.agents.buyer.id)) - buyer0,
  };
  const g = gradeVariant(observed);
  return {
    class: v.class, label: v.label, verdict: g.verdict, breaches: g.breaches, notes: g.notes, variant: v, npa_hash: npaHash,
    observations: {
      attempts: presented.map(({ att }) => ({ status: att.status, refusals: att.refusals, kernel: att.kernel, tx_hash: att.tx_hash })),
      claims, feedback: feedback.map(({ reason, ...f }) => ({ ...f, reason })), sends: sends.length, provider_repid_delta: observed.provider_repid_delta,
      balances: { before, after },
    },
  };
}

main().catch((e) => { console.error(`run-variants crashed: ${String((e as Error).message).slice(0, 200)}`); process.exit(2); });
