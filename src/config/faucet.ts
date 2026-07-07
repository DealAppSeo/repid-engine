/**
 * Faucet config — the "get testnet tokens" step of the E2E user journey.
 *
 * We do NOT run a custodial faucet. Users fund their own wallet from the PUBLIC
 * Base-Sepolia faucets; our job is to make that step frictionless + honest inside
 * the flow (point them at the right URLs, and let a read-only balance check confirm
 * when they have enough to stake).
 *
 * NO-LOCK-IN (E:\dev\living-docs\NO_LOCK_IN_INVARIANTS.md):
 *  - Chain / RPC / USDC token address are NOT defined here — they come from
 *    getActiveNetwork() (src/config/network.ts), which is fully env-overridable.
 *    A different chain/token slots in with no change to this file or the handlers.
 *  - Faucet URLs (the "on-ramp"/funding sources) are CONFIG here, env-overridable,
 *    so a different faucet/on-ramp aggregator slots in later (Invariant 5) without
 *    touching the route handlers. Ship ONE default path now; keep the seam open.
 */

/** A public faucet a user can go to for testnet funds. Honest + external — we don't dispense. */
export interface FaucetSource {
  /** Human label for the UI. */
  name: string;
  /** The public faucet URL. */
  url: string;
  /** Which asset(s) this faucet dispenses on the target chain. */
  assets: string[];
  /** Optional note (e.g. "requires Coinbase account", "0.05 ETH per drip"). */
  note?: string;
}

/**
 * Minimum on-chain stake, in ETH, per RepIDStaking.sol:
 *   uint256 public constant MIN_STAKE = 0.0001 ether;
 * Env-overridable so a contract redeploy with a different minimum doesn't require a code change.
 */
export const STAKING_MIN_ETH: string = process.env.REPID_STAKING_MIN_ETH?.trim() || '0.0001';

/**
 * Suggested balance (ETH) that also covers gas for the stake tx itself — a small buffer
 * above the bare minimum. Env-overridable. Kept in lockstep with check-testnet-balance.ts.
 */
export const STAKING_SUGGESTED_ETH: string = process.env.REPID_STAKING_SUGGESTED_ETH?.trim() || '0.001';

/**
 * Default public Base-Sepolia faucet sources. These are the real, current public faucets.
 * Override the whole list via the FAUCET_SOURCES_JSON env var (a JSON array of FaucetSource)
 * when the chain/faucet set changes — no code change needed (NO-LOCK-IN Invariant 5).
 */
const DEFAULT_FAUCET_SOURCES: FaucetSource[] = [
  {
    name: 'Coinbase Base Sepolia Faucet',
    url: 'https://www.coinbase.com/faucets/base-sepolia',
    assets: ['ETH', 'USDC'],
    note: 'Free Base Sepolia test ETH and USDC. Coinbase account recommended.',
  },
  {
    name: 'Base.org Sepolia Faucet',
    url: 'https://sepolia.base.org/faucet',
    assets: ['ETH'],
    note: 'Base-operated Sepolia ETH faucet.',
  },
  {
    name: 'Alchemy Base Sepolia Faucet',
    url: 'https://www.alchemy.com/faucets/base-sepolia',
    assets: ['ETH'],
    note: 'Requires a free Alchemy account.',
  },
];

/**
 * Resolve the faucet source list. Prefers FAUCET_SOURCES_JSON (env override) if it parses
 * to a non-empty array; otherwise returns the built-in default list. Malformed JSON falls
 * back to defaults with a loud warning (fail-loud, never silently drop the seam).
 */
export function getFaucetSources(): FaucetSource[] {
  const raw = process.env.FAUCET_SOURCES_JSON?.trim();
  if (!raw) return DEFAULT_FAUCET_SOURCES;
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed) && parsed.length > 0) {
      return parsed as FaucetSource[];
    }
    console.warn('[faucet] FAUCET_SOURCES_JSON parsed but was not a non-empty array; using defaults.');
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[faucet] FAUCET_SOURCES_JSON failed to parse (${msg}); using defaults.`);
  }
  return DEFAULT_FAUCET_SOURCES;
}
