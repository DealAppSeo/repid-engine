/**
 * owner-budget-testnet — one live run of the SHARED OWNER BUDGET on Base Sepolia, with receipts.
 *
 * WHAT IT PROVES. One owner wallet W stakes S USDC and TWO agents share it as ONE budget of S:
 *   agent1 spends 0.6S                          -> sent (tx on Basescan)
 *   agent2 spends 0.6S                          -> 409 over_owner_budget, nothing signed
 *   agent1 and agent2 each ask 0.3S AT ONCE      -> exactly 1 sent, 1 refused (only 0.4S was left)
 *   dry run                                      -> 0.1S remaining
 *
 * SPEND_SOURCE (this script's env, default stake) is what the ENGINE's AGENT_SPEND_SOURCE must be;
 * the run stops before any USDC moves if the engine says otherwise.
 *   stake   the escrow pays the payee out of the stake (Sean's option B, 2026-11-15). No approvals,
 *           no agent gas: 1 owner tx (the stake). Also proves the owner's wallet is NOT debited by
 *           any spend: what is spent is what left the escrow, so a spend costs the owner once.
 *   wallet  each agent pulls from the owner's wallet under an approval of S (steps 5, 6), so the two
 *           on-chain caps sum to 2S and only the shared budget holds them to S.
 *
 * ENGINE ENV IT NEEDS (names only):
 *   OWNER_BUDGET_MODE=enforce          src/services/owner-budget.ts:30
 *   AGENT_SPEND_ENABLED=true           src/routes/agent-spend.ts:93
 *   REAL_STAKING_ENABLED=true          src/config.ts:61 (else a deposit is recorded as simulated)
 *   STAKE_ESCROW_ADDRESS               src/config.ts:65 (must equal this script's STAKE_ESCROW_ADDRESS)
 *   SELF_SERVE_ACCOUNTS_ENABLED=true   src/routes/v1/byok.ts:166 (POST /account/connect)
 *   HUMAN_AGENT_BIND_ENABLED=true      src/services/human-agent-binding.ts:52 (POST /human/bind)
 *   AGENT_KEY_MASTER                   src/services/agent-key-crypto.ts:98 (custodied agent wallets; wallet mode)
 *   AGENT_SPEND_SOURCE=stake           src/services/agent-spend.ts (stake mode; plus STAKE_ESCROW_SIGNER_KEY)
 *   optional: STAKE_MIN_CONFIRMATIONS (default 1), BASE_SEPOLIA_RPC_URL
 * DATABASE: supabase/migrations/20261114200000_owner_spend_ledger.sql must be applied (owner_spend_ledger,
 * owner_funded_stake, reserve_owner_spend). Without it every budget read answers 503 owner_budget_not_checked.
 *
 * ORDER. Approvals and gas (steps 5, 6) run BEFORE the stake (step 4). The only engine read of the
 * shared budget is a spend dry run, and it answers only once an agent has a cap and gas
 * (src/routes/agent-spend.ts:147-157 runs before :181-195). Reading the budget first is what lets a
 * wrong OWNER_BUDGET_MODE or a missing migration stop the run BEFORE any USDC moves to escrow.
 *
 * RE-RUNS. Account connect is idempotent in the engine (byok.ts:195-198). Agents are NOT reusable:
 * the engine shows an agent's key once (agents-external.ts:323) and re-issuing one needs an admin key
 * (src/routes/key-management.ts:66), so each --execute registers two new agents named
 * <AGENT_PREFIX>-<utc time>-1/-2 and binds them. A stake from an earlier run is reused when the
 * budget left is exactly S; any other non-zero remainder stops the run (use a fresh owner wallet).
 *
 * CONCURRENCY. The race is one request per agent, so the two transfers that could go out are signed
 * by two different keys. A burst of several requests per agent would also test the engine's nonce
 * handling for one key, which is a different question from the shared budget.
 *
 * RUN (PowerShell 5.1, from the repository root). The first line reads the key without echoing it or
 * putting it in history. The script never prints, logs or writes it.
 *   $env:OWNER_PRIVATE_KEY = [Runtime.InteropServices.Marshal]::PtrToStringAuto([Runtime.InteropServices.Marshal]::SecureStringToBSTR((Read-Host -AsSecureString "Owner wallet key")))
 *   $env:STAKE_ESCROW_ADDRESS = "0x<escrowAddress from GET /api/v1/stake/escrow/health>"
 *   $env:PAYEE_ADDRESS = "0x<a wallet you control, not the owner>"
 *   $env:STAKE_USDC = "2"
 *   npx ts-node scripts/e2e/owner-budget-testnet.ts --plan --out E:\dev\reports\2026-11-15\owner-budget-e2e.json
 *   npx ts-node scripts/e2e/owner-budget-testnet.ts --execute --out E:\dev\reports\2026-11-15\owner-budget-e2e-execute.json
 * Optional: $env:GAS_TOPUP_ETH (default "0.0005", max 0.002), $env:AGENT_PREFIX (default "e2e-budget"),
 * $env:ENGINE_URL (default the production engine), $env:RPC_URL (default https://sepolia.base.org).
 *
 * --plan (the default) only READS: chain id, W's balances, engine /health, escrow config, bind flag.
 * It sends nothing and calls no write endpoint. Only --execute sends.
 */
import { ethers } from 'ethers';
import { mkdirSync, writeFileSync } from 'fs';
import { dirname } from 'path';

