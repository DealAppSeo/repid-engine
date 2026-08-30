import { Request, Response, NextFunction } from 'express';
import { db } from '../db';
import { validateAgentApiKey } from '../auth/api-keys';
import { logAgentEvent } from '../engine/agent-log';
import {
  assessUnboundContractAccess,
  assessUnboundServiceMutation,
  partyGuardLogLine,
  serviceGuardLogLine,
  unboundRefusalBody,
  unboundServiceRefusalBody,
} from './contract-party-guard';

export const authMiddleware = async (req: Request, res: Response, next: NextFunction) => {
  if (req.method === 'OPTIONS') return next();
  const publicPaths = ['/health', '/healthz', '/', '/api/v1/health'];
  if (publicPaths.includes(req.path)) return next();

  // Run-loop liveness is public so UptimeRobot and any external monitor can ping
  // it without a key. It is read-only and exposes no scoring internals — agent
  // names, ping ages and session counters, which the fleet's own dashboards
  // already show. A monitor that needs a secret is a monitor that silently stops
  // working when the secret rotates, which is the failure mode this endpoint
  // exists to catch.
  if (
    req.method === 'GET' &&
    (req.path === '/api/v1/runloop-liveness' || req.path.startsWith('/api/v1/runloop-liveness/'))
  ) {
    return next();
  }

  if (req.method === 'GET' && (req.path.startsWith('/api/v1/repid/') || req.path.startsWith('/api/v1/erc8004/validate/'))) {
    return next();
  }

  // Reponomics demo endpoints â€” public per sprint Phase 8.
  if (req.method === 'GET' && req.path.startsWith('/api/v1/builder/')) return next();
  if (req.method === 'GET' && req.path.startsWith('/api/v1/trader/')) return next();
  if (req.method === 'GET' && req.path.startsWith('/api/v1/demo/')) return next();
  // TrustMarket rating summaries are a public, keyless read (a reputation surface
  // behind a key is not a public reputation surface). POST /ratings stays authed.
  if (req.method === 'GET' && req.path.startsWith('/api/v1/ratings/')) return next();

  // The publish queue's READ is keyless; its WRITE is not.
  //
  // Caught before shipping, by running the same probe that found three other reads returning
  // 401 to their own UI: this endpoint was mounted after authMiddleware, so the surface built
  // to prove content is verified would itself have been unreadable. Shipping that would have
  // been the very bug being fixed elsewhere in the same session, in new code.
  //
  // A verification record behind a key is not a verification record — the point is that
  // anyone can check that what was published was checked first. The handler deliberately
  // selects METADATA ONLY: id, platform, status, verdict, score, mode, author, timestamps.
  // It does not select `content` or `hashtags`, so unpublished copy is not exposed by it.
  //
  // GET ONLY. POST /api/v1/social/drafts writes a row a scheduler may later publish and stays
  // authed — an anonymous caller must not be able to put anything into the queue at all.
  if (req.method === 'GET' && req.path === '/api/v1/social/drafts') return next();

  // The service catalog is a public, keyless READ, for the same reason as ratings
  // above: a marketplace behind a key is not a public marketplace. The SDK's
  // `listServices()` calls GET /api/v1/services, and until now a developer who
  // followed the quickstart could verify an output and read any agent's RepID with
  // no key, then hit a 401 the moment they tried to browse what is for sale — the
  // exact wall in the middle of the discover→buy→receipt story. The same rows are
  // already served to anyone at trustshell.dev/market, so the key was gating a
  // surface that was never actually private.
  //
  // GET ONLY, and the method check is the whole control: this router also carries
  // POST / (create a listing), PATCH /:id and DELETE /:id, which mutate the
  // catalog and MUST stay authed. `startsWith` without the method guard would open
  // all four.
  //
  // Verified against the table before opening it: agent_services holds catalog
  // columns only — provider id, type, name, description, price, min RepID,
  // capability metadata, fulfilment counters, timestamps. No credential, wallet or
  // key material is reachable through `select('*')` here.
  if (req.method === 'GET' && (req.path === '/api/v1/services' || req.path.startsWith('/api/v1/services/'))) {
    return next();
  }

  // GET /api/v1/grants — MEASURED BROKEN IN PRODUCTION, 2026-08-28.
  //
  // trustshell.dev's Grants screen calls this with no key (`listGrantsFor` in
  // lib/repid-engine.ts sends no auth header, exactly like its Passport and Market reads).
  // The live endpoint answered `401 Unauthorized: API key required` to that exact request,
  // while /api/v1/hal/stats answered 200 from the same client — so this was auth, not an
  // outage. The screen has therefore never been able to read a single grant: its client
  // maps any non-ok response to 'error', so the failure renders as a generic error state
  // rather than as "you are not authenticated", and nothing upstream ever said otherwise.
  //
  // That makes it the same defect this codebase keeps paying for: a feature built complete,
  // wired at both ends by inspection, and non-functional in production because the two ends
  // disagreed about one thing nobody executed.
  //
  // GET ONLY, and the method check is the whole control. This router also carries
  // POST /grants (mint), POST /grants/:id/revoke and POST /grants/:id/authorize, which
  // change who may act on whose behalf and MUST stay authed. An exact path match rather
  // than `startsWith` for the same reason.
  //
  // Verified against the table before opening it: principal_grants holds the authority
  // record only — grantor/grantee ids, parent, depth, class, capabilities, caveats, role,
  // validity window, revocation, mint reason, an idempotency token, and the grantor's
  // signature plus the public address that produced it. No key or secret material is
  // reachable through `select('*')` here. The signature and address are the PROOF a grant
  // is genuine; publishing them is the point of a verifiable authority record, and neither
  // authorizes anything on its own — minting still requires an API key.
  if (req.method === 'GET' && req.path === '/api/v1/grants') {
    return next();
  }

  // GET /api/v1/grants/roles — the role ceilings, static and public.
  //
  // Opened for the same reason as the line above and with the same control: an exact path
  // match plus the method guard, so it cannot widen to the POST mint/revoke/authorize paths
  // that share this router's `/grants` prefix.
  //
  // It returns four hardcoded names, their capability ceilings and the one-line reasoning for
  // each — no row, no key, no agent identity, nothing derived from the database at all. The
  // point of the layer is that a CTO grant provably cannot carry spend authority; a
  // constraint nobody outside can read is a constraint nobody can rely on.
  if (req.method === 'GET' && req.path === '/api/v1/grants/roles') {
    return next();
  }

  // The Authority screen's two reads, broken the same way and found by the same probe.
  //
  // MEASURED 2026-08-28, keyless, against production:
  //   GET /api/v1/stake/authority/<id>  -> 401
  //   GET /api/v1/staking/<agent>       -> 401
  // Both clients (`fetchAuthority`, `fetchStakePositions`) send no auth header and map any
  // failure to `null`, so the screen renders "no authority data" rather than "you are not
  // authenticated". Half the Trust Kernel — Grants and Authority — was reading nothing.
  //
  // WHY EACH IS SAFE TO OPEN, verified rather than assumed:
  //   /stake/authority/:id returns four computed scalars — builder id, stake total,
  //     authority, and the basis it was derived from. It reads no table columns out.
  //   /staking/:agent previously did `select('*')`, which would have exposed a free-form
  //     `metadata` jsonb with NO ROWS to inspect and therefore nothing to certify. It now
  //     selects named columns; see the note at that handler. This bypass depends on that
  //     narrowing and must not be landed without it.
  //
  // GET ONLY, and the method check is the control for THIS rule: it admits no POST, so
  // nothing that moves collateral is opened by it. POST /api/v1/staking/deposit stays
  // API-key gated.
  //
  // Do NOT read that as "every stake POST is API-key gated" — POST /api/v1/stake/deposit is
  // deliberately bypassed a few lines below and authorizes itself in the route (a session
  // for simulated stake, a wallet signature for a real one). An earlier draft of this
  // comment asserted the opposite and would have sat fifteen lines above the rule that
  // contradicts it. A comment that disagrees with the code beneath it is worse than none.
  if (
    req.method === 'GET' &&
    (req.path.startsWith('/api/v1/stake/authority/') || req.path.startsWith('/api/v1/staking/'))
  ) {
    return next();
  }
  if (req.method === 'POST' && req.path === '/api/v1/demo/two-builder/bootstrap') return next();
  if (req.method === 'POST' && req.path === '/api/v1/demo/run-round-anonymous') return next();
  if (req.method === 'POST' && req.path === '/api/v1/builder/token-signup') return next();
  // /stake/deposit serves BOTH signed-out demo traffic and wallet-bearing real
  // deposits, which a single API-key check cannot tell apart — so it is bypassed
  // here and does its own, stricter authorization in the route
  // (services/stake-authorization.ts: session for simulated stake, wallet
  // signature for real). It is NOT unauthenticated. /stake/withdraw is not on
  // this list and stays API-key gated.
  if (req.method === 'POST' && req.path === '/api/v1/stake/deposit') return next();
  // Read-only: returns the exact text to sign. Reveals nothing, authorizes nothing.
  if (req.method === 'GET' && req.path === '/api/v1/stake/deposit/message') return next();

  // PUBLIC MARKET BOARD. An agent that finds the ecosystem cannot decide whether
  // to join a market it is not allowed to look at. These two reads are already
  // written to be safe in public: prices in the list/detail are the BUYER's own
  // stated range, and `sealed` is true until bids close. The bids themselves —
  // the actually competitive information — stay behind requireBoundAgent plus a
  // participant check on /rfqs/:id/bids, which is NOT opened here.
  // RUNG 0 — keyless discovery. Everything it returns is already a public reputation fact
  // (listed price, agent name, earned RepID, job counts, dispute counts, attestation counts).
  // An agent cannot decide whether to join a market it is not allowed to look at.
  if (req.method === 'GET' && req.path === '/api/v1/market/discover') return next();
  if (req.method === 'GET' && req.path === '/api/v1/negotiation/rfqs') return next();
  if (req.method === 'GET' && /^\/api\/v1\/negotiation\/rfqs\/[^/]+$/.test(req.path)) return next();
  if (req.method === 'POST' && req.path === '/api/v1/tip/request') return next();
  if (req.method === 'POST' && /^\/api\/v1\/tip\/deliver\/[^/]+$/.test(req.path)) return next();
  if (req.method === 'POST' && req.path === '/api/v1/bet/place') return next();
  if (req.method === 'POST' && req.path === '/api/v1/bet/resolve') return next();
  // /trader/round/start is gated by Sean-signature (not API key) â€” handled in the route.
  if (req.method === 'POST' && req.path === '/api/v1/trader/round/start') return next();
  if (req.method === 'POST' && req.path === '/api/v1/trader/round/resolve-open') return next();

  // v11 external endpoints â€” per-agent bearer auth handled inside the route,
  // or fully public (register / RepID card / VDR / LLM trust leaderboard).
  if (req.path === '/api/v1/agents/register' && req.method === 'POST') return next();
  if (req.method === 'POST' && /^\/api\/v1\/agents\/[^/]+\/score-event$/.test(req.path)) return next();
  if (req.method === 'GET' && /^\/api\/v1\/agents\/[^/]+\/(repid|vdr)$/.test(req.path)) return next();
  // Sprint A5: public agent card (no private fields exposed)
  if (req.method === 'GET' && /^\/api\/v1\/agents\/[^/]+\/card$/.test(req.path)) return next();
  // 2026-07-23: public per-agent reputation reads for the trustrepid.dev
  // glass-box surface — history (curated fields only, no raw metadata),
  // badges (public achievements), ethics (same computeEthics as /card),
  // zkp tiered disclosure (self-redacting for humans). All read-only.
  // routes/agents.ts is mounted at root, so these are BARE paths; the
  // optional /api/v1 prefix keeps the bypass robust to either mount.
  if (req.method === 'GET' && /^(\/api\/v1)?\/agents\/[^/]+\/(history|badges|ethics|reliability)$/.test(req.path)) return next();
  if (req.method === 'GET' && /^(\/api\/v1)?\/agents\/[^/]+\/zkp\/[A-Za-z]+$/.test(req.path)) return next();
  // Public activity feed (curated fields, human agents anonymized server-side).
  if (req.method === 'GET' && /^(\/api\/v1)?\/events\/recent$/.test(req.path)) return next();
  // Sprint 6: public ERC-8004 verification surface (mint-status, onchain)
  if (req.method === 'GET' && /^\/api\/v1\/agents\/[^/]+\/(mint-status|onchain)$/.test(req.path)) return next();
  // Sprint 12 (megasprint): public Graph RAG recall surface
  if (req.method === 'GET' && /^\/api\/v1\/agents\/[^/]+\/recall$/.test(req.path)) return next();
  if (req.method === 'GET' && /^\/api\/v1\/agents\/[^/]+\/memory\/recent$/.test(req.path)) return next();
  // Scoped lesson recall — read-only, and the dispatcher calls it to append
  // context under the LESSONS.md block it already injects verbatim. Requiring a
  // key here would add a dispatch failure mode without protecting anything new.
  // The POST /api/v1/lessons write path is NOT bypassed: it mutates shared state.
  if (req.method === 'GET' && req.path === '/api/v1/lessons/recall') return next();
  // Wave 6: ERC-8004 spec — public registration file + reputation reads
  if (req.method === 'GET' && /^\/api\/v1\/agents\/[^/]+\/registration\.json$/.test(req.path)) return next();
  if (req.method === 'GET' && /^\/api\/v1\/agents\/[^/]+\/reputation\/(payload\.json|onchain)$/.test(req.path)) return next();
  if (req.method === 'GET' && req.path === '/api/v1/llm-trust') return next();
  // Sprint 1: x402 inbound demo bypass
  if (req.method === 'POST' && /^\/api\/v1\/agents\/[^/]+\/trade-analysis$/.test(req.path)) return next();

  // 2026-07-29: T0.5 agent gate (spec §9.1) — /llm/complete carries its OWN
  // anonymous metering (meterRun: 5 runs/day/IP, email verification → 100,
  // BYOK unmetered; default-ON via AGENT_GATE_ENABLED) plus a 30 req/min
  // limiter, and anonymous callers only ever reach the free tier0 pool.
  // Without this bypass the global auth 401s before the gate ever runs, which
  // broke TrustShell's entire "Try it, no code" onboarding path (verified
  // live 2026-07-29: create-agent succeeded, first run failed with
  // "Unauthorized: API key required").
  if (req.method === 'POST' && req.path === '/api/v1/llm/complete') return next();

  // Sprint A8: bypass global auth for keys (key-management.ts handles it)
  if (/^\/api\/v1\/agents\/[^/]+\/keys/.test(req.path)) {
    return next();
  }

  const apiKey = (req.headers['authorization']?.replace('Bearer ', '') || req.headers['x-api-key']) as string;

  if (!apiKey) {
    return res.status(401).json({ error: 'Unauthorized: API key required' });
  }

  const rawKeys = process.env.REPID_API_KEYS || '';
  const keyList = rawKeys.split(',').map(s => s.trim()).filter(Boolean);
  
  let valid = false;
  let tier = 'free';

  for (const k of keyList) {
    // allow key:tier or just key format
    const [key, keyTier] = k.split(':');
    if (key === apiKey) {
      valid = true;
      if (keyTier) tier = keyTier;
      break;
    }
  }

  // API key issuance V0 (2026-05-24): if the env-var allowlist didn't match, fall through to a
  // DB-issued key (agent_api_keys, hashed). Backward compatible — env keys still win first, and the
  // DB lookup uses only existing columns (agent_id/scopes), so it works before the tier/rate-limit
  // migration is applied. DB-issued keys are tagged tier='testnet' until tier wiring lands.
  let dbAgentId: string | undefined;
  if (!valid) {
    try {
      const dbKey = await validateAgentApiKey(apiKey);
      if (dbKey) {
        valid = true;
        tier = 'testnet';
        dbAgentId = dbKey.agent_id;
      }
    } catch (e) {
      // DB unreachable → fall through to the 403 below (env path already failed).
    }
  }

  // Best-effort log to Supabase. Successful auth attempts fire on EVERY request and were the
  // dominant source of trinity_agent_logs churn (~1.8M rows) — log them at 'info' so they are
  // subject to AGENT_LOG_SAMPLE. FAILED auth attempts are security-relevant, so log at 'warn'
  // (never sample-dropped).
  await logAgentEvent(
    {
      action: 'api_auth_attempt',
      agent: valid
        ? ((req.headers['x-agent-name'] as string) || 'api-gateway')
        : 'UNAUTHENTICATED',
      metadata: {
        success: valid,
        tier,
        path: req.path,
        method: req.method,
        ip: req.ip
      }
    },
    valid ? 'info' : 'warn'
  );

  if (!valid) {
    return res.status(403).json({ error: 'Forbidden: Invalid API key' });
  }

  (req as any).apiKey = { key: apiKey, tier };
  if (dbAgentId) {
    (req as any).agent_id = dbAgentId;

    // f2-authz: reject any agent identity in the request that isn't the one this
    // key is bound to.
    //
    // SECURITY FIX 2026-07-31 — this was an OR-chain:
    //     req.body?.agent_id || req.body?.buyer_agent_id || ... || req.body?.provider_agent_id
    // which collapses to the FIRST TRUTHY VALUE and checks only that one. Every
    // other identity in the same request went unexamined.
    //
    // The exploit: hold a valid key bound to your own agent, then send
    //     { agent_id: <your own id>, provider_agent_id: <victim's id>, ... }
    // The check reads agent_id, matches, passes — and provider_agent_id is never
    // looked at. That let a caller act under another agent's identity: submit a
    // bid or list a service as a rival, poisoning their pricing and delivery
    // record. Worse, where a UNIQUE(rfq_id, provider_agent_id) constraint exists,
    // one forged request permanently locks the real agent out of that auction.
    //
    // Now EVERY identity-bearing field is collected and each must match. A
    // request naming two different agents is refused, whichever order they
    // appear in. Verified before changing: no route in src/routes reads two
    // different agent-id fields from one body, so nothing legitimate sends two.
    const IDENTITY_FIELDS = ['agent_id', 'buyer_agent_id', 'requestor_agent_id', 'provider_agent_id', 'agent'] as const;
    const claimedIdentities: Array<{ field: string; source: 'body' | 'query'; value: string }> = [];
    for (const field of IDENTITY_FIELDS) {
      const fromBody = (req.body as Record<string, unknown> | undefined)?.[field];
      if (typeof fromBody === 'string' && fromBody.trim()) {
        claimedIdentities.push({ field, source: 'body', value: fromBody.trim() });
      }
      const fromQuery = (req.query as Record<string, unknown> | undefined)?.[field];
      if (typeof fromQuery === 'string' && fromQuery.trim()) {
        claimedIdentities.push({ field, source: 'query', value: fromQuery.trim() });
      }
    }

    const targetAgentName = req.body?.agent_name || 
                            req.body?.agent_assigned || 
                            req.body?.assigned_to;

    let boundAgentName: string | undefined;
    try {
      const fromObj = db.from('repid_agents');
      if (fromObj && typeof fromObj.select === 'function') {
        const { data: agentData } = await fromObj.select('agent_name').eq('id', dbAgentId).maybeSingle();
        boundAgentName = agentData?.agent_name;
      }
    } catch (e) {
      console.warn('[authMiddleware] repid_agents lookup failed (possibly mocked DB):', e);
    }

    // A claimed identity is acceptable only if it IS the bound agent — by id or
    // by that agent's own name. EVERY claim is checked, not just the first.
    const boundId = String(dbAgentId).trim().toLowerCase();
    const boundName = boundAgentName ? boundAgentName.trim().toLowerCase() : null;
    const isBoundIdentity = (value: string): boolean => {
      const v = value.trim().toLowerCase();
      return v === boundId || (boundName !== null && v === boundName);
    };

    for (const claim of claimedIdentities) {
      if (!isBoundIdentity(claim.value)) {
        // Named loudly: a 403 whose cause is invisible is the kind of auth
        // failure people work around by widening the check.
        console.warn(
          `[authMiddleware] f2-authz REJECT — ${claim.source}.${claim.field} names an agent this key is not bound to ` +
            `(path=${req.path}, bound=${boundId})`
        );
        return res.status(403).json({
          error: 'Forbidden: agent identity mismatch (API key is bound to a different agent identity)',
          field: `${claim.source}.${claim.field}`,
        });
      }
    }

    if (targetAgentName && boundAgentName && String(targetAgentName).trim().toLowerCase() !== boundAgentName.toLowerCase()) {
      if (String(targetAgentName).trim().toLowerCase() !== boundId) {
        return res.status(403).json({ error: 'Forbidden: agent_name mismatch (API key is bound to a different agent identity)' });
      }
    }

    // 2026-07-30 (A2A self-serve): /contracts/<uuid>/* paths carry a CONTRACT
    // id, not an agent id — the generic path-UUID check below misread it and
    // 403'd every agent-bound key, making the whole A2A lifecycle
    // (escrow/fulfill/satisfy/outcome) operator-key-only in practice
    // (verified live). Proper authz instead: a bound key may act on a
    // contract iff its agent is a PARTY (buyer or provider). Unknown
    // contract ids fall through so the route returns its own 404.
    const contractMatch = req.path.match(
      /^(?:\/api\/v1)?\/contracts\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:\/|$)/i
    );
    if (contractMatch) {
      try {
        const { data: contractRow } = await db
          .from('service_contracts')
          .select('buyer_agent_id, provider_agent_id')
          .eq('id', contractMatch[1])
          .maybeSingle();
        if (contractRow) {
          const partyIds = [contractRow.buyer_agent_id, contractRow.provider_agent_id]
            .filter(Boolean)
            .map((x: string) => String(x).toLowerCase());
          if (!partyIds.includes(dbAgentId.toLowerCase())) {
            return res.status(403).json({
              error: 'Forbidden: API key agent is not a party to this contract',
            });
          }
        }
      } catch (e) {
        console.warn('[authMiddleware] contract party lookup failed (possibly mocked DB):', e);
      }
      return next();
    }

    // 2026-07-31 (A2A negotiation): /negotiation/rfqs/<uuid>/... paths carry an
    // RFQ or BID id, never an agent id. The generic path-UUID check below would
    // read one as a mismatched agent id and 403 every agent-bound key — the
    // identical failure that made the whole contract lifecycle operator-key-only
    // until the /contracts carve-out above was added.
    //
    // Authorization is NOT skipped, it moves to where the facts are: the router
    // resolves the RFQ and enforces that a buyer may only act on its own RFQ and
    // a provider only on its own bid thread. Party membership here would be a
    // second, weaker copy of that check — and the identity fields in the body
    // are already validated above.
    if (/^(?:\/api\/v1)?\/negotiation\//i.test(req.path)) {
      return next();
    }

    // Check for UUID or name in URL path
    const pathParts = req.path.split('/');
    const uuidRe = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    const pathUuid = pathParts.find(p => uuidRe.test(p));
    if (pathUuid && pathUuid.toLowerCase() !== dbAgentId.toLowerCase()) {
      return res.status(403).json({ error: 'Forbidden: agent_id in path mismatch (API key is bound to a different agent identity)' });
    }

    // 2026-07-30: the last-segment name check exists to catch
    // /agents/<name>-style paths where <name> isn't the bound agent. It was
    // applied to EVERY path, so any collection route whose final word wasn't
    // in the whitelist (e.g. POST /api/v1/services, POST /api/v1/contracts)
    // 403'd for all bound keys — verified live; that plus the UUID misread
    // made A2A operator-only. Scope it to /agents/ paths, where a trailing
    // name actually denotes an agent. Collection routes stay protected by
    // the body-level binding checks above (buyer/provider/requestor/agent
    // fields must match the bound agent).
    const isAgentScopedPath = /^(?:\/api\/v1)?\/agents\//.test(req.path);
    const lastPart = pathParts[pathParts.length - 1];
    if (isAgentScopedPath && lastPart && lastPart.length > 0 && !uuidRe.test(lastPart)) {
      // If lastPart is not a UUID, check if it matches the bound agent name
      if (boundAgentName && lastPart.toLowerCase() !== boundAgentName.toLowerCase() &&
          // filter out generic route paths
          !['verify', 'complete', 'status', 'receipts', 'register', 'score-event', 'card', 'mint-status', 'onchain', 'recall', 'recent', 'registration.json', 'payload.json', 'keys'].includes(lastPart.toLowerCase())) {
        return res.status(403).json({ error: 'Forbidden: agent identity in path mismatch (API key is bound to a different agent identity)' });
      }
    }
  }

  // ── THE BRANCH THAT WAS MISSING ────────────────────────────────────────────
  // Everything above is inside `if (dbAgentId)`. A shared REPID_API_KEYS env key
  // authenticates fine and leaves `dbAgentId` undefined, so a caller with NO agent
  // identity skipped every party check and could mutate anyone's contract.
  // `/fulfill` and `/satisfy` noticed and self-defend with `unbound_caller`;
  // `/escrow`, `/cancel`, `/dispute` and `/resolve` did not — and `/escrow` is the
  // one that moves a contract to `escrowed` without payment when
  // `X402_ENFORCEMENT_ENABLED` is unset (it is compared to the literal 'true').
  //
  // Default OFF: byte-identical to today. `shadow` logs what it would refuse so the
  // real question — does any live integration still drive contracts with a shared
  // key? — is answered from traffic rather than from argument. Only `enforce`
  // refuses, and it reuses the `unbound_caller` code the other two already return.
  const partyAssessment = assessUnboundContractAccess({
    path: req.path,
    method: req.method,
    hasBoundAgent: Boolean(dbAgentId),
  });
  if (partyAssessment.isUnboundContractMutation) {
    console.warn(partyGuardLogLine(partyAssessment));
    if (partyAssessment.refuse) {
      return res.status(403).json(unboundRefusalBody(partyAssessment));
    }
  }

  // ── THE SAME HOLE, ONE RESOURCE UPSTREAM ───────────────────────────────────
  // The guard above covers `/contracts/<uuid>`. It does not cover the LISTINGS
  // those contracts are created from, and on `PATCH`/`DELETE /services/<id>` the
  // nesting bug is inverted rather than merely absent: the generic path-UUID
  // check inside `if (dbAgentId)` compares a SERVICE id to the caller's AGENT id,
  // so a bound agent is refused on every listing including its own — while the
  // unidentified caller skips that check with the rest of the block and reaches
  // every row. The only caller who can edit a listing is the one nobody can
  // attribute.
  //
  // It is not cosmetic: `routes/v1/negotiation.ts` re-reads `active` and
  // `min_repid_to_purchase` from `agent_services` when a buyer accepts a bid, so
  // flipping one boolean on a rival's row denies an award that was already won.
  //
  // Same env switch on purpose — the condition is identical (authenticated,
  // no bound identity, identity-scoped mutation), so one shadow run measures both
  // surfaces and one flip enforces both. GET is untouched: /services browse and
  // detail are the discovery surface.
  const serviceAssessment = assessUnboundServiceMutation({
    path: req.path,
    method: req.method,
    hasBoundAgent: Boolean(dbAgentId),
  });
  // `observe` (not merely `isUnboundServiceMutation`) gates the log, so `off`
  // stays silent — otherwise this would start writing warn lines in production
  // with no flag flipped, and `shadow` would measure nothing that `off` did not
  // already emit.
  if (serviceAssessment.observe) {
    console.warn(serviceGuardLogLine(serviceAssessment));
  }
  if (serviceAssessment.refuse) {
    return res.status(403).json(unboundServiceRefusalBody(serviceAssessment));
  }

  next();
};

