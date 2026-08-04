/**
 * E2E TRANSACTION RUNNER — legitimately grows TrustShell.dev's live numbers.
 * =========================================================================
 *
 * Runs N real inter-agent buy-loop transactions against the live repid-engine,
 * driving the full contract lifecycle so the marketplace + RepID + settlement
 * numbers move for real (not seeded, not faked):
 *
 *   create  POST /api/v1/contracts                (buyer, non-provider agent)
 *   escrow  POST /api/v1/contracts/:id/escrow     (x402 payment leg)
 *   fulfill POST /api/v1/agent/process-contracts  (provider handler)  [default]
 *        or POST /api/v1/contracts/:id/fulfill    (direct, no PCP gate) [--direct-fulfill]
 *   satisfy POST /api/v1/contracts/:id/satisfy    (buyer rates 0..1 → settled)
 *
 * WHICH KEY DRIVES WHICH CALL — AND WHY THERE IS MORE THAN ONE
 * ============================================================
 * This script used to drive every call with one shared `REPID_API_KEYS` env key.
 * That key authenticates but carries NO agent identity (`authMiddleware` only sets
 * `req.agent_id` for a DB-issued key from `agent_api_keys`), and the contract
 * lifecycle now refuses an unidentified caller on the routes where identity is the
 * whole point:
 *
 *   escrow  → 403 unbound_caller   (must be a PARTY to the contract)
 *   satisfy → 403 unbound_caller   (must be the BUYER — it releases the money)
 *   fulfill → 403 unbound_caller   (must be the PROVIDER — it is the delivery)
 *
 * So the run needs three keys, and they are genuinely three different authorities —
 * collapsing them back into one is the bug, not the convenience:
 *
 *   REPID_API_KEY             OPERATOR (shared env key). Discovery + provider-side
 *                             dispatch: GET /services, GET /agents/minted,
 *                             POST /agent/process-contracts, marketplace reads.
 *                             MUST stay the operator key — /agents/minted and
 *                             process-contracts (which names the PROVIDER in
 *                             `agent_name`) are both REFUSED for a buyer-bound key.
 *   REPID_BUYER_AGENT_KEY     BUYER-bound (agent_api_keys). create, escrow, satisfy.
 *   REPID_PROVIDER_AGENT_KEY  PROVIDER-bound. Only --direct-fulfill needs it.
 *
 * ISSUING A BOUND KEY (one-off, per agent):
 *   POST /api/v1/agents/<agent-uuid>/keys  {"name":"e2e","scopes":[]}
 *     Authorization: Bearer <that agent's registration token, or an existing
 *                            admin-scoped key already bound to that same agent>
 *   → responds { key, key_prefix, ... }; `key` is shown ONCE. A shared operator key
 *     is NOT accepted here — key issuance requires authority over that one agent.
 *   (scripts/e2e/negotiated-zkp-exchange.mjs mints its keys the other way, by
 *   inserting into agent_api_keys with service-role creds. This script deliberately
 *   holds no DB creds, so it takes the issued key from env instead.)
 *
 * TWO MODES — HONEST BY CONSTRUCTION:
 *
 *   default (SIMULATED)  — escrow runs WITHOUT X402_REAL_RPC on the server, so
 *     the settlement row is is_simulated=true and RepID deltas are ZEROED
 *     (validation-repid-delta.ts). This proves the loop end-to-end (contract
 *     moves pending→escrowed→fulfilled→settled) but earns 0 RepID and writes
 *     NOTHING on-chain. It is labeled as simulated everywhere. Use it to
 *     exercise plumbing without spending test-USDC.
 *
 *   --real  — builds a signed EIP-3009 X-PAYMENT header client-side (a funded
 *     Base-Sepolia wallet key you supply) so the server's facilitator verifies
 *     + settles a REAL USDC transfer. This is the ONLY mode that grows RepID and
 *     can trigger an on-chain ERC-8004 reputation write. It REQUIRES the server
 *     to have X402_REAL_RPC=true AND X402_ENFORCEMENT_ENABLED=true set — those
 *     are Sean's Railway flips; this script cannot set them. If your local env is
 *     missing anything --real needs, the script EXITS CLEANLY explaining exactly
 *     what is missing. It NEVER fakes a settlement.
 *
 * ON-CHAIN REPUTATION WRITES: a real settled contract only produces an ERC-8004
 * reputation write when the PROVIDER agent has current_repid >= 1000 AND an
 * erc8004_token_id, and the server's ERC8004_REPUTATION_WRITER_KEY resolves
 * (Sean's funded attestor). The FeedbackLoopWorker fires it ~60s after settle.
 * This script does not and cannot flip that — it reports whether the loop it ran
 * is eligible, honestly.
 *
 * CONFIG (env + flags):
 *   --count=N            number of buy-loops to run (default 1)
 *   --real               real x402 settlement (needs the --real env below)
 *   --direct-fulfill     use POST /:id/fulfill (skips the PCP verification gate)
 *   --buyer=<name|uuid>  buyer agent (default trinity-nexus; must NOT be a provider)
 *   --service-type=<t>   seeded service type to buy (default verification)
 *   --base=<url>         engine base URL (default $ENGINE_BASE_URL or the prod URL)
 *   --satisfaction=<0..1> buyer satisfaction score at satisfy (default 1)
 *
 *   ENV always needed:
 *     REPID_API_KEY            operator key (a REPID_API_KEYS entry, key part only)
 *     REPID_BUYER_AGENT_KEY    agent-bound key for --buyer (see "issuing" above)
 *
 *   ENV needed only for --direct-fulfill:
 *     REPID_PROVIDER_AGENT_KEY agent-bound key for the SERVICE'S PROVIDER agent
 *
 *   ENV additionally needed for --real:
 *     X402_BUYER_PRIVATE_KEY   funded Base-Sepolia wallet key that PAYS (>= price in test-USDC)
 *     X402_REAL_RPC            informational note only — must ALSO be set on the SERVER
 *     (BASE_SEPOLIA_RPC_URL    optional; only to pin an RPC for nonce/domain reads)
 *
 * This is a driver/harness script (like scripts/production-smoke.ts,
 * scripts/test-economic-flow.ts). It performs NO DB writes of its own and holds
 * NO secrets in code — the paying key comes from env at runtime.
 *
 * Run:  npx tsx scripts/demo/run-e2e-transactions.ts --count=1
 *       npx tsx scripts/demo/run-e2e-transactions.ts --count=3 --real
 */