const CHAIN_ID = 84532n;
const USDC = '0x036CbD53842c5426634e7929541eC2318f3dCF7e'; // src/services/agent-spend.ts:23
const BASESCAN = 'https://sepolia.basescan.org/tx/'; //          src/services/agent-spend.ts:25
const MAX_STAKE = ethers.parseUnits('5', 6);
const MAX_TOPUP = ethers.parseEther('0.002');
const STAKE_CONFIRMS = 3;
const ERC20 = [
  'function balanceOf(address) view returns (uint256)',
  'function allowance(address owner, address spender) view returns (uint256)',
  'function decimals() view returns (uint8)',
  'function approve(address spender, uint256 value) returns (bool)',
  'function transfer(address to, uint256 value) returns (bool)',
  'event Transfer(address indexed from, address indexed to, uint256 value)',
];
const erc20 = new ethers.Interface(ERC20);

const HELP = `owner-budget-testnet: drive the shared owner budget end to end on Base Sepolia.

  npx ts-node scripts/e2e/owner-budget-testnet.ts [--plan | --execute] --out <file.json>

  --plan      (default) read-only checks and the steps it would take. Sends nothing.
  --execute   run it: stake mode 1 owner tx + 2 escrow-paid spends; wallet mode 5 owner txs + 2 agent spends, at most.
  --out       required. Where the JSON record goes.

Env: OWNER_PRIVATE_KEY, STAKE_ESCROW_ADDRESS, PAYEE_ADDRESS (required);
     SPEND_SOURCE (stake (default) or wallet: what the engine must be running),
     STAKE_USDC (default 2, max 5), GAS_TOPUP_ETH (default 0.0005, max 0.002, wallet mode),
     AGENT_PREFIX (default e2e-budget), ENGINE_URL, RPC_URL.
See the header of this file for the engine env it needs.`;

// ── record, logging, stopping ──────────────────────────────────────────────────

const record: Record<string, any> = { script: 'scripts/e2e/owner-budget-testnet.ts', started_at: new Date().toISOString(), steps: [], txs: [], refusals: [] };
const SECRET_FIELD = /api_?key|private|secret/i;
const redact = (v: unknown): unknown =>
  Array.isArray(v) ? v.map(redact)
    : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, SECRET_FIELD.test(k) ? '[redacted]' : redact(x)]))
      : typeof v === 'bigint' ? v.toString() : v;

class Stop extends Error {}
function log(step: string, msg: string, data?: unknown): void {
  console.log(`[${step}] ${msg}`);
  record.steps.push({ at: new Date().toISOString(), step, msg, ...(data === undefined ? {} : { data: redact(data) }) });
}
function stop(step: string, msg: string, got?: unknown): never {
  log(step, `STOP: ${msg}`, got);
  if (got !== undefined) console.log(JSON.stringify(redact(got), null, 2));
  throw new Stop(`${step}: ${msg}`);
}
function txLink(label: string, hash: string): void {
  console.log(`  tx  ${label}: ${BASESCAN}${hash}`);
  record.txs.push({ label, hash, url: `${BASESCAN}${hash}` });
}
function refusal(label: string, code: unknown): void {
  console.log(`  refused  ${label}: ${String(code)}`);
  record.refusals.push({ label, code });
}
const short = (e: unknown) => (e instanceof Error ? (e.message.split('\n')[0] ?? '').slice(0, 300) : String(e));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const usdc = (v: bigint) => ethers.formatUnits(v, 6);
const micro = (s: unknown): bigint | null => {
  try { return typeof s === 'string' ? ethers.parseUnits(s, 6) : null; } catch { return null; }
};

// ── config ─────────────────────────────────────────────────────────────────────

const argv = process.argv.slice(2);
const env = (k: string, d = '') => (process.env[k] ?? d).trim();
const ENGINE = env('ENGINE_URL', 'https://repid-engine-production.up.railway.app').replace(/\/+$/, '');
const RPC = env('RPC_URL', 'https://sepolia.base.org');

interface Resp { status: number; body: any }
async function http(method: 'GET' | 'POST', path: string, opts: { body?: unknown; headers?: Record<string, string> } = {}): Promise<Resp> {
  const res = await fetch(ENGINE + path, {
    method,
    headers: { ...(opts.body === undefined ? {} : { 'content-type': 'application/json' }), ...(opts.headers ?? {}) },
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
    signal: AbortSignal.timeout(180_000),
  });
  const text = await res.text();
  let body: any;
  try { body = JSON.parse(text); } catch { body = { non_json: text.slice(0, 500) }; }
  return { status: res.status, body };
}

interface Agent { name: string; id: string; key: string; wallet: string }

