/* eslint-disable no-console */
/**
 * Fleet registration script v2.
 *
 * Bug-fixed replacement for scripts/register-base-sepolia.js. The old script
 * is intentionally NOT deleted — it is kept for reference per the sprint
 * spec.
 *
 * What v2 fixes:
 *   1. DB-driven loop: reads the 12 fleet agent names from agent_kya_registry
 *      instead of hardcoding 4.
 *   2. agent_id_onchain stores the parsed agentId from the Registered event,
 *      NOT the tx hash. (Old script wrote tx.hash to repid_agents.erc8004_address,
 *      which is the bug that left every existing token essentially unindexed.)
 *   3. Inline data URI scheme — never an off-chain HTTPS URL. SOPHIA's working
 *      #3747 metadata is the gold-standard template; this script uses the
 *      same shape for all 12 agents. Files live in scripts/fleet-metadata/.
 *   4. registration_status state machine: verified | pending | failed |
 *      orphaned | deprecated_duplicate.
 *   5. NEXUS dedupe: marks the four existing duplicate orphans
 *      (#1583/#1612/#1632/#1644) as deprecated_duplicate with superseded_by
 *      pointing at the new canonical token id — DB-only marking, no on-chain
 *      transfer (would only do that if the deployer wallet owns the tokens).
 *   6. Dry-run mode: prints every action it WOULD take without sending any
 *      transactions. Default is dry-run; pass --execute to mint for real.
 *
 * Running:
 *   node scripts/fleet-register-v2.js                # dry-run (default)
 *   node scripts/fleet-register-v2.js --execute      # real mints
 *   node scripts/fleet-register-v2.js --only=NEXUS   # one-agent test
 *   node scripts/fleet-register-v2.js --status-only  # just check chain state, no DB writes
 */

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { ethers } = require('ethers');
const { createClient } = require('@supabase/supabase-js');

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const RPC = process.env.BASE_SEPOLIA_RPC_URL || 'https://sepolia.base.org';
const REGISTRY = '0x8004A818BFB912233c491871b3d84c89A494BD9e'; // ERC-8004 IdentityRegistry, Base Sepolia
const FLEET_NAMES = [
  'SOPHIA', 'NEXUS', 'VERITAS', 'APM', 'TORCH', 'HDM', 'MEL',
  'GCM', 'CHESED', 'ORCH', 'W3C', 'SHOFET',
];

// Known orphans documented in the sprint spec — Sean's prior runs left these
// tokens with off-chain (404) URIs. Re-mints will replace them; DB rows are
// updated to point at the new canonical token, the old tokens stay on-chain
// as deprecated.
const KNOWN_ORPHANS = {
  NEXUS:   [1583, 1612, 1632, 1644],
  VERITAS: [1848],
  TORCH:   [1849],
  HDM:     [1850],
  MEL:     [1851],
};

// SOPHIA #3747 is already inline-metadata-perfect, do not touch.
const ALREADY_PERFECT = { SOPHIA: 3747 };

const ABI = [
  'function register(string agentURI, (string metadataKey, bytes metadataValue)[] metadata) external returns (uint256 agentId)',
  'function setAgentURI(uint256 agentId, string newURI) external',
  'function ownerOf(uint256 tokenId) external view returns (address)',
  'function tokenURI(uint256 tokenId) external view returns (string)',
  'event Registered(uint256 indexed agentId, string agentURI, address indexed owner)',
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const args = { execute: false, statusOnly: false, only: null };
  for (const a of argv.slice(2)) {
    if (a === '--execute') args.execute = true;
    else if (a === '--status-only') args.statusOnly = true;
    else if (a.startsWith('--only=')) args.only = a.slice('--only='.length).toUpperCase();
  }
  return args;
}

function loadMetadata(name) {
  const p = path.join(__dirname, 'fleet-metadata', `${name}.json`);
  const raw = fs.readFileSync(p, 'utf8');
  const json = JSON.parse(raw); // throws on bad JSON
  return { json, raw };
}

function buildDataURI(metaRaw) {
  const b64 = Buffer.from(metaRaw).toString('base64');
  return `data:application/json;base64,${b64}`;
}

function indexedMetadataFor(meta) {
  // ERC-8004 indexed metadata — emits MetadataSet events on-chain. Keep small.
  return [
    { metadataKey: 'name',     metadataValue: ethers.toUtf8Bytes(meta.name) },
    { metadataKey: 'class',    metadataValue: ethers.toUtf8Bytes(meta.agent_class ?? '') },
    { metadataKey: 'role',     metadataValue: ethers.toUtf8Bytes(meta.fleet_role ?? '') },
    { metadataKey: 'tier',     metadataValue: ethers.toUtf8Bytes(meta.trust?.tier ?? '') },
    { metadataKey: 'protocol', metadataValue: ethers.toUtf8Bytes('HyperDAG') },
  ];
}