import { ethers } from 'ethers';
import { randomBytes } from 'crypto';

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const DEFAULT_BASE = process.env.ENGINE_BASE_URL || 'https://repid-engine-production.up.railway.app';
const BASE_SEPOLIA_USDC = '0x036cbd53842c5426634e7929541ec2318f3dcf7e';
const BASE_SEPOLIA_CHAIN_ID = 84532;

interface Flags {
  count: number;
  real: boolean;
  directFulfill: boolean;
  buyer: string;
  serviceType: string;
  base: string;
  satisfaction: number;
  providerWallet?: string;
}

function parseFlags(argv: string[]): Flags {
  const get = (name: string): string | undefined => {
    const pref = `--${name}=`;
    const hit = argv.find((a) => a.startsWith(pref));
    return hit ? hit.slice(pref.length) : undefined;
  };
  const has = (name: string): boolean => argv.includes(`--${name}`);
  const countRaw = Number(get('count') ?? '1');
  const satRaw = Number(get('satisfaction') ?? '1');
  return {
    count: Number.isFinite(countRaw) && countRaw > 0 ? Math.floor(countRaw) : 1,
    real: has('real'),
    directFulfill: has('direct-fulfill'),
    buyer: get('buyer') ?? 'trinity-nexus',
    serviceType: get('service-type') ?? 'verification',
    base: (get('base') ?? DEFAULT_BASE).replace(/\/+$/, ''),
    satisfaction: Number.isFinite(satRaw) ? Math.min(Math.max(satRaw, 0), 1) : 1,
    // The public surface doesn't expose provider wallet_address; an operator
    // who has read it from the DB can supply it directly for --real payTo.
    providerWallet: get('provider-wallet') ?? process.env.X402_PROVIDER_WALLET,
  };
}

