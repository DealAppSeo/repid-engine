/**
 * Boots the engine's own modules for the arena in LOCAL_MODE and installs the egress tripwire.
 *
 * src/config.ts and src/db.ts read the environment when they LOAD, so the environment is fixed first
 * and the engine is required afterwards (as scripts/e2e-local/receipt-loop.ts does). Everything the
 * arena measures runs on the engine's real code: the kernel (src/kernel), the x402 authority gate
 * (src/services/x402-gate.ts) and the RepID delta functions (src/services/validation-repid-delta.ts).
 * Nothing in src/ is modified.
 *
 * Idempotent: a second call returns the first boot. One process = one LOCAL_MODE store.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export interface Egress {
  local: number;
  blocked: string[];
}

export interface Engine {
  db: any;
  delta: typeof import('../../../src/services/validation-repid-delta');
  gate: typeof import('../../../src/services/x402-gate');
  kernel: {
    runUnderKernel: typeof import('../../../src/kernel/gate').runUnderKernel;
    dryDecision: typeof import('../../../src/kernel/gate').dryDecision;
    StoreLedger: typeof import('../../../src/kernel/store').StoreLedger;
    createJsonlStore: typeof import('../../../src/kernel/store').createJsonlStore;
    POLICY_DOMAIN: typeof import('../../../src/kernel/policy').POLICY_DOMAIN;
    POLICY_TYPES: typeof import('../../../src/kernel/policy').POLICY_TYPES;
    policyTypedValue: typeof import('../../../src/kernel/policy').policyTypedValue;
  };
  egress: Egress;
  storeDir: string;
}

let booted: Engine | null = null;

export function bootEngine(): Engine {
  if (booted) return booted;

  // 1 — environment BEFORE the engine modules load. No secret of any kind survives into this process.
  process.env.LOCAL_MODE = 'true';
  process.env.ONLY_ATTESTATIONS_LEAVE = 'true';
  process.env.ZKP_SERVICE_URL = 'http://127.0.0.1:9'; // a proof call, if one is made, fails locally and is logged
  const storeDir = mkdtempSync(join(tmpdir(), 'repid-arena-'));
  process.env.LOCAL_STORE_PATH = join(storeDir, 'repid.db');
  for (const k of Object.keys(process.env)) {
    if (/^SUPABASE_|^ERC8004_|PRIVATE_KEY|_RPC_URL$|^DATABASE_URL$/.test(k)) delete process.env[k];
  }

  // 2 — egress tripwire, before any client exists. A non-local host throws and is recorded.
  const { isLocalHost } = require('../../../src/selfhost/egress-guard');
  const egress: Egress = { local: 0, blocked: [] };
  const realFetch = global.fetch;
  (global as any).fetch = (input: any, init?: any) => {
    const url = typeof input === 'string' ? input : input?.url ?? String(input);
    if (!isLocalHost(url)) {
      egress.blocked.push(url);
      throw new Error(`EGRESS VIOLATION: ${url}`);
    }
    egress.local++;
    return (realFetch as any)(input, init);
  };

  // 3 — the engine, unmodified.
  const { db } = require('../../../src/db');
  const kg = require('../../../src/kernel/gate');
  const ks = require('../../../src/kernel/store');
  const kp = require('../../../src/kernel/policy');
  booted = {
    db,
    delta: require('../../../src/services/validation-repid-delta'),
    gate: require('../../../src/services/x402-gate'),
    kernel: {
      runUnderKernel: kg.runUnderKernel,
      dryDecision: kg.dryDecision,
      StoreLedger: ks.StoreLedger,
      createJsonlStore: ks.createJsonlStore,
      POLICY_DOMAIN: kp.POLICY_DOMAIN,
      POLICY_TYPES: kp.POLICY_TYPES,
      policyTypedValue: kp.policyTypedValue,
    },
    egress,
    storeDir,
  };
  return booted;
}