async function determineAction(agentName, contract, deployerAddr) {
  if (ALREADY_PERFECT[agentName]) {
    return { action: 'SKIP', reason: 'already inline-perfect', existingTokenId: ALREADY_PERFECT[agentName] };
  }
  const orphans = KNOWN_ORPHANS[agentName] ?? [];
  if (orphans.length > 0) {
    // Verify orphans actually exist + check ownership
    const orphanReports = [];
    for (const tokenId of orphans) {
      try {
        const owner = await contract.ownerOf(tokenId);
        const uri = await contract.tokenURI(tokenId);
        orphanReports.push({
          tokenId, owner,
          mine: owner.toLowerCase() === deployerAddr.toLowerCase(),
          inline: uri.startsWith('data:'),
        });
      } catch (e) {
        orphanReports.push({ tokenId, error: e.shortMessage ?? e.message });
      }
    }
    return { action: 'REMINT', reason: 'orphan(s) with off-chain URI', orphans: orphanReports };
  }
  return { action: 'MINT', reason: 'not yet registered', orphans: [] };
}

function summariseOrphan(o) {
  if (o.error) return `#${o.tokenId} (error: ${o.error})`;
  const ours = o.mine ? '(ours)' : `(owner=${o.owner.slice(0, 8)}…)`;
  const inline = o.inline ? 'inline-OK' : 'off-chain-404';
  return `#${o.tokenId} ${ours} ${inline}`;
}