// ---------------------------------------------------------------------------
// Small HTTP helper (no auth secrets logged)
// ---------------------------------------------------------------------------

async function api(
  base: string,
  method: string,
  path: string,
  apiKey: string,
  body?: unknown,
  extraHeaders?: Record<string, string>,
): Promise<{ status: number; json: any }> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${apiKey}`,
    ...(extraHeaders ?? {}),
  };
  const res = await fetch(`${base}${path}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  let json: any = null;
  try {
    json = await res.json();
  } catch {
    json = null;
  }
  return { status: res.status, json };
}

// ---------------------------------------------------------------------------
// EIP-3009 X-PAYMENT header builder (real mode only)
// ---------------------------------------------------------------------------
//
// Signs a USDC TransferWithAuthorization (EIP-712) and returns the base64 header
// the engine's facilitator parses: { from, to, value, validAfter, validBefore,
// nonce, signature }. Mirrors the trustshell SDK's buildX402Payment shape (per
// the Brick-3 runbook §3) — a fresh random nonce each call (replay protection).

async function buildX402Payment(opts: {
  privateKey: string;
  to: string;
  value: string; // base units (6-dec USDC)
  asset?: string;
  chainId?: number;
  tokenName?: string;
  tokenVersion?: string;
}): Promise<string> {
  const asset = opts.asset ?? BASE_SEPOLIA_USDC;
  const chainId = opts.chainId ?? BASE_SEPOLIA_CHAIN_ID;
  const tokenName = opts.tokenName ?? 'USDC';
  const tokenVersion = opts.tokenVersion ?? '2';

  const wallet = new ethers.Wallet(opts.privateKey);
  const from = await wallet.getAddress();

  const now = Math.floor(Date.now() / 1000);
  const validAfter = 0;
  const validBefore = now + 3600; // 1h window
  const nonce = '0x' + randomBytes(32).toString('hex');

  const domain = {
    name: tokenName,
    version: tokenVersion,
    chainId,
    verifyingContract: asset,
  };
  const types = {
    TransferWithAuthorization: [
      { name: 'from', type: 'address' },
      { name: 'to', type: 'address' },
      { name: 'value', type: 'uint256' },
      { name: 'validAfter', type: 'uint256' },
      { name: 'validBefore', type: 'uint256' },
      { name: 'nonce', type: 'bytes32' },
    ],
  };
  const message = { from, to: opts.to, value: opts.value, validAfter, validBefore, nonce };

  const signature = await wallet.signTypedData(domain, types, message);

  const payload = { from, to: opts.to, value: opts.value, validAfter, validBefore, nonce, signature };
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64');
}

// ---------------------------------------------------------------------------
// Preflight
// ---------------------------------------------------------------------------

interface Preflight {
  /** OPERATOR key (shared REPID_API_KEYS entry). Carries no agent identity. */
  apiKey: string;
  /** BUYER-bound agent key. Required — escrow and satisfy refuse anything else. */
  buyerApiKey: string;
  /** PROVIDER-bound agent key. Only --direct-fulfill needs one. */
  providerApiKey?: string;
  buyerId: string;
  buyerName: string;
  serviceId: string;
  providerName: string;
  providerWallet: string | null;
  priceRaw: string;
  /**
   * NOTE: an ETHEREUM private key that signs the EIP-3009 payment — NOT an API key.
   * Distinct from `buyerApiKey` above despite the similar name.
   */
  buyerKey?: string; // real mode only
}

