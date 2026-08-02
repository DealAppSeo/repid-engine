/**
 * trust-receipt.ts — assemble the public, checkable record of one exchange.
 *
 * ONE definition, used by the public route and by `npm run demo:trust`. The
 * handler registries drifted for weeks because the same knowledge lived in two
 * places; a receipt that says something different depending on where you read
 * it would be worse than useless in a project about trust.
 *
 * WHAT IS DELIBERATELY NOT IN HERE
 * --------------------------------
 * The contract `payload` and `result`. Those carry the actual work — a
 * question someone asked and the answer they paid for — and this endpoint is
 * PUBLIC and unauthenticated. Everything included below is either already
 * on-chain and world-readable, or is a fact ABOUT the exchange (who, how much,
 * what the verifiers concluded) rather than its content.
 *
 * Every claim is either backed by a row or reported as unknown. Nothing is
 * inferred from proximity in time.
 */
import { db } from '../db';

export interface TrustReceipt {
  contract_id: string;
  settled_at: string | null;
  price_usdc: string;
  price_raw: number;
  buyer: string;
  provider: string;
  /** Negotiation, when the contract came from an RFQ rather than a fixed listing. */
  negotiated: boolean;
  competing_bids: number | null;
  won_on_price: boolean | null;
  uncontested: boolean | null;
  /** The x402 settlement. is_simulated=false is the only version that counts. */
  settlement_tx: string | null;
  settlement_url: string | null;
  is_simulated: boolean | null;
  /**
   * Did the money move BEFORE the work was delivered?
   *
   * The whole claim of this receipt is "paid only after verified delivery", and
   * that claim is not true of every exchange in the table. Contracts settled
   * before 2026-08-01 paid at ESCROW: 18dd4e05 settled at 04:32:31.72 and was
   * fulfilled at 04:33:23.54 — 52 seconds LATER. Deferred settlement landed on
   * 2026-08-01; exchanges after it settle after fulfilment.
   *
   * So the ordering is read from the timestamps per exchange rather than
   * asserted by the template. null = not enough data to say, which is also not
   * a licence to tell the flattering version.
   */
  paid_before_delivery: boolean | null;
  reputation_events: Array<{ agent: string; event: string; delta: number; from: number; to: number }>;
  /** ERC-8004. Present only when PROVABLY caused by this contract. */
  onchain_tx: string | null;
  onchain_url: string | null;
  onchain_repid: number | null;
  onchain_link_is_proven: boolean;
  zk_proofs: Array<{ scheme: string | null; is_real: boolean | null; statement: unknown }>;
  /**
   * ZK BIND T1. Commits this exchange's immutable facts. Recomputable by anyone
   * from the receipt (see services/work-statement.ts) — a mismatch means the
   * contract was edited after settlement.
   *
   * It binds a proof to THIS work. It does NOT assert the work is correct.
   */
  work_statement_hash: string | null;
  /** Anything we could not establish, stated rather than omitted. */
  caveats: string[];
}

const scan = (tx: string) => `https://sepolia.basescan.org/tx/${tx}`;

