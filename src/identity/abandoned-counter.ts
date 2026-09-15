/**
 * C10 A5 — mint-origin carried onto the custodian so abandoned is attributable.
 * Without the carry, the abandoned counter is decorative.
 */
export type OriginStatus = 'minted' | 'claimed' | 'abandoned';

export interface OriginRow {
  agent_id: string;
  custodian_id: string | null;
  /** false = minted before this custodian existed (pre-registration). */
  minted_at_registration: boolean;
  status: OriginStatus;
}

/** Birth: a mint with no custodian is abandoned until claimed. */
export function originAtMint(agentId: string, custodianId: string | null): OriginRow {
  return {
    agent_id: agentId,
    custodian_id: custodianId,
    minted_at_registration: custodianId != null,
    status: custodianId ? 'minted' : 'abandoned',
  };
}

/**
 * Registration carry: pre-registration mints (orphans) attach to the new
 * custodian. Abandoned stays abandoned — the count is theirs, not erased.
 */
export function carryOriginsOntoCustodian(custodianId: string, orphans: OriginRow[]): OriginRow[] {
  return orphans.map((o) => ({
    ...o,
    custodian_id: custodianId,
    minted_at_registration: false,
  }));
}

export function abandonedCountsByCustodian(rows: OriginRow[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const r of rows) {
    if (r.status !== 'abandoned' || !r.custodian_id) continue;
    out[r.custodian_id] = (out[r.custodian_id] ?? 0) + 1;
  }
  return out;
}