/** Read-only lookups via the engine's own public endpoints — no DB creds needed. */
async function preflight(flags: Flags): Promise<Preflight> {
  const apiKey = process.env.REPID_API_KEY ?? '';
  if (!apiKey) {
    throw new CleanExit(
      'Missing REPID_API_KEY. This is the OPERATOR key (an entry in the server\'s ' +
        'REPID_API_KEYS, key part only). It drives discovery and the provider-side ' +
        'dispatch (/agent/process-contracts). Set it and re-run.',
    );
  }

  // The buyer-bound key is validated here, before any network call, so a run that
  // cannot possibly complete says so immediately instead of failing three steps in
  // with a 403 that reads like a server fault.
  const buyerApiKey = process.env.REPID_BUYER_AGENT_KEY ?? '';
  if (!buyerApiKey) {
    throw new CleanExit(
      'Missing REPID_BUYER_AGENT_KEY — an AGENT-BOUND key for the buyer.\n\n' +
        'The operator key in REPID_API_KEY authenticates but carries no agent identity, and\n' +
        '/escrow and /satisfy both refuse an unidentified caller (403 unbound_caller): escrow\n' +
        'must come from a PARTY to the contract, and satisfy releases the payment so it must\n' +
        'come from the BUYER. This is not a config nuisance — a shared key that could escrow\n' +
        "and settle anyone's contract is the hole those checks exist to close.\n\n" +
        'Issue one for the buyer agent (shown once):\n' +
        '  curl -X POST "$ENGINE_BASE_URL/api/v1/agents/<buyer-agent-uuid>/keys" \\\n' +
        '       -H "Authorization: Bearer <buyer registration token or its admin-scoped key>" \\\n' +
        '       -H "Content-Type: application/json" -d \'{"name":"e2e-buyer"}\'\n\n' +
        'It must be bound to the SAME agent as --buyer (default trinity-nexus), or the very\n' +
        'first contract create will 403 with an agent identity mismatch.',
    );
  }

  // Only --direct-fulfill posts to /:id/fulfill, which requires the PROVIDER. The
  // default path dispatches through /agent/process-contracts on the operator key,
  // so most runs need no provider key at all.
  let providerApiKey: string | undefined;
  if (flags.directFulfill) {
    providerApiKey = process.env.REPID_PROVIDER_AGENT_KEY ?? '';
    if (!providerApiKey) {
      throw new CleanExit(
        '--direct-fulfill is missing REPID_PROVIDER_AGENT_KEY — an AGENT-BOUND key for the\n' +
          "SERVICE'S PROVIDER agent.\n\n" +
          'POST /:id/fulfill is the delivery step, so it requires a caller bound to the provider\n' +
          '(403 not_the_provider otherwise). Neither the operator key nor the buyer key can stand\n' +
          'in for it. Issue one against the provider agent exactly as for the buyer key above.\n\n' +
          'Or drop --direct-fulfill: the default path delivers through the provider handler at\n' +
          'POST /agent/process-contracts, which runs the PCP/HAL verdict gate that --direct-fulfill\n' +
          'skips, and needs no provider key.',
      );
    }
  }

  // Validate --real client env BEFORE any network calls, so a missing signing key
  // is reported cleanly even if the engine is unreachable (honesty: a run missing
  // env for its mode exits cleanly explaining what's needed, never faking).
  let buyerKey: string | undefined;
  if (flags.real) {
    buyerKey = process.env.X402_BUYER_PRIVATE_KEY ?? '';
    if (!buyerKey) {
      throw new CleanExit(
        '--real mode is missing required client env:\n' +
          '  - X402_BUYER_PRIVATE_KEY (funded Base-Sepolia wallet key that pays; >= the service price in test-USDC)\n\n' +
          'Also confirm the SERVER has X402_REAL_RPC=true and X402_ENFORCEMENT_ENABLED=true (Sean\'s Railway ' +
          'flips). Without a signed payment header from a funded wallet AND the server flags, no real ' +
          'settlement can occur. Re-run without --real for a labeled simulated loop.',
      );
    }
    if (!process.env.X402_REAL_RPC) {
      console.warn(
        '[e2e][warn] X402_REAL_RPC is not set in THIS process env. That flag must be set ON THE SERVER ' +
          '(repid-engine Railway) for escrow to settle for real; it has no effect client-side. If the server ' +
          'does not have X402_REAL_RPC=true AND X402_ENFORCEMENT_ENABLED=true, --real escrow will 402 or fall ' +
          'back to a simulated/legacy path — the run reports that honestly.',
      );
    }
  }

  // Resolve a seeded active service of the requested type + its provider.
  // /api/v1/services is authed but we already have a key; use it read-only.
  const svcRes = await api(flags.base, 'GET', `/api/v1/services?service_type=${encodeURIComponent(flags.serviceType)}&active=true`, apiKey);
  let service: any = null;
  if (svcRes.status === 200) {
    const list = Array.isArray(svcRes.json) ? svcRes.json : svcRes.json?.data ?? svcRes.json?.services ?? [];
    service = (list as any[]).find((s) => s.active !== false) ?? list[0] ?? null;
  }
  if (!service) {
    throw new CleanExit(
      `No active seeded service of type "${flags.serviceType}" found via GET /api/v1/services ` +
        `(status ${svcRes.status}). Seed one or pass --service-type=<t> for a type that exists ` +
        `(verification | anfis_routing | reputation_audit are the seeded showcase set).`,
    );
  }

  // Resolve buyer id + provider name/wallet via the public minted-agent list we just built,
  // falling back to the public repid lookup for the buyer.
  const mintedRes = await api(flags.base, 'GET', '/api/v1/agents/minted?include_mock=true', apiKey);
  const minted: any[] = mintedRes.status === 200 ? mintedRes.json?.agents ?? [] : [];

  // Provider is service.provider_agent_id (uuid) — resolve its name for the fulfill call + wallet.
  const providerUuid = service.provider_agent_id;
  const provRepid = await api(flags.base, 'GET', `/api/v1/repid/${providerUuid}`, apiKey);
  const providerName: string = provRepid.json?.agent_name ?? provRepid.json?.agent_id ?? 'unknown-provider';

  // Buyer: resolve --buyer (name or uuid) to a uuid via public repid lookup.
  const buyerLookup = await api(flags.base, 'GET', `/api/v1/repid/${encodeURIComponent(flags.buyer)}`, apiKey);
  const buyerId: string = buyerLookup.json?.agent_id ?? '';
  const buyerName: string = buyerLookup.json?.agent_name ?? flags.buyer;
  if (!buyerId) {
    throw new CleanExit(
      `Could not resolve buyer "${flags.buyer}" to an agent id via GET /api/v1/repid/${flags.buyer}. ` +
        `Pass --buyer=<a real active agent name or uuid>. It must NOT be the provider of the service ` +
        `(self-dealing is blocked). Default is trinity-nexus.`,
    );
  }
  if (buyerId === providerUuid) {
    throw new CleanExit(
      `Buyer "${flags.buyer}" is the PROVIDER of the "${flags.serviceType}" service — self-dealing is ` +
        `forbidden. Pick a different --buyer (e.g. a core agent that is not ${providerName}).`,
    );
  }

  const priceRaw = String(service.base_price_usdc_raw ?? service.agreed_price_usdc_raw ?? '0');

  // provider wallet (needed for a real settlement payTo). We can read it from the minted list if present.
  const provMinted = minted.find((m) => m.agent_id === providerName || m.name === providerName);
  const providerWallet: string | null =
    flags.providerWallet ?? provMinted?.wallet_address ?? null; // operator override, else minted list, else null

  const pf: Preflight = {
    apiKey,
    buyerApiKey,
    providerApiKey,
    buyerId,
    buyerName,
    serviceId: service.id,
    providerName,
    providerWallet,
    priceRaw,
  };

  if (flags.real) {
    pf.buyerKey = buyerKey; // validated at the top of preflight, before any network call
  }

  return pf;
}