export async function buildTrustReceipt(contractId: string): Promise<TrustReceipt | null> {
  const { data: c } = await db
    .from('service_contracts')
    .select('id, status, agreed_price_usdc_raw, buyer_agent_id, provider_agent_id, settled_at, fulfilled_at, work_statement_hash')
    .eq('id', contractId)
    .maybeSingle();
  if (!c) return null;

  const caveats: string[] = [];
  if (c.status !== 'settled') caveats.push(`This contract is '${c.status}', not settled — the loop did not complete.`);

  const names: Record<string, string> = {};
  for (const id of [c.buyer_agent_id, c.provider_agent_id]) {
    const { data } = await db.from('repid_agents').select('agent_name').eq('id', id).maybeSingle();
    names[id] = data?.agent_name ?? String(id).slice(0, 8);
  }

  const { data: settlement } = await db
    .from('x402_settlements')
    .select('tx_hash, is_simulated, status, created_at, delivered_at')
    .eq('idempotency_key', contractId)
    .maybeSingle();
  if (settlement && settlement.is_simulated) {
    caveats.push('This settlement was SIMULATED — no money actually moved.');
  }
  if (!settlement) caveats.push('No x402 settlement is on record for this contract.');

  // Read the pay-vs-deliver ordering from the row instead of letting the template
  // assert it. See TrustReceipt.paid_before_delivery.
  //
  // WHICH TIMESTAMP IS "WHEN THE MONEY MOVED". `created_at` is when the
  // settlement ROW was written, which under deferred settlement is escrow time —
  // the moment the EIP-3009 authorization was taken, when nothing has moved yet.
  // `delivered_at` is stamped at the instant the transfer is actually broadcast
  // (x402-deferred-settlement.ts, the same update that sets tx_hash).
  //
  // Using created_at made the receipt report pay-up-front for exactly the
  // exchanges that correctly paid on delivery — the mirror image of #299, which
  // claimed pay-on-delivery for exchanges that had paid up front. Verified on a
  // live pair: an immediate-settle run had created_at 18:12:20.803 /
  // delivered_at 18:12:20.789 (same instant, genuinely paid first), while a
  // deferred run had created_at 18:32:53 / delivered_at 18:34:08 against a
  // fulfilled_at of 18:33:20 — money 48s AFTER delivery, reported as before it.
  //
  // Fall back to created_at when delivered_at is null: rows written before the
  // deferred path existed settled on creation, so for those the two coincide.
  const paidAtRaw = settlement?.delivered_at ?? settlement?.created_at ?? null;
  let paid_before_delivery: boolean | null = null;
  if (paidAtRaw && c.fulfilled_at) {
    const paidAt = new Date(paidAtRaw);
    const deliveredAt = new Date(c.fulfilled_at);
    paid_before_delivery = paidAt < deliveredAt;
    if (paid_before_delivery) {
      caveats.push(
        'The money moved BEFORE delivery on this exchange. Payment settled at escrow, ' +
        `${Math.round((deliveredAt.getTime() - paidAt.getTime()) / 1000)}s ` +
        'before the work was fulfilled — so this receipt does NOT show payment gated on verified delivery. ' +
        'Deferred settlement landed 2026-08-01; exchanges after that date hold the authorisation until delivery is verified.',
      );
    }
  } else if (settlement) {
    caveats.push('Cannot establish whether payment preceded delivery — one of the two timestamps is missing.');
  }

  const { data: award } = await db
    .from('a2a_awards')
    .select('competing_bid_count, was_lowest_price, is_uncontested')
    .eq('contract_id', contractId)
    .maybeSingle();

  const { data: events } = await db
    .from('repid_score_events')
    .select('agent_id, event_type, delta, repid_before, repid_after')
    .eq('contract_id', contractId)
    .order('created_at');

  // Only a PROVEN link. contract_id was promoted out of event_data on
  // 2026-08-01; before that this could only be guessed from timing, and a
  // guess presented as a receipt is the exact failure this project exists to
  // prevent.
  const { data: onchain } = await db
    .from('erc8004_reputation_writes')
    .select('tx_hash, repid_value')
    .eq('contract_id', contractId)
    .order('created_at', { ascending: false })
    .maybeSingle();
  if (!c.work_statement_hash) {
    caveats.push('No work-statement binding recorded — this exchange settled before ZK BIND T1, so no proof is committed to it.');
  }
  if (!onchain) {
    caveats.push('No ERC-8004 write is provably linked to this contract. Writes made before 2026-08-01 did not record which contract caused them.');
  }

  const { data: proofs } = await db
    .from('repid_zkp_proofs')
    .select('scheme, is_real, statement')
    .eq('contract_id', contractId)
    .limit(3);

  return {
    contract_id: c.id,
    settled_at: c.settled_at ?? null,
    price_usdc: `$${(Number(c.agreed_price_usdc_raw) / 1e6).toFixed(2)}`,
    price_raw: Number(c.agreed_price_usdc_raw),
    buyer: names[c.buyer_agent_id]!,
    provider: names[c.provider_agent_id]!,
    negotiated: !!award,
    competing_bids: award?.competing_bid_count ?? null,
    won_on_price: award?.was_lowest_price ?? null,
    uncontested: award?.is_uncontested ?? null,
    settlement_tx: settlement?.tx_hash ?? null,
    settlement_url: settlement?.tx_hash ? scan(settlement.tx_hash) : null,
    is_simulated: settlement?.is_simulated ?? null,
    paid_before_delivery,
    reputation_events: (events ?? []).map((e) => ({
      agent: names[e.agent_id] ?? String(e.agent_id).slice(0, 8),
      event: e.event_type,
      delta: e.delta,
      from: e.repid_before,
      to: e.repid_after,
    })),
    onchain_tx: onchain?.tx_hash ?? null,
    onchain_url: onchain?.tx_hash ? scan(onchain.tx_hash) : null,
    onchain_repid: onchain?.repid_value ?? null,
    onchain_link_is_proven: !!onchain,
    zk_proofs: (proofs ?? []).map((p) => ({ scheme: p.scheme, is_real: p.is_real, statement: p.statement })),
    work_statement_hash: c.work_statement_hash ?? null,
    caveats,
  };
}

/** The most recent exchange that genuinely completed with real money. */
export async function latestRealSettledContractId(): Promise<string | null> {
  const { data } = await db
    .from('x402_settlements')
    .select('idempotency_key')
    .eq('status', 'settled')
    .eq('is_simulated', false)
    .not('tx_hash', 'is', null)
    .order('created_at', { ascending: false })
    .limit(25);

  for (const s of data ?? []) {
    const { data: c } = await db
      .from('service_contracts')
      .select('id, status')
      .eq('id', s.idempotency_key)
      .maybeSingle();
    if (c?.status === 'settled') return c.id;
  }
  return null;
}
