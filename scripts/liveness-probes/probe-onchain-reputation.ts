/**
 * Probe: on-chain ERC-8004 reputation writes (Base Sepolia).
 * PASS: ≥1 new write in 24h.
 * RED: 0 (current expected state).
 */
import { getDb, ProbeResult } from './_shared';

export async function probeOnchainReputation(): Promise<ProbeResult> {
  const db = getDb();
  const since24h = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

  const { count: count24h } = await db
    .from('erc8004_reputation_writes').select('*', { count: 'exact', head: true })
    .gte('created_at', since24h);

  const { data: latest } = await db
    .from('erc8004_reputation_writes')
    .select('created_at, tx_hash')
    .order('created_at', { ascending: false }).limit(1).maybeSingle();

  return {
    name: 'onchain-reputation',
    status: (count24h ?? 0) >= 1 ? 'GREEN' : 'RED',
    metrics: {
      onchain_writes_24h: count24h ?? 0,
      last_write_at: (latest as any)?.created_at ?? null,
      last_tx_hash: (latest as any)?.tx_hash ?? null,
    },
  };
}

if (require.main === module) {
  probeOnchainReputation().then((r) => { console.log(JSON.stringify(r, null, 2)); process.exit(r.status === 'RED' ? 1 : 0); });
}