async function run(execute: boolean): Promise<void> {
  const provider = new ethers.JsonRpcProvider(RPC);
  // ── inputs, all refused before anything is read or sent ──
  const ownerKey = env('OWNER_PRIVATE_KEY');
  if (!ownerKey) stop('config', 'OWNER_PRIVATE_KEY is not set.');
  let owner: ethers.Wallet;
  try { owner = new ethers.Wallet(ownerKey, provider); } catch { stop('config', 'OWNER_PRIVATE_KEY is not a valid private key.'); }
  const W = owner.address;
  const address = (k: string): string => {
    const v = env(k);
    if (!ethers.isAddress(v)) stop('config', `${k} must be a 0x address (got ${v ? 'something else' : 'nothing'}).`);
    return ethers.getAddress(v);
  };
  const escrow = address('STAKE_ESCROW_ADDRESS');
  const payee = address('PAYEE_ADDRESS');
  if (payee === W || payee === escrow || escrow === W) stop('config', 'owner, payee and escrow must be three different wallets.');
  const sRaw = env('STAKE_USDC', '2');
  const s = /^\d+(\.\d{1,6})?$/.test(sRaw) ? ethers.parseUnits(sRaw, 6) : -1n;
  // >= 0.01 also keeps the amount clear of v1.ts:535, which rewrites an amount of exactly "100".
  if (s < 10_000n || s > MAX_STAKE || s % 10n !== 0n) stop('config', `STAKE_USDC must be 0.01 to 5 with 0.6S, 0.3S and 0.1S exact in micro-USDC (got "${sRaw}").`);
  const tRaw = env('GAS_TOPUP_ETH', '0.0005');
  const topup = /^\d+(\.\d{1,18})?$/.test(tRaw) ? ethers.parseEther(tRaw) : -1n;
  if (topup <= 0n || topup > MAX_TOPUP) stop('config', `GAS_TOPUP_ETH must be > 0 and <= 0.002 (got "${tRaw}").`);
  const prefix = env('AGENT_PREFIX', 'e2e-budget');
  // index.ts:402-410 rejects any POST string with '--' or ';', so the name must avoid both.
  if (!/^[A-Za-z0-9][A-Za-z0-9-]{0,39}$/.test(prefix) || prefix.includes('--')) stop('config', 'AGENT_PREFIX: letters, digits and single dashes, max 40.');
  const source = env('SPEND_SOURCE', 'stake').toLowerCase();
  if (source !== 'stake' && source !== 'wallet') stop('config', `SPEND_SOURCE must be stake or wallet (got "${source}").`);
  const fromStake = source === 'stake';
  record.spend_source_expected = source;
  const a1 = (s * 6n) / 10n;      // 0.6S
  const slice = (s * 3n) / 10n;   // 0.3S: two of these (0.6S) race for the 0.4S left
  const left = s / 10n;           // 0.1S
  Object.assign(record, { owner: W, payee, escrow, engine: ENGINE, rpc: RPC, stake_usdc: usdc(s), gas_topup_eth: ethers.formatEther(topup), agent_prefix: prefix });

  // ── read-only preflight (both modes) ──
  const problems: string[] = [];
  const chainHex = await provider.send('eth_chainId', []);
  if (BigInt(chainHex) !== CHAIN_ID) stop('preflight', `RPC ${RPC} reports chain ${BigInt(chainHex)}, not Base Sepolia (84532). Nothing was sent.`);
  const usdcR = new ethers.Contract(USDC, ERC20, provider);
  if ((await usdcR.getFunction('decimals')()) !== 6n) stop('preflight', `${USDC} does not report 6 decimals on this RPC.`);
  const [wEth, wUsdc, fee] = await Promise.all([provider.getBalance(W), usdcR.getFunction('balanceOf')(W) as Promise<bigint>, provider.getFeeData()]);
  const price = fee.maxFeePerGas ?? fee.gasPrice ?? 0n;
  // wallet: 2 top-ups + 5 owner txs at 100k gas, 2x headroom. stake: 1 owner tx (the stake), 2x2 headroom.
  const ethNeed = fromStake ? 2n * 100_000n * price * 2n : 2n * topup + 5n * 100_000n * price * 2n;
  // wallet: stake + 7a + the balance 7b's checks read (agent-spend.ts services:89). stake: the stake only,
  // because the escrow pays every spend out of it.
  const usdcFresh = fromStake ? s : s + 2n * a1;
  const usdcReuse = fromStake ? 0n : 2n * a1;
  log('preflight', `chain 84532; owner ${W}: ${ethers.formatEther(wEth)} ETH, ${usdc(wUsdc)} USDC`, {
    eth: ethers.formatEther(wEth), usdc: usdc(wUsdc), eth_needed: ethers.formatEther(ethNeed),
    usdc_needed_fresh: usdc(usdcFresh), usdc_needed_if_stake_already_credited: usdc(usdcReuse),
  });
  if (wEth < ethNeed) problems.push(`owner needs about ${ethers.formatEther(ethNeed)} Base Sepolia ETH, holds ${ethers.formatEther(wEth)}`);
  if (wUsdc < usdcReuse) problems.push(`owner needs ${usdc(usdcFresh)} USDC (${usdc(usdcReuse)} if an earlier stake is reused), holds ${usdc(wUsdc)}`);
  else if (wUsdc < usdcFresh) log('preflight', `WARN: ${usdc(wUsdc)} USDC covers only a run that reuses an earlier stake; a fresh stake needs ${usdc(usdcFresh)}.`);

  // src/routes/health.ts:25 (GET /health, public per auth.ts:26), deployed_commit at health.ts:84
  const health = await http('GET', '/health');
  record.engine_deployed_commit_at_start = health.body?.deployed_commit ?? null;
  log('preflight', `engine /health ${health.status}, deployed_commit ${record.engine_deployed_commit_at_start}`);
  if (health.status !== 200) problems.push(`engine /health answered ${health.status}`);
  // src/routes/v1.ts:627 (public per auth.ts:185) -> EscrowHealth, src/services/escrow-refunder.ts:134-147
  const eh = await http('GET', '/api/v1/stake/escrow/health');
  log('preflight', `engine escrow ${eh.body?.escrowAddress ?? 'none'}, realStakingEnabled ${eh.body?.realStakingEnabled}`);
  if (eh.status !== 200) problems.push(`escrow health answered ${eh.status}`);
  else {
    if (!eh.body?.escrowAddress || !ethers.isAddress(eh.body.escrowAddress) || ethers.getAddress(eh.body.escrowAddress) !== escrow) {
      problems.push(`engine STAKE_ESCROW_ADDRESS is ${eh.body?.escrowAddress ?? 'unset'}, not ${escrow}: a deposit there would never be credited`);
    }
    if (eh.body?.realStakingEnabled !== true) problems.push('REAL_STAKING_ENABLED is not true on the engine: the deposit would be recorded as simulated and its tx hash burned (stake-vault.ts:94-102, 161-171)');
    // stake mode: the escrow itself pays, so it must be able to sign and hold gas.
    if (fromStake && eh.body?.ready !== true) problems.push(`the escrow cannot pay yet (signer ${eh.body?.signerMatchesAddress}, ETH ${eh.body?.balances?.eth ?? 'unread'}): ${(eh.body?.notes ?? []).join(' ')}`);
  }
  // src/routes/v1/byok.ts:434-564, public and read-only; bind_enabled is in every answer
  const pf = await http('GET', `/api/v1/human/bind/preflight?agent_id=${encodeURIComponent(prefix)}`);
  log('preflight', `bind_enabled ${pf.body?.bind_enabled}`);
  if (pf.body?.bind_enabled !== true) problems.push('HUMAN_AGENT_BIND_ENABLED is not true on the engine (or the preflight read failed)');
  record.not_checked_read_only = ['SELF_SERVE_ACCOUNTS_ENABLED', 'AGENT_SPEND_ENABLED', 'OWNER_BUDGET_MODE', fromStake ? 'AGENT_SPEND_SOURCE' : 'AGENT_KEY_MASTER', 'migration 20261114200000_owner_spend_ledger.sql'];
  log('preflight', `NOT CHECKED here (no read-only probe): ${record.not_checked_read_only.join(', ')}. --execute checks each before any USDC moves.`);

  const payer = fromStake ? 'the escrow, from the stake' : 'agent wallet, from the owner';
  const steps = [
    `1   POST /api/v1/account/connect (wallet-signed) -> owner's builder account (idempotent)`,
    `2   POST /api/v1/agents/register x2 (${prefix}-<utc>-1, -2) -> agent id and key`,
    `2b  POST /api/v1/agents/<agent1>/spend, unbound -> must refuse not_bound (proves AGENT_SPEND_ENABLED; nothing can send)`,
    `3   GET /api/v1/human/bind/message + POST /api/v1/human/bind, x2 -> both bound to the owner as builder`,
    ...(fromStake ? [] : [
      `5   USDC.approve(agent wallet, ${usdc(s)}) x2            [2 tx, owner] caps sum to ${usdc(2n * s)}`,
      `6   send up to ${ethers.formatEther(topup)} ETH to each agent wallet [up to 2 tx, owner]`,
    ]),
    `R   dry run agent1 ${usdc(a1)} -> engine spends from ${source}; shared budget left must be 0 (stake next) or ${usdc(s)} (reuse)`,
    `4   USDC.transfer(escrow, ${usdc(s)}) + POST /api/v1/stake/deposit [1 tx, owner]`,
    `7a  agent1 spends ${usdc(a1)} -> ok + tx                [1 tx, ${payer}]`,
    `7b  agent2 spends ${usdc(a1)} -> 409 over_owner_budget, no tx (dry run first)`,
    `7c  agent1 and agent2 ask ${usdc(slice)} each AT ONCE, ${usdc(s - a1)} left -> 1 ok + 1 x 409 [1 tx, ${payer}]`,
    `7d  dry run ${usdc(left)} -> remaining ${usdc(left)}`,
    ...(fromStake ? [`8   the owner's wallet USDC is unchanged by both spends (a spend costs the owner once)`] : []),
  ];
  const ownerTxs = fromStake ? 1 : 5;
  record.planned_steps = steps;
  record.onchain_tx_max = { owner_signed: ownerTxs, engine_signed: 2, total: ownerTxs + 2 };
  console.log(`\nSteps:\n  ${steps.join('\n  ')}\nOn-chain transactions: at most ${ownerTxs + 2} (${ownerTxs} signed by the owner, 2 by ${fromStake ? 'the escrow' : 'agent wallets'} through the engine).\n`);
  if (problems.length) stop('preflight', problems.join(' | '));
  if (!execute) { log('plan', 'all read-only checks passed. Nothing was sent. Re-run with --execute.'); return; }

  // ═════════════════════════════ EXECUTE ═════════════════════════════
  const signer = new ethers.NonceManager(owner); // sequential owner txs; a lagging RPC node cannot hand back a stale nonce
  const usdcW = new ethers.Contract(USDC, ERC20, signer);

  // byok.ts:66-74 authMessage; headers byok.ts:86-88; path signed = req.baseUrl + req.path (byok.ts:105),
  // byokRouter is mounted at /api/v1 (src/index.ts:527). Timestamp must be within 5 min (byok.ts:44, 99-103).
  const walletHeaders = async (method: string, path: string) => {
    const ts = new Date().toISOString();
    const msg = ['HyperDAG — authenticated request', `method: ${method}`, `path:   ${path}`, `wallet: ${W.toLowerCase()}`, `time:   ${ts}`].join('\n');
    return { 'x-hd-wallet': W, 'x-hd-timestamp': ts, 'x-hd-signature': await owner.signMessage(msg) };
  };
  const sendTx = async (label: string, p: Promise<ethers.TransactionResponse>, confirms = 1): Promise<string> => {
    let t: ethers.TransactionResponse;
    try { t = await p; } catch (e) { stop(label, `could not send: ${short(e)}`); }
    txLink(label, t.hash);
    let rc: ethers.TransactionReceipt | null = null;
    try { rc = await t.wait(confirms, 180_000); } catch (e) { stop(label, `no good receipt for ${t.hash}: ${short(e)}`); }
    if (!rc || rc.status !== 1) stop(label, `receipt status ${rc?.status ?? 'none'} for ${t.hash}`);
    return t.hash;
  };
  // src/routes/agent-spend.ts:98-100 (POST /api/v1/agents/:id/spend, body {owner_address,to_address,amount_usdc,dry_run}),
  // :109 dry_run must be literally true. Mounted at src/index.ts:817. Auth = the agent's own key in x-api-key
  // (src/middleware/auth.ts:262); the path uuid must be that key's agent (auth.ts:505-510), 'spend' is allowed (auth.ts:527).
  const spend = (a: Agent, amount: bigint, dryRun: boolean) =>
    http('POST', `/api/v1/agents/${a.id}/spend`, {
      headers: { 'x-api-key': a.key },
      body: { owner_address: W, to_address: payee, amount_usdc: usdc(amount), ...(dryRun ? { dry_run: true } : {}) },
    });
  const remainingOf = (r: Resp) => micro(r.body?.owner_budget?.remaining_usdc); // agent-spend.ts:52-55 budgetOut
  const HINT: Record<string, string> = {
    spending_off: 'AGENT_SPEND_ENABLED is not true on the engine (agent-spend.ts:111-117).',
    owner_budget_not_checked: 'the engine could not read the ledger: is migration 20261114200000_owner_spend_ledger.sql applied? (agent-spend.ts:160-164)',
    no_owner_budget: "the agent's owner is not a builder account, so no stake funds it (agent-spend.ts:174-179).",
    not_bound: 'the agent is not bound (agent-spend.ts:133-138).',
    no_gas: 'the agent wallet has too little ETH: raise GAS_TOPUP_ETH (max 0.002).',
    owner_balance: "the owner's USDC balance is below the amount.",
    stake_spend_needs_budget: 'the engine spends from stake but OWNER_BUDGET_MODE is not enforce.',
    escrow_not_configured: 'the engine spends from stake but its escrow signer (STAKE_ESCROW_SIGNER_KEY) is not set.',
    escrow_did_not_send: 'the escrow refused to send (see the error); the budget was released.',
    spend_unconfirmed: 'the escrow broadcast but the outcome is unknown; it keeps counting. Check the tx hash on Basescan.',
    spend_source_invalid: 'AGENT_SPEND_SOURCE on the engine is not wallet or stake.',
  };
  const why = (r: Resp) => `HTTP ${r.status}, code ${r.body?.code ?? r.body?.error ?? 'none'}${HINT[r.body?.code] ? ` - ${HINT[r.body.code]}` : ''}`;
  // Every engine-signed spend is checked on the chain itself, not taken from the engine's word.
  // wallet: the agent's wallet sends transferFrom(owner -> payee). stake: the escrow sends transfer(escrow -> payee).
  const verifySpendTx = async (label: string, hash: string, sender: string, amount: bigint) => {
    const from = fromStake ? escrow : W;
    const rc = await provider.waitForTransaction(hash, 1, 180_000);
    if (!rc || rc.status !== 1) stop(label, `on-chain receipt for ${hash} is not status 1`, { status: rc?.status ?? null });
    if (ethers.getAddress(rc.from) !== sender) stop(label, `${hash} was sent by ${rc.from}, not ${fromStake ? 'the escrow' : 'the agent wallet'} ${sender}`);
    const moved = rc.logs.some((l) => {
      if (ethers.getAddress(l.address) !== ethers.getAddress(USDC)) return false;
      let p: ethers.LogDescription | null;
      try { p = erc20.parseLog({ topics: [...l.topics], data: l.data }); } catch { return false; }
      return p?.name === 'Transfer' && ethers.getAddress(p.args[0]) === from && ethers.getAddress(p.args[1]) === payee && p.args[2] === amount;
    });
    if (!moved) stop(label, `${hash} has no USDC Transfer of ${usdc(amount)} from the ${fromStake ? 'escrow' : 'owner'} to the payee`);
    log(label, `on-chain: status 1, ${usdc(amount)} USDC ${fromStake ? 'escrow' : 'owner'} -> payee, sent by ${fromStake ? 'the escrow' : 'agent wallet'}`);
  };

  // ── 1. account ── byok.ts:188-215: 503 {error:'disabled'} when the flag is off; 200 {created:false, account}
  //    or 201 {created:true, account:{id,address,created_at}}. Limiter 5/h/IP (index.ts:246-252, 523).
  const c = await http('POST', '/api/v1/account/connect', { body: {}, headers: await walletHeaders('POST', '/api/v1/account/connect') });
  if (![200, 201].includes(c.status) || !c.body?.account?.id) {
    stop('1-connect', c.body?.error === 'disabled' ? 'SELF_SERVE_ACCOUNTS_ENABLED is not true on the engine.' : `expected 200/201 with account.id, got ${c.status}`, c.body);
  }
  const builderId = String(c.body.account.id);
  log('1-connect', `${c.body.created ? 'created' : 'reused'} builder account ${builderId}`, c.body);

  // ── 2. two agents ── agents-external.ts:88-111 body (agent_name, description); no wallet_address sent, so
  //    the engine provisions a custodied wallet (:196-208). 201 {agent_id, api_key, wallet_address} (:320-341).
  //    Keyless (auth.ts:210), limiter 5/h/IP (index.ts:191-194, 807), same name+IP in 24h = 429 (:134-142).
  const runTag = new Date().toISOString().replace(/[-:]/g, '').slice(0, 15);
  const agents: Agent[] = [];
  for (const i of [1, 2]) {
    const name = `${prefix}-${runTag}-${i}`;
    const r = await http('POST', '/api/v1/agents/register', { body: { agent_name: name, description: 'owner-budget e2e test agent, Base Sepolia' } });
    if (r.status !== 201 || typeof r.body?.agent_id !== 'string' || typeof r.body?.api_key !== 'string') stop('2-register', `expected 201 with agent_id and api_key, got ${r.status}`, r.body);
    const hasWallet = !!r.body.wallet_address && ethers.isAddress(r.body.wallet_address);
    // Only the wallet path needs the agent's own wallet; from stake, the escrow pays.
    if (!hasWallet && !fromStake) {
      stop('2-register', 'the engine registered the agent but did not provision a custodied wallet (agents-external.ts:204 logs why; AGENT_KEY_MASTER on the engine?).', r.body);
    }
    agents.push({ name, id: r.body.agent_id, key: r.body.api_key, wallet: hasWallet ? ethers.getAddress(r.body.wallet_address) : '' });
    log('2-register', `${name} = ${r.body.agent_id}, wallet ${r.body.wallet_address}`, r.body);
  }
  const [A1, A2] = agents as [Agent, Agent];
  if (agents.some((a) => a.wallet === payee || a.wallet === W)) stop('2-register', 'an agent wallet equals the payee or the owner.');
  record.agents = agents.map(({ name, id, wallet }) => ({ name, id, wallet }));

  // ── 2b. spend switch ── a REAL (not dry) spend by an UNBOUND agent: agent-spend.ts:111-117 refuses
  //     spending_off first when the flag is off; otherwise :133-138 refuses not_bound. Nothing can send.
  const probe = await spend(A1, slice, false);
  if (probe.body?.code !== 'not_bound') stop('2b-spend-switch', `expected 403 not_bound from an unbound agent: ${why(probe)}`, probe.body);
  refusal('2b unbound agent, real spend (proves AGENT_SPEND_ENABLED)', probe.body.code);

  // ── 3. bind ── message: byok.ts:407-414 (human-agent-binding.ts:133-144). POST byok.ts:566-595: wallet-signed
  //    headers + x-agent-key (byok.ts:60, 578) + body {agent_id, signature, scope}; 201 {ok, binding:{owner_kind,
  //    builder_id,...}} (human-agent-binding.ts:259-289). accountOfWallet prefers an SBT (byok.ts:125-136).
  for (const a of agents) {
    const m = await http('GET', `/api/v1/human/bind/message?wallet=${W}&agent_id=${a.id}`);
    const text = m.body?.message;
    if (m.status !== 200 || typeof text !== 'string' || !text.includes(a.id) || !text.includes(W.toLowerCase())) stop('3-bind', 'binding message missing or not naming this agent and wallet', m.body);
    const b = await http('POST', '/api/v1/human/bind', {
      body: { agent_id: a.id, signature: await owner.signMessage(text), scope: 'ownership' },
      headers: { ...(await walletHeaders('POST', '/api/v1/human/bind')), 'x-agent-key': a.key },
    });
    if (b.status !== 201 || b.body?.ok !== true) stop('3-bind', `expected 201 ok, got ${b.status} ${b.body?.reason ?? b.body?.error ?? ''}`, b.body);
    if (b.body.binding?.owner_kind !== 'builder' || String(b.body.binding?.builder_id) !== builderId) {
      stop('3-bind', `bound as ${b.body.binding?.owner_kind} ${b.body.binding?.builder_id ?? b.body.binding?.human_token_id}, not builder ${builderId}. A wallet with a proof-of-human SBT binds as human_sbt and has no builder stake budget: use another wallet.`, b.body);
    }
    log('3-bind', `${a.name} bound to the owner as builder ${builderId}`, b.body);
  }

  // Steps 5 and 6 are the wallet path only: from stake there is no approval and the escrow pays the gas.
  if (!fromStake) {
    // ── 5. approvals ── each agent may move S from the owner: the chain's cap (services/agent-spend.ts:5-9)
    for (const a of agents) {
      const cur = (await usdcR.getFunction('allowance')(W, a.wallet)) as bigint;
      if (cur === s) { log('5-approve', `${a.name} already approved for ${usdc(s)}`); continue; }
      await sendTx(`5 approve ${a.name} for ${usdc(s)} USDC`, usdcW.getFunction('approve')(a.wallet, s));
    }

    // ── 6. gas ── the engine refuses no_gas before signing (services/agent-spend.ts:178-187)
    for (const a of agents) {
      const bal = await provider.getBalance(a.wallet);
      if (bal >= topup) { log('6-gas', `${a.name} already holds ${ethers.formatEther(bal)} ETH`); continue; }
      const value = topup - bal; // <= topup <= 0.002 ETH
      await sendTx(`6 gas ${ethers.formatEther(value)} ETH to ${a.name}`, signer.sendTransaction({ to: a.wallet, value }));
    }
  }

  // ── R. read the shared budget BEFORE staking ── dry run: agent-spend.ts:181-195. In enforce mode an amount
  //    over what is left answers code over_owner_budget (:187-188); off mode carries no owner_budget at all.
  const pre = await spend(A1, a1, true);
  // Which path the engine is on: every stake-path answer carries spend_source 'stake'; a wallet-path
  // refusal carries none. A mismatch stops here, before any USDC moves.
  const engineSource = pre.body?.spend_source === 'stake' ? 'stake' : 'wallet';
  record.spend_source_engine = engineSource;
  if (engineSource !== source) stop('R-budget', `the engine spends from ${engineSource} (AGENT_SPEND_SOURCE), but this run expects ${source} (SPEND_SOURCE). Nothing was sent.`, pre.body);
  if (pre.status !== 200 || !pre.body?.owner_budget) {
    stop('R-budget', pre.status === 200 && pre.body?.ok ? 'the dry run carries no owner_budget: OWNER_BUDGET_MODE is off on the engine.' : `budget read refused: ${why(pre)}`, pre.body);
  }
  if (!fromStake && micro(pre.body.reads?.cap_usdc) !== s) stop('R-budget', `agent1 cap reads ${pre.body.reads?.cap_usdc}, expected ${usdc(s)}`, pre.body);
  const r0 = remainingOf(pre);
  log('R-budget', `shared budget before stake: ${JSON.stringify(pre.body.owner_budget)}`, pre.body);
  if (r0 === 0n) {
    if (pre.body.code !== 'over_owner_budget') stop('R-budget', 'nothing is left yet the engine would send: OWNER_BUDGET_MODE is not enforce.', pre.body);
    refusal('R dry run with an empty budget (proves enforce)', pre.body.code);

    // ── 4. stake ── transfer to escrow, then claim it: GET v1.ts:511-525 (text stake-authorization.ts:96-111),
    //    POST v1.ts:527-570 {builder_address, amount (micro), tx_hash, signature}; wallet-signature path
    //    stake-authorization.ts:198-222; real path stake-vault.ts:86-156 -> {ok, builder_id, verified:true, is_simulated:false}.
    const bal = (await usdcR.getFunction('balanceOf')(W)) as bigint;
    if (bal < usdcFresh) stop('4-stake', `owner holds ${usdc(bal)} USDC, needs ${usdc(usdcFresh)} for the stake and the spends. Nothing was staked.`);
    const hash = await sendTx(`4 stake ${usdc(s)} USDC to escrow`, usdcW.getFunction('transfer')(escrow, s), STAKE_CONFIRMS);
    const dm = await http('GET', `/api/v1/stake/deposit/message?wallet=${W}&amount=${s}&tx_hash=${hash}`);
    if (dm.status !== 200 || typeof dm.body?.message !== 'string' || !dm.body.message.includes(hash.toLowerCase())) stop('4-stake', 'deposit message missing or not naming this tx', dm.body);
    const body = { builder_address: W, amount: s.toString(), tx_hash: hash, signature: await owner.signMessage(dm.body.message) };
    let d: Resp = { status: 0, body: null };
    for (let i = 1; i <= 10; i++) {
      d = await http('POST', '/api/v1/stake/deposit', { body });
      // deposit-verifier.ts:147-171: not yet visible or under STAKE_MIN_CONFIRMATIONS. Nothing was recorded, so retry.
      if (d.status === 400 && /insufficient confirmations|tx not found/.test(String(d.body?.error ?? ''))) { log('4-stake', `engine: ${d.body.error}; retry ${i}/10`); await sleep(6000); continue; }
      break;
    }
    if (d.status !== 200 || d.body?.ok !== true || d.body?.verified !== true || d.body?.is_simulated !== false || String(d.body?.builder_id) !== builderId) {
      stop('4-stake', `expected a verified, non-simulated credit to builder ${builderId}, got ${d.status} ${d.body?.error ?? d.body?.message ?? ''}. The USDC is in escrow at ${hash}.`, d.body);
    }
    log('4-stake', `credited: ${usdc(s)} USDC, verified on-chain, authorized_by ${d.body.authorized_by}`, d.body);
  } else if (r0 === s) {
    log('4-stake', `SKIPPED: ${usdc(s)} USDC of stake from an earlier run is already credited and unspent. No new stake tx.`);
  } else {
    stop('R-budget', `this owner already has ${r0 === null ? 'an unreadable amount' : usdc(r0) + ' USDC'} left of an earlier budget. Step 7 assumes exactly 0 or ${usdc(s)}: use a fresh owner wallet.`, pre.body);
  }

  // stake mode: from here on, no spend may touch the owner's wallet (step 8 compares).
  const ownerUsdcBeforeSpends = (await usdcR.getFunction('balanceOf')(W)) as bigint;
  const post = await spend(A1, a1, true);
  if (post.body?.ok !== true || post.body?.would_send !== true || remainingOf(post) !== s) stop('R-budget', `after the stake expected would_send with ${usdc(s)} left: ${why(post)}`, post.body);
  log('R-budget', `shared budget: ${usdc(s)} USDC left across both agents; their caps sum to ${usdc(2n * s)}`, post.body.owner_budget);

  // ── 7a. agent1 spends 0.6S ── 200 {ok, tx_hash, basescan_url, ...} (agent-spend.ts:247, services/agent-spend.ts:212-222)
  const r7a = await spend(A1, a1, false);
  if (r7a.status !== 200 || r7a.body?.ok !== true || !ethers.isHexString(r7a.body?.tx_hash, 32)) stop('7a', `expected ok + tx_hash: ${why(r7a)}`, r7a.body);
  txLink(`7a agent1 spends ${usdc(a1)} USDC`, r7a.body.tx_hash);
  log('7a', `sent, reservation ${r7a.body.owner_budget_reservation}`, r7a.body);
  await verifySpendTx('7a', r7a.body.tx_hash, fromStake ? escrow : A1.wallet, a1);

  // ── 7b. agent2 spends 0.6S ── dry run first (proves enforce before a real send in the reuse case),
  //     then the real request: 409 code over_owner_budget, no tx (agent-spend.ts:199-208)
  const after7a = s - a1;
  const dry7b = await spend(A2, a1, true);
  if (dry7b.body?.code !== 'over_owner_budget' || remainingOf(dry7b) !== after7a) stop('7b', `dry run expected over_owner_budget with ${usdc(after7a)} left: ${why(dry7b)}`, dry7b.body);
  if (!fromStake && micro(dry7b.body.reads?.cap_usdc) !== s) stop('7b', `agent2 cap reads ${dry7b.body.reads?.cap_usdc}, expected ${usdc(s)}: the chain alone would allow this spend`, dry7b.body);
  refusal(`7b dry run, agent2 ${usdc(a1)} (its own cap is ${usdc(s)})`, dry7b.body.code);
  const r7b = await spend(A2, a1, false);
  if (r7b.status !== 409 || r7b.body?.code !== 'over_owner_budget' || r7b.body?.tx_hash || remainingOf(r7b) !== after7a) stop('7b', `expected 409 over_owner_budget and no tx: ${why(r7b)}`, r7b.body);
  refusal(`7b agent2 spends ${usdc(a1)} (its own cap is ${usdc(s)})`, r7b.body.code);
  log('7b', `refused, nothing signed: ${r7b.body.error}`, r7b.body);

  // ── 7c. concurrent race ── reserve_owner_spend serializes per owner (migration: pg_advisory_xact_lock).
  //     One request per agent: 0.3S + 0.3S asked, 0.4S left, so exactly one may pass.
  const order = [A1, A2];
  const burst = await Promise.all(order.map((a) => spend(a, slice, false)));
  const rows = burst.map((r, i) => ({ agent: order[i]!.name, status: r.status, ok: r.body?.ok === true, code: r.body?.code ?? null, tx_hash: r.body?.tx_hash ?? null, error: r.body?.error ?? null }));
  record.burst = rows;
  const sent = rows.filter((r) => r.status === 200 && r.ok && ethers.isHexString(r.tx_hash, 32));
  const refused = rows.filter((r) => r.status === 409 && r.code === 'over_owner_budget' && !r.tx_hash);
  for (const r of sent) txLink(`7c ${r.agent} spends ${usdc(slice)} USDC (concurrent)`, r.tx_hash);
  for (const r of refused) refusal(`7c ${r.agent} spends ${usdc(slice)} (concurrent)`, r.code);
  if (sent.length !== 1 || refused.length !== 1) {
    stop('7c', `expected exactly 1 sent and 1 x 409 over_owner_budget, got ${sent.length} sent, ${refused.length} refused, ${rows.length - sent.length - refused.length} other.` +
      (sent.length === 2 ? ' BOTH were sent: the shared budget did NOT hold under concurrency. That is the finding this run exists to catch.' : ''), rows);
  }
  for (const r of sent) await verifySpendTx('7c', r.tx_hash, fromStake ? escrow : order[rows.indexOf(r)]!.wallet, slice);
  log('7c', `race: 1 sent, 1 refused over_owner_budget`, rows);

  // ── 7d. what is left ──
  const fin = await spend(A2, left, true);
  if (fin.body?.ok !== true || fin.body?.would_send !== true || remainingOf(fin) !== left) stop('7d', `expected would_send with ${usdc(left)} left: ${why(fin)}`, fin.body);
  log('7d', `dry run: ${usdc(left)} USDC remaining of ${usdc(s)}, across both agents`, fin.body.owner_budget);
  record.final_owner_budget = fin.body.owner_budget;

  // ── 8. the owner paid once ── from stake, the escrow paid both spends; the owner's wallet must not have moved.
  if (fromStake) {
    const ownerUsdcAfter = (await usdcR.getFunction('balanceOf')(W)) as bigint;
    record.owner_usdc = { before_spends: usdc(ownerUsdcBeforeSpends), after_spends: usdc(ownerUsdcAfter) };
    if (ownerUsdcAfter !== ownerUsdcBeforeSpends) stop('8-owner', `the owner's wallet moved from ${usdc(ownerUsdcBeforeSpends)} to ${usdc(ownerUsdcAfter)} USDC during the spends: a spend from stake must not touch it (or another transfer ran at the same time; rerun to tell).`);
    log('8-owner', `owner wallet unchanged at ${usdc(ownerUsdcAfter)} USDC across both spends: the escrow paid, so each spend cost the owner once`);
  }
}

