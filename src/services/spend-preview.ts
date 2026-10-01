/**
 * Fixed spend-preview fixture. Rates are 50 and 100 USDC.
 * eth and cbbtc are fixture numbers, not a quote.
 * The response names the wallet and the agent.
 * applied stays false. sends_eth stays false.
 * A visible cap is not a transfer. An unbound agent is denied.
 * This module sends nothing, inserts nothing, and does not read a stake row.
 */

export const SPEND_PREVIEW_FIXTURE_RATES = [50, 100] as const;

export const SPEND_PREVIEW_VISIBLE_CAP = 100;

export const SPEND_PREVIEW_ASSET_FIXTURE = [
  { usdc: 50, eth: 1, cbbtc: 1 },
  { usdc: 100, eth: 2, cbbtc: 2 },
] as const;

export interface SpendPreviewParty {
  wallet?: unknown;
  agent?: unknown;
  /** True only for the exact boolean true or the exact string `true`. */
  bound?: unknown;
}

export interface SpendPreview {
  rates: readonly [50, 100];
  assets: readonly { usdc: 50 | 100; eth: number; cbbtc: number }[];
  wallet: string;
  agent: string;
  cap: typeof SPEND_PREVIEW_VISIBLE_CAP;
  spend: 'deny' | 'preview';
  reason: 'unbound_agent' | 'cap_visible';
  applied: false;
  persisted: false;
  sends_eth: false;
}

function partyName(value: unknown): string {
  if (typeof value !== 'string') return 'NOT_CHECKED';
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : 'NOT_CHECKED';
}

function isBound(value: unknown): boolean {
  return value === true || value === 'true';
}

/**
 * stakeRows is the fixture stake table. Omit it, pass null, or pass [] when no
 * stake row exists. A row in that list still does not apply a spend or send ETH.
 * party names the wallet and the agent. An unbound agent is denied.
 * The cap stays visible either way and does not transfer.
 */
export function previewSpendFixture(
  _stakeRows: readonly unknown[] | null = null,
  party: SpendPreviewParty = {},
): SpendPreview {
  const wallet = partyName(party.wallet);
  const agent = partyName(party.agent);
  const named = wallet !== 'NOT_CHECKED' && agent !== 'NOT_CHECKED';
  const unbound = !(named && isBound(party.bound));
  return {
    rates: SPEND_PREVIEW_FIXTURE_RATES,
    assets: SPEND_PREVIEW_ASSET_FIXTURE,
    wallet,
    agent,
    cap: SPEND_PREVIEW_VISIBLE_CAP,
    spend: unbound ? 'deny' : 'preview',
    reason: unbound ? 'unbound_agent' : 'cap_visible',
    applied: false,
    persisted: false,
    sends_eth: false,
  };
}