// ---------------------------------------------------------------------------
// One buy-loop
// ---------------------------------------------------------------------------

class CleanExit extends Error {}

interface LoopResult {
  contractId: string | null;
  reachedStatus: string;
  isSimulated: boolean | null;
  txHash: string | null;
  ok: boolean;
  note?: string;
}

async function runOne(flags: Flags, pf: Preflight, i: number): Promise<LoopResult> {
  const tag = `[loop ${i + 1}/${flags.count}]`;

  // 1. CREATE
  const payload = {
    content: `E2E runner buy-loop ${i + 1}: the Base Sepolia chain id is 84532.`,
    title: `e2e-${flags.serviceType}-${Date.now()}-${i}`,
    criteria: ['factual accuracy'],
    service_type: flags.serviceType,
  };
  // Buyer key: the buyer creates its own contract, and `buyer_agent_id` in the body
  // is checked against the key's bound agent. This is also the earliest point a
  // mis-bound key shows up, so the failure note says so explicitly.
  const create = await api(flags.base, 'POST', '/api/v1/contracts', pf.buyerApiKey, {
    service_id: pf.serviceId,
    buyer_agent_id: pf.buyerId,
    payload,
  });
  if (create.status !== 201 || !create.json?.id) {
    const hint =
      create.status === 403
        ? ` — REPID_BUYER_AGENT_KEY looks bound to a different agent than --buyer (${pf.buyerName}/${pf.buyerId}); issue the key against that agent`
        : '';
    return { contractId: null, reachedStatus: 'create_failed', isSimulated: null, txHash: null, ok: false, note: `create → ${create.status} ${JSON.stringify(create.json)}${hint}` };
  }
  const contractId: string = create.json.id;
  console.log(`${tag} created contract ${contractId} (status=${create.json.status})`);

  // 2. ESCROW
  let escrowHeaders: Record<string, string> | undefined;
  if (flags.real) {
    if (!pf.providerWallet) {
      return { contractId, reachedStatus: 'pending', isSimulated: null, txHash: null, ok: false,
        note: 'real mode: provider wallet_address is not exposed on the public surface, so the paying header\'s ' +
          '`to` cannot be set. Provide the provider wallet (query repid_agents.wallet_address, Sean lane) or run simulated.' };
    }
    const header = await buildX402Payment({
      privateKey: pf.buyerKey!,
      to: pf.providerWallet,
      value: pf.priceRaw,
    });
    escrowHeaders = { 'X-PAYMENT': header };
  }
  // Buyer key: /escrow requires a caller who is a PARTY to the contract.
  const escrow = await api(flags.base, 'POST', `/api/v1/contracts/${contractId}/escrow`, pf.buyerApiKey, {}, escrowHeaders);
  if (escrow.status === 403) {
    return { contractId, reachedStatus: 'pending', isSimulated: null, txHash: null, ok: false,
      note: `escrow → 403 ${JSON.stringify(escrow.json)}. /escrow requires an agent-bound key ` +
        `belonging to the contract's buyer or provider — check REPID_BUYER_AGENT_KEY is bound to ` +
        `${pf.buyerName} (${pf.buyerId}).` };
  }
  if (escrow.status === 402) {
    return { contractId, reachedStatus: 'pending', isSimulated: null, txHash: null, ok: false,
      note: `escrow → 402 payment required. In --real mode this means the header was missing/invalid or the ` +
        `server rejected the payment. In simulated mode this means the server has X402_ENFORCEMENT_ENABLED=true ` +
        `and requires a real header (run --real, or ask Sean to unset enforcement for a simulated demo).` };
  }
  if (escrow.status !== 200 || escrow.json?.status !== 'escrowed') {
    return { contractId, reachedStatus: create.json.status, isSimulated: null, txHash: null, ok: false,
      note: `escrow → ${escrow.status} ${JSON.stringify(escrow.json)}` };
  }
  console.log(`${tag} escrowed (x402_payment_id=${escrow.json.x402_payment_id ?? 'legacy/none'})`);

  // 3. FULFILL
  if (flags.directFulfill) {
    // Provider key: delivery must come from the provider named on the contract.
    const fulfill = await api(flags.base, 'POST', `/api/v1/contracts/${contractId}/fulfill`, pf.providerApiKey!, {
      result: { verdict: 'PASS', note: 'e2e direct fulfill' },
    });
    if (fulfill.status !== 200) {
      const hint =
        fulfill.status === 403
          ? ` — /fulfill requires a key bound to the PROVIDER (${pf.providerName}); check REPID_PROVIDER_AGENT_KEY`
          : '';
      return { contractId, reachedStatus: 'escrowed', isSimulated: null, txHash: null, ok: false, note: `fulfill → ${fulfill.status} ${JSON.stringify(fulfill.json)}${hint}` };
    }
  } else {
    // OPERATOR key, deliberately: this names the PROVIDER in `agent_name`, which a
    // buyer-bound key is refused for (agent_name must match the key's bound agent).
    const fulfill = await api(flags.base, 'POST', '/api/v1/agent/process-contracts', pf.apiKey, {
      agent_name: pf.providerName,
    });
    if (fulfill.status !== 200 || !fulfill.json?.processed) {
      return { contractId, reachedStatus: 'escrowed', isSimulated: null, txHash: null, ok: false,
        note: `fulfill(process-contracts) → ${fulfill.status} ${JSON.stringify(fulfill.json)} ` +
          `(if the PCP verdict was VETO the contract routed to disputed, not fulfilled — try --direct-fulfill)` };
    }
  }
  console.log(`${tag} fulfilled`);

  // 4. SATISFY — buyer key: this releases the payment, so it must be the BUYER.
  // (The provider is refused here by name: self_satisfaction_forbidden.)
  const satisfy = await api(flags.base, 'POST', `/api/v1/contracts/${contractId}/satisfy`, pf.buyerApiKey, {
    satisfaction_score: flags.satisfaction,
  });
  if (satisfy.status !== 200) {
    const hint =
      satisfy.status === 403
        ? ` — /satisfy releases the payment and requires a key bound to the BUYER (${pf.buyerName}); check REPID_BUYER_AGENT_KEY`
        : '';
    return { contractId, reachedStatus: 'fulfilled', isSimulated: null, txHash: null, ok: false, note: `satisfy → ${satisfy.status} ${JSON.stringify(satisfy.json)}${hint}` };
  }
  const finalStatus: string = satisfy.json?.status ?? 'satisfied';
  console.log(`${tag} satisfied → ${finalStatus}`);

  // Read back the settlement honesty flags via the public marketplace surface.
  let isSimulated: boolean | null = flags.real ? false : true;
  let txHash: string | null = null;
  try {
    const recent = await api(flags.base, 'GET', '/api/v1/marketplace/recent-transactions?limit=100', pf.apiKey);
    const row = (recent.json?.transactions ?? []).find((t: any) => t.contract_id === contractId);
    if (row) {
      isSimulated = row.is_simulated;
      txHash = row.tx_hash;
    }
  } catch {
    /* best-effort */
  }

  return { contractId, reachedStatus: finalStatus, isSimulated, txHash, ok: true };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const flags = parseFlags(process.argv.slice(2));

  console.log('=== E2E TRANSACTION RUNNER ===');
  console.log(`mode:          ${flags.real ? 'REAL (x402 settlement)' : 'SIMULATED (labeled; 0 RepID, nothing on-chain)'}`);
  console.log(`count:         ${flags.count}`);
  console.log(`base:          ${flags.base}`);
  console.log(`buyer:         ${flags.buyer}`);
  console.log(`service-type:  ${flags.serviceType}`);
  console.log(`fulfill:       ${flags.directFulfill ? 'direct (/:id/fulfill, no PCP gate)' : 'provider handler (/agent/process-contracts)'}`);
  console.log('');

  if (!flags.real) {
    console.log(
      'NOTE (honesty): simulated mode moves the contract through the full lifecycle so the loop is\n' +
        'validated, but the settlement row is is_simulated=true and RepID deltas are ZEROED. It grows the\n' +
        'contract count, NOT RepID, and writes NOTHING on-chain. Use --real (with a funded wallet + the\n' +
        'server flags) to grow RepID + potentially trigger an ERC-8004 write.\n',
    );
  } else {
    console.log(
      'NOTE (on-chain reputation): a real settled contract only yields an ERC-8004 reputation write when\n' +
        'the PROVIDER has current_repid >= 1000 AND an erc8004_token_id, and the server\'s funded attestor\n' +
        '(ERC8004_REPUTATION_WRITER_KEY) resolves. The FeedbackLoopWorker fires it ~60s post-settle. This\n' +
        'script cannot flip those server-side conditions — it reports what actually happened.\n',
    );
  }

  let pf: Preflight;
  try {
    pf = await preflight(flags);
  } catch (e) {
    if (e instanceof CleanExit) {
      console.error('\n[e2e] cannot run — ' + e.message + '\n');
      process.exit(2);
    }
    throw e;
  }

  console.log('preflight OK:');
  // Presence only — never a key value or prefix.
  //
  // Written as `role (VAR_NAME)` rather than `role=VAR_NAME` on purpose: the
  // `name=SOMETHING_KEY` shape trips gitleaks' generic-api-key rule, and the
  // honest fix for a line that only ever prints variable NAMES is to stop
  // looking like an assignment — not to add a scanner exception, which would
  // outlive this line and cover every future edit to this file.
  console.log(
    `  keys:     operator (REPID_API_KEY) · buyer, bound (REPID_BUYER_AGENT_KEY)` +
      `${pf.providerApiKey ? ' · provider, bound (REPID_PROVIDER_AGENT_KEY)' : ''}`,
  );
  console.log(`  buyer:    ${pf.buyerName} (${pf.buyerId})`);
  console.log(`  service:  ${pf.serviceId} (${flags.serviceType}, ${Number(pf.priceRaw) / 1e6} USDC)`);
  console.log(`  provider: ${pf.providerName}${flags.real ? ` (payTo=${pf.providerWallet ?? 'UNKNOWN — see note'})` : ''}`);
  console.log('');

  const results: LoopResult[] = [];
  for (let i = 0; i < flags.count; i++) {
    try {
      results.push(await runOne(flags, pf, i));
    } catch (e: any) {
      results.push({ contractId: null, reachedStatus: 'error', isSimulated: null, txHash: null, ok: false, note: e?.message ?? String(e) });
    }
  }

  console.log('\n=== SUMMARY ===');
  const ok = results.filter((r) => r.ok).length;
  const settled = results.filter((r) => r.reachedStatus === 'settled').length;
  const realSettlements = results.filter((r) => r.ok && r.isSimulated === false).length;
  for (const [idx, r] of results.entries()) {
    const flag = r.isSimulated === false ? 'REAL' : r.isSimulated === true ? 'SIM' : '—';
    console.log(
      `  loop ${idx + 1}: ${r.ok ? 'OK' : 'FAIL'} status=${r.reachedStatus} [${flag}]` +
        `${r.txHash ? ` tx=${r.txHash}` : ''}${r.contractId ? ` contract=${r.contractId}` : ''}` +
        `${r.note ? `\n           ${r.note}` : ''}`,
    );
  }
  console.log(`\n  ${ok}/${flags.count} loops OK · ${settled} reached settled · ${realSettlements} REAL settlement(s)`);
  if (!flags.real) {
    console.log('  (simulated run — RepID unchanged, no on-chain writes. This is expected + labeled.)');
  } else if (realSettlements > 0) {
    console.log('  Real settlements complete. Check erc8004_reputation_writes ~60s later for on-chain writes');
    console.log('  (fires only for provider repid>=1000 + minted + writer key present).');
  }

  process.exit(ok === flags.count ? 0 : 1);
}

main().catch((e) => {
  console.error('[e2e] fatal:', e?.message ?? e);
  process.exit(1);
});
