/**
 * probe-provider-keys.ts — is each LLM provider key ALIVE, not merely PRESENT?
 *
 * A key can be set everywhere and still be dead. HUGGINGFACE_API_TOKEN was
 * present in .env.master AND on the deployed service while HuggingFace answered
 * "not supported by any provider you have enabled" — an entitlement failure, not
 * auth. Every presence check said fine; it took the whole LLM broker down (503)
 * because the dead provider sat at the cheapest tier. Presence-based filtering
 * cannot catch that class at all. So: probe, don't check.
 *
 * It also cost real time the other way round. A stale GROQ key made the
 * golden-math tripwire fail, and the failure looked exactly like a drop in math
 * accuracy. Knowing which keys are dead BEFORE reading a quality result is the
 * difference between a five-minute fix and an afternoon hunting a scoring bug.
 *
 * SECRETS DISCIPLINE — this script prints key NAMES and STATUS. It never prints,
 * logs, or writes a key VALUE, not even a prefix. Read it before trusting it.
 *
 * This is also the primitive BYOK needs: before storing a user's provider key we
 * must know it works, or we accept a key that fails on their first real call and
 * teaches them the product is broken.
 *
 *   npx ts-node scripts/liveness-probes/probe-provider-keys.ts
 *   npx ts-node scripts/liveness-probes/probe-provider-keys.ts --json
 *
 * Exit code is 0 even with dead keys — this reports, it does not gate. An
 * INCONCLUSIVE result (network/timeout) is never reported as DEAD: recommending
 * a rotation off a flaky probe is how you burn a working key and an afternoon.
 */
import { readFileSync } from 'fs';
import { resolve } from 'path';

type Status = 'LIVE' | 'DEAD' | 'INCONCLUSIVE' | 'ABSENT';

interface Probe {
  /** Env var name. Values are read from it and never emitted. */
  env: string;
  /** The independent model family this key buys, for HAL quorum width. */
  family: string;
  url: string;
  /** Builds headers from the key. */
  headers: (key: string) => Record<string, string>;
  /** Cheapest call that proves the credential works. */
  body?: (model: string) => unknown;
  model?: string;
}

/**
 * The FAMILY column is the point. HAL counts distinct families, not hosts — two
 * Llama endpoints are one vote, not two (fact-check.ts R5). A dead key does not
 * just cost a provider, it can collapse the quorum width below the width an
 * accuracy claim was measured at.
 */
const PROBES: Probe[] = [
  { env: 'GROQ_API_KEY', family: 'llama', url: 'https://api.groq.com/openai/v1/models', headers: (k) => ({ Authorization: `Bearer ${k}` }) },
  { env: 'CEREBRAS_API_KEY', family: 'llama', url: 'https://api.cerebras.ai/v1/models', headers: (k) => ({ Authorization: `Bearer ${k}` }) },
  { env: 'GEMINI_API_KEY', family: 'gemini', url: 'https://generativelanguage.googleapis.com/v1beta/models', headers: (k) => ({ 'x-goog-api-key': k }) },
  { env: 'DEEPSEEK_API_KEY', family: 'deepseek', url: 'https://api.deepseek.com/models', headers: (k) => ({ Authorization: `Bearer ${k}` }) },
  { env: 'MISTRAL_API_KEY', family: 'mistral', url: 'https://api.mistral.ai/v1/models', headers: (k) => ({ Authorization: `Bearer ${k}` }) },
  { env: 'GROK_API_KEY', family: 'grok', url: 'https://api.x.ai/v1/models', headers: (k) => ({ Authorization: `Bearer ${k}` }) },
  { env: 'ANTHROPIC_API_KEY', family: 'claude', url: 'https://api.anthropic.com/v1/models', headers: (k) => ({ 'x-api-key': k, 'anthropic-version': '2023-06-01' }) },
  { env: 'OPENAI_API_KEY', family: 'gpt', url: 'https://api.openai.com/v1/models', headers: (k) => ({ Authorization: `Bearer ${k}` }) },
  { env: 'FIREWORKS_API_KEY', family: 'mixed', url: 'https://api.fireworks.ai/inference/v1/models', headers: (k) => ({ Authorization: `Bearer ${k}` }) },
  { env: 'DEEPINFRA_API_KEY', family: 'mixed', url: 'https://api.deepinfra.com/v1/openai/models', headers: (k) => ({ Authorization: `Bearer ${k}` }) },
  { env: 'OPENROUTER_API_KEY', family: 'mixed', url: 'https://openrouter.ai/api/v1/models', headers: (k) => ({ Authorization: `Bearer ${k}` }) },
  { env: 'COHERE_API_KEY', family: 'cohere', url: 'https://api.cohere.com/v1/models', headers: (k) => ({ Authorization: `Bearer ${k}` }) },
  { env: 'HUGGINGFACE_API_TOKEN', family: 'mixed', url: 'https://huggingface.co/api/whoami-v2', headers: (k) => ({ Authorization: `Bearer ${k}` }) },
];