async function main(): Promise<number> {
  if (argv.includes('--help') || argv.includes('-h')) { console.log(HELP); return 0; }
  const known = new Set(['--plan', '--execute', '--out']);
  const unknown = argv.filter((a, i) => a.startsWith('-') && !known.has(a) && argv[i - 1] !== '--out');
  const outIdx = argv.indexOf('--out');
  const out = outIdx >= 0 ? argv[outIdx + 1] : undefined;
  const execute = argv.includes('--execute');
  if (unknown.length || !out || out.startsWith('--') || (execute && argv.includes('--plan'))) {
    console.error(`${unknown.length ? `unknown option ${unknown.join(' ')}\n` : ''}${!out || out.startsWith('--') ? '--out <file.json> is required\n' : ''}${execute && argv.includes('--plan') ? 'pick one of --plan and --execute\n' : ''}\n${HELP}`);
    return 2;
  }
  record.mode = execute ? 'execute' : 'plan';
  try {
    await run(execute);
    record.result = execute ? 'PASS' : 'PLAN_OK';
  } catch (e) {
    record.result = 'STOPPED';
    record.stopped = e instanceof Stop ? e.message : `unexpected error: ${short(e)}`;
    if (!(e instanceof Stop)) console.error(`unexpected error: ${short(e)}`);
  } finally {
    record.finished_at = new Date().toISOString();
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, JSON.stringify(redact(record), null, 2));
  }
  console.log(`\n${record.result}${record.stopped ? `: ${record.stopped}` : ''}\nrecord: ${out}`);
  return record.result === 'STOPPED' ? 1 : 0;
}

main().then((code) => process.exit(code), (e) => { console.error(short(e)); process.exit(1); });