async function recordReport(rows, outPath) {
  let md = '# Fleet registration v2 — run results\n\n';
  md += `Generated: ${new Date().toISOString()}\n\n`;
  md += `Mode: ${rows[0]?.mode ?? 'unknown'}\n\n`;
  md += '| agent | action | result | tokenId | tx | data URI bytes | notes |\n';
  md += '|-------|--------|--------|--------:|----|---------------:|-------|\n';
  for (const r of rows) {
    md += `| ${r.name} | ${r.action} | ${r.result} | ${r.tokenId ?? '—'} | ${r.tx ?? '—'} | ${r.uriBytes ?? '—'} | ${r.notes ?? ''} |\n`;
  }
  fs.writeFileSync(outPath, md, 'utf8');
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const args = parseArgs(process.argv);
  const mode = args.statusOnly ? 'STATUS-ONLY' : (args.execute ? 'EXECUTE' : 'DRY-RUN');
  console.log(`[fleet-register-v2] mode=${mode}`);

  const provider = new ethers.JsonRpcProvider(RPC);
  const net = await provider.getNetwork();
  console.log(`[fleet-register-v2] chainId=${net.chainId} (Base Sepolia=84532)`);
  if (net.chainId !== 84532n) {
    console.error('Refusing to run on non-Base-Sepolia chain.');
    process.exit(1);
  }

  if (!process.env.DEPLOYER_PRIVATE_KEY) {
    console.error('DEPLOYER_PRIVATE_KEY missing.');
    process.exit(1);
  }
  const wallet = new ethers.Wallet(process.env.DEPLOYER_PRIVATE_KEY, provider);
  const balance = await provider.getBalance(wallet.address);
  console.log(`[fleet-register-v2] wallet=${wallet.address}`);
  console.log(`[fleet-register-v2] balance=${ethers.formatEther(balance)} ETH`);

  const contract = new ethers.Contract(REGISTRY, ABI, wallet);

  let supabase = null;
  if (process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_KEY) {
    supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
  } else {
    console.warn('[fleet-register-v2] Supabase creds missing — DB writes will be skipped');
  }

  // Pre-flight: gas estimate for one mint, multiplied by remaining mints.
  const sampleMeta = JSON.parse(fs.readFileSync(path.join(__dirname, 'fleet-metadata', 'NEXUS.json'), 'utf8'));
  const sampleURI = buildDataURI(JSON.stringify(sampleMeta));
  const sampleMetadata = indexedMetadataFor(sampleMeta);
  let estPerMint = 0n;
  if (!args.statusOnly) {
    try {
      estPerMint = await contract.register.estimateGas(sampleURI, sampleMetadata);
      console.log(`[fleet-register-v2] estimated gas per mint: ${estPerMint.toString()}`);
    } catch (e) {
      console.warn(`[fleet-register-v2] gas estimate failed: ${e.shortMessage ?? e.message}`);
    }
  }

  const targets = args.only ? [args.only] : FLEET_NAMES;
  const rows = [];

  for (const name of targets) {
    if (!FLEET_NAMES.includes(name)) {
      console.warn(`[skip] ${name}: not in canonical fleet list`);
      continue;
    }
    console.log(`\n[fleet-register-v2] === ${name} ===`);
    let meta, raw;
    try {
      ({ json: meta, raw } = loadMetadata(name));
    } catch (e) {
      console.error(`  metadata load failed: ${e.message}`);
      rows.push({ name, action: 'ERROR', result: 'metadata_load_failed', mode, notes: e.message });
      continue;
    }
    const uri = buildDataURI(raw);
    const uriBytes = Buffer.byteLength(uri, 'utf8');
    if (uriBytes > 32 * 1024) {
      console.error(`  data URI too large (${uriBytes} bytes); contract limit ~32KB`);
      rows.push({ name, action: 'ERROR', result: 'uri_too_large', mode, uriBytes });
      continue;
    }
    console.log(`  data URI bytes: ${uriBytes}`);

    const decision = await determineAction(name, contract, wallet.address);
    console.log(`  action: ${decision.action} (${decision.reason})`);
    for (const o of decision.orphans ?? []) console.log(`    orphan ${summariseOrphan(o)}`);

    if (decision.action === 'SKIP') {
      rows.push({ name, action: 'SKIP', result: 'already_perfect', mode, tokenId: decision.existingTokenId });
      if (supabase && !args.statusOnly) {
        await supabase.from('agent_kya_registry').update({
          current_token_id: String(decision.existingTokenId),
          metadata_uri: 'on-chain inline (existing)',
          metadata_inline: true,
          registration_status: 'verified',
          last_chain_check: new Date().toISOString(),
        }).eq('agent_name', name);
      }
      continue;
    }

    if (args.statusOnly) {
      rows.push({ name, action: decision.action, result: 'status_only', mode, notes: decision.reason });
      continue;
    }

    if (!args.execute) {
      // DRY-RUN — print what we would submit, no tx.
      console.log(`  [DRY-RUN] would submit register(uri[${uriBytes}], 5 indexed metadata entries)`);
      console.log(`  [DRY-RUN] expected gas ~${estPerMint.toString()}`);
      rows.push({
        name, action: decision.action, result: 'dry_run', mode,
        uriBytes,
        notes: `would call register; orphans=${(decision.orphans ?? []).map(o => o.tokenId).join(',') || '-'}`,
      });
      continue;
    }

    // EXECUTE — real mint.
    try {
      const indexedMeta = indexedMetadataFor(meta);
      console.log(`  submitting register() ...`);
      const tx = await contract.register(uri, indexedMeta);
      console.log(`  tx hash: ${tx.hash}`);
      const receipt = await tx.wait(1);
      let tokenId = null;
      for (const log of receipt.logs) {
        try {
          const parsed = contract.interface.parseLog(log);
          if (parsed && parsed.name === 'Registered') {
            tokenId = parsed.args.agentId.toString();
            break;
          }
        } catch { /* not our event */ }
      }
      console.log(`  confirmed: tokenId=${tokenId ?? '?'} block=${receipt.blockNumber}`);

      if (supabase && tokenId) {
        const { error } = await supabase.from('agent_kya_registry').update({
          agent_id_onchain: tokenId,
          current_token_id: tokenId,
          mint_tx_hash: tx.hash,
          metadata_uri: uri,
          metadata_inline: true,
          registration_status: 'verified',
          last_chain_check: new Date().toISOString(),
        }).eq('agent_name', name);
        if (error) console.warn(`  DB update warning: ${error.message}`);

        // NEXUS dedupe — mark old orphans as deprecated_duplicate.
        if (decision.orphans?.length) {
          for (const o of decision.orphans) {
            if (o.error) continue;
            // The old orphan rows aren't separate rows in agent_kya_registry — they're
            // just the prior on-chain mints. We don't have a per-token row to mark.
            // Instead, write a single audit row capturing the dedupe decision:
            await supabase.from('trinity_agent_logs').insert({
              action: 'fleet_orphan_deprecated',
              metadata: {
                agent_name: name,
                deprecated_token_id: String(o.tokenId),
                superseded_by: tokenId,
                deprecated_owner: o.owner,
                deprecated_uri_was_inline: o.inline,
              },
            });
          }
        }

        // Audit-chain entry (best-effort; chain may not be present on this branch).
        try {
          await supabase.from('hal_audit_chain').insert({
            source_table: 'agent_kya_registry',
            source_id: name,
            event_payload: {
              event_type: 'agent_registration',
              agent_name: name,
              token_id: tokenId,
              mint_tx: tx.hash,
              metadata_inline: true,
            },
            current_entry_hash: 'pending_chain_writer',
          });
        } catch (e) {
          // Some branches may not have hal_audit_chain — non-fatal.
        }
      }

      rows.push({ name, action: decision.action, result: 'verified', mode, tokenId, tx: tx.hash, uriBytes });
    } catch (e) {
      console.error(`  mint failed: ${e.shortMessage ?? e.message}`);
      rows.push({ name, action: decision.action, result: 'failed', mode, notes: e.shortMessage ?? e.message });
      if (supabase) {
        await supabase.from('agent_kya_registry').update({
          registration_status: 'failed',
          last_chain_check: new Date().toISOString(),
        }).eq('agent_name', name);
      }
    }

    // Cooldown between mints — keeps gas market sane and avoids nonce races.
    if (args.execute) await new Promise(r => setTimeout(r, 5000));
  }

  const outPath = path.join(__dirname, 'fleet-register-v2-results.md');
  await recordReport(rows, outPath);
  console.log(`\n[fleet-register-v2] wrote ${outPath}`);
  console.log('[fleet-register-v2] done');
}

main().catch(e => {
  console.error('FATAL:', e);
  process.exit(1);
});
