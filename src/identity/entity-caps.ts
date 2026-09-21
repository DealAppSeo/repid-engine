/**
 * entity-caps.ts — LOOP C10. Caps are CONFIG, not schema.
 * Raising a cap is a JSON edit, never a migration.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { AgentKind } from './kind-custody';

export type DisplayTier = 'Bronze' | 'Silver' | 'Gold' | 'Platinum';

export interface EntityCapsConfig {
  ladder: number[];
  defaultRung: number;
  unclaimedCeiling: DisplayTier;
  displayTiers: DisplayTier[];
  claimInheritsPercent: number;
  transferVests: boolean;
}

const DEFAULTS: EntityCapsConfig = {
  ladder: [3, 7, 12, 21],
  defaultRung: 0,
  unclaimedCeiling: 'Bronze',
  displayTiers: ['Bronze', 'Silver', 'Gold', 'Platinum'],
  claimInheritsPercent: 100,
  transferVests: true,
};

let cached: EntityCapsConfig | null = null;

export function loadEntityCaps(configPath?: string): EntityCapsConfig {
  const candidates = [
    configPath,
    process.env.ENTITY_CAPS_PATH,
    resolve(__dirname, '../config/entity-caps.json'),
    resolve(process.cwd(), 'src/config/entity-caps.json'),
  ].filter((x): x is string => !!x);
  let raw: Partial<EntityCapsConfig> | null = null;
  for (const p of candidates) {
    try {
      raw = JSON.parse(readFileSync(p, 'utf8')) as Partial<EntityCapsConfig>;
      break;
    } catch {
      /* try next */
    }
  }
  try {
    if (!raw) throw new Error('no caps config');
    cached = {
      ...DEFAULTS,
      ...raw,
      ladder: Array.isArray(raw.ladder) && raw.ladder.length ? raw.ladder.map(Number) : DEFAULTS.ladder,
    };
    return cached;
  } catch {
    cached = { ...DEFAULTS, ladder: DEFAULTS.ladder.slice() };
    return cached;
  }
}

export function resetEntityCapsCache(): void {
  cached = null;
}

export function capsConfig(): EntityCapsConfig {
  return cached ?? loadEntityCaps();
}

export function capAtRung(rung: number, cfg = capsConfig()): number {
  const i = Math.max(0, Math.min(cfg.ladder.length - 1, Math.floor(rung)));
  return cfg.ladder[i]!;
}

export interface CustodianCapState {
  custodian_id: string;
  rung: number;
  abt_count: number;
}

export class CapExceededError extends Error {
  constructor(
    public readonly custodian_id: string,
    public readonly rung: number,
    public readonly cap: number,
  ) {
    super(`cap_exceeded: custodian=${custodian_id} rung=${rung} cap=${cap}`);
    this.name = 'CapExceededError';
  }
}

export function assertCanMintAbt(state: CustodianCapState, cfg = capsConfig()): void {
  const cap = capAtRung(state.rung, cfg);
  if (state.abt_count >= cap) {
    throw new CapExceededError(state.custodian_id, state.rung, cap);
  }
}

/** Slash drops one rung. Anti-Sybil headline — not a 10% bleed. */
export function slashRung(state: CustodianCapState): CustodianCapState {
  return { ...state, rung: Math.max(0, state.rung - 1) };
}

export function stepUpRung(state: CustodianCapState, cfg = capsConfig()): CustodianCapState {
  return { ...state, rung: Math.min(cfg.ladder.length - 1, state.rung + 1) };
}

/**
 * Unclaimed DBT cannot display above Bronze regardless of internal score.
 * Claim unlocks Silver+. Internal current_repid is not mutated.
 */
export function displayTier(params: {
  kind: AgentKind;
  currentRepid: number;
  cfg?: EntityCapsConfig;
}): DisplayTier {
  const cfg = params.cfg ?? capsConfig();
  if (params.kind === 'DBT') return cfg.unclaimedCeiling;
  if (params.currentRepid >= 8000) return 'Platinum';
  if (params.currentRepid >= 5000) return 'Gold';
  if (params.currentRepid >= 1000) return 'Silver';
  return 'Bronze';
}

export interface ClaimResult {
  score_after: number;
  inherited_percent: number;
  vested: boolean;
}

/** Claim inherits 100% of earned score. Transfer vests (does not inherit 100%). */
export function applyClaimOrTransfer(params: {
  earnedScore: number;
  kind: 'claim' | 'transfer';
  cfg?: EntityCapsConfig;
}): ClaimResult {
  const cfg = params.cfg ?? capsConfig();
  if (params.kind === 'claim') {
    const pct = cfg.claimInheritsPercent;
    return {
      score_after: Math.round((params.earnedScore * pct) / 100),
      inherited_percent: pct,
      vested: false,
    };
  }
  // Transfer vests: score does not follow 100%. Conservative: 0 until a vest
  // schedule exists. The important property is claim ≠ transfer.
  return { score_after: 0, inherited_percent: 0, vested: true };
}