/** Reads .env.master WITHOUT importing it into process.env, so nothing downstream can leak it. */
function loadMasterEnv(path: string): Record<string, string> {
  const out: Record<string, string> = {};
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    return out;
  }
  for (const line of raw.split(/\r?\n/)) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line);
    if (!m) continue;
    const [, name, rest] = m;
    out[name!] = (rest ?? '').trim().replace(/^["']|["']$/g, '');
  }
  return out;
}

async function probeOne(p: Probe, key: string | undefined): Promise<{ status: Status; detail: string }> {
  if (!key) return { status: 'ABSENT', detail: 'not set' };

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 12_000);
  try {
    const res = await fetch(p.url, { headers: p.headers(key), signal: ctrl.signal });
    if (res.ok) return { status: 'LIVE', detail: `HTTP ${res.status}` };

    // 401/403 is the credential itself being rejected — that is a real DEAD.
    if (res.status === 401 || res.status === 403) {
      return { status: 'DEAD', detail: `HTTP ${res.status} — credential rejected` };
    }
    // 402/429 mean the key is VALID and the account is out of money or over
    // quota. Reporting those as DEAD would send someone to rotate a good key.
    if (res.status === 402) return { status: 'LIVE', detail: 'HTTP 402 — key valid, account unfunded' };
    if (res.status === 429) return { status: 'LIVE', detail: 'HTTP 429 — key valid, rate limited' };
    return { status: 'INCONCLUSIVE', detail: `HTTP ${res.status}` };
  } catch (e) {
    // Network, DNS, TLS, timeout. NOT evidence about the key.
    return { status: 'INCONCLUSIVE', detail: (e as Error)?.name === 'AbortError' ? 'timeout 12s' : 'network error' };
  } finally {
    clearTimeout(timer);
  }
}

async function main() {
  const asJson = process.argv.includes('--json');
  const master = loadMasterEnv(resolve(process.cwd(), '..', '.env.master'));
  // Process env wins: it is what a deployed service would actually use.
  const keyFor = (name: string) => process.env[name] || master[name];

  const results = await Promise.all(
    PROBES.map(async (p) => {
      const { status, detail } = await probeOne(p, keyFor(p.env));
      return { key: p.env, family: p.family, status, detail };
    }),
  );

  if (asJson) {
    console.log(JSON.stringify({ probed_at: new Date().toISOString(), results }, null, 2));
    return;
  }

  const pad = Math.max(...results.map((r) => r.key.length));
  const mark: Record<Status, string> = { LIVE: '  LIVE', DEAD: '  DEAD', INCONCLUSIVE: '  ????', ABSENT: 'ABSENT' };
  console.log('\nProvider key liveness — probed, not presence-checked. Values never printed.\n');
  for (const r of results) {
    console.log(`  ${mark[r.status]}  ${r.key.padEnd(pad)}  ${r.family.padEnd(8)}  ${r.detail}`);
  }

  // The number that actually matters for HAL: how many INDEPENDENT families are
  // reachable. Quorum counts families, so 5 live keys across 2 families is a
  // 2-family fleet, and any accuracy claim measured wider than that is unreadable.
  const liveFamilies = new Set(results.filter((r) => r.status === 'LIVE' && r.family !== 'mixed').map((r) => r.family));
  console.log(`\n  Independent families reachable: ${liveFamilies.size} [${[...liveFamilies].sort().join(', ')}]`);
  console.log('  (\'mixed\' hosts are excluded — they resell several families and cannot be counted as one independent vote.)');

  const dead = results.filter((r) => r.status === 'DEAD');
  const unsure = results.filter((r) => r.status === 'INCONCLUSIVE');
  if (dead.length) console.log(`\n  DEAD (credential rejected — safe to rotate): ${dead.map((d) => d.key).join(', ')}`);
  if (unsure.length) console.log(`  INCONCLUSIVE (do NOT rotate on this evidence): ${unsure.map((d) => d.key).join(', ')}`);
  console.log('');
}

main().catch((e) => {
  console.error('probe failed:', (e as Error)?.message ?? String(e));
  process.exit(1);
});
