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
import { getAddress } from 'ethers';
import { db } from '../db';
import { proofOfPaymentFrom } from './erc8004-feedback-file';

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
   * WHO PAID WHOM, AS THE SETTLEMENT RECORD SAYS (2026-10-14): `payer_address`, and the payee (`to`) of
   * the x402 authorization the payer signed, read through the same proofOfPaymentFrom the ERC-8004
   * feedback file uses. Checksummed.
   *
   * WHAT THIS IS NOT (XC1 review of #1386): this route does NOT re-read the chain. The engine's own
   * Transfer-log check (assessPayment, erc8004-feedback-verify.ts) is not run here, so these are the
   * engine's RECORD of who paid whom, not a proof that the settlement tx moved USDC between them.
   * `wallets_source: 'settlement_record'` says so in the data. The check is external by design: the
   * trustshell acceptance gate reads the settlement tx's USDC Transfer from/to on chain and requires
   * them to equal these. The addresses are not secret: if the record is true they are already public as
   * that Transfer's from/to. `null` (both) when the row does not name a real payment from a named payer
   * to a named payee (no settlement, simulated, no tx, or a legacy row missing either field): never
   * guessed, and a caveat says so. The signed authorization itself (`x_payment_header`) is NOT published.
   */
  payer_wallet: string | null;
  payee_wallet: string | null;
  /** Where the two wallets come from: always the settlement record, never a chain read on this route. */
  wallets_source: 'settlement_record' | null;
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
  /**
   * The reputation movement this exchange caused, decomposed far enough to be
   * checked from outside.
   *
   * `from`/`to`/`delta` alone are NOT a closed accounting. The engine writes
   * `repid_before` PRE-decay and `repid_after` as clamp(decayed + delta), so
   * two things move a score without ever appearing in `delta`: decay, and the
   * [10, 10000] clamp. A reader comparing `to - from` against `delta` is really
   * testing whether decay happened to be zero — and on the one occasion it is
   * not, would call an honest row a forgery.
   *
   * `decay` is therefore published alongside, and is `null` — never 0 — when no
   * writer recorded it. See the mapping below for why that distinction is the
   * load-bearing part.
   */
  reputation_events: Array<{
    agent: string;
    event: string;
    delta: number;
    from: number;
    to: number;
    /** Points removed by decay before the delta applied. `null` = not recorded, which is not 0. */
    decay: number | null;
  }>;
  /** ERC-8004. Present only when PROVABLY caused by this contract. */
  onchain_tx: string | null;
  onchain_url: string | null;
  onchain_repid: number | null;
  onchain_link_is_proven: boolean;
  /**
   * The Plonky3 proofs minted for this exchange's score events. Linked two ways, both exact:
   * `repid_zkp_proofs.contract_id`, or the job id the score event recorded
   * (`repid_score_events.zk_proof_id` = `repid_zkp_proofs.job_id`). The second is what links every
   * proof minted before 2026-10-16, when nothing carried contract_id onto the proof row.
   *
   * What a proof proves: the agent's RepID was at least `threshold` (a range check over
   * `statement`). It does NOT prove the work was done or correct. `work_statement_hash` is the
   * contract hash recorded beside the proof (provenance), not an input the proof commits to.
   * `proof_url` serves the bytes and a server-side verification with no API key.
   */
  zk_proofs: Array<{
    job_id: string | null;
    agent: string | null;
    scheme: string | null;
    is_real: boolean | null;
    statement: unknown;
    eas_attestation_uid: string | null;
    work_statement_hash: string | null;
    proof_url: string | null;
  }>;
  /**
   * ZK BIND T1. Commits this exchange's immutable facts. Recomputable by anyone
   * from the receipt (see services/work-statement.ts) — a mismatch means the
   * contract was edited after settlement.
   *
   * It binds a proof to THIS work. It does NOT assert the work is correct.
   */
  work_statement_hash: string | null;
  /**
   * THE PREIMAGE OF THE HASH ABOVE. Published so the receipt is checkable by
   * someone who does not have the database.
   *
   * Until this was added the receipt carried a hash and NOTHING to recompute it
   * from — `work_statement_hash` with no `work_statement`. A digest whose
   * preimage is withheld is not evidence; it is an assertion wearing evidence's
   * clothes, which is the exact failure this receipt exists to avoid.
   *
   * Safe to publish: this is the agreed SPEC (deliverable, numbered acceptance
   * criteria, price, deadline) — the terms both parties bound themselves to. The
   * request payload and the delivered result are NOT here and never should be.
   */
  work_statement: unknown | null;
  /**
   * Per-criterion met/not-met, published for the same reason.
   *
   * `buyer_satisfaction_score` is derived by the database as
   * `round(met_count / n_criteria, 4)` and a client-supplied value that
   * disagrees is refused. Publishing the ratings turns that from a promise into
   * something an outsider can re-derive.
   */
  criterion_ratings: unknown | null;
  /** The derived score, so the derivation above can be checked against it. */
  buyer_satisfaction_score: number | null;
  /**
   * Who checked the work, as far as the record says. The validators are read from
   * `service_contracts.result->validators` (that one key, never the rest of the result), and their
   * model families from `repid_agents.model_family`. Names are not published.
   *
   * `families` lists only families actually recorded. It is empty when none are: on 2026-10-16
   * `model_family` was null for every validator of every exchange in the last 15 days, so the page
   * cannot honestly say the validators ran on different model families. `includes_provider` is true
   * when the provider is one of its own validators (1 of 17 in that window). `null` = no record.
   */
  validators: { families: string[]; includes_provider: boolean } | null;
  /** Anything we could not establish, stated rather than omitted. */
  caveats: string[];
}

const scan = (tx: string) => `https://sepolia.basescan.org/tx/${tx}`;

export async function buildTrustReceipt(contractId: string): Promise<TrustReceipt | null> {
  const { data: c } = await db
    .from('service_contracts')
    .select('id, status, agreed_price_usdc_raw, buyer_agent_id, provider_agent_id, settled_at, fulfilled_at, work_statement_hash, work_statement, criterion_ratings, buyer_satisfaction_score, validators:result->validators')
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

  const validatorNames = Array.isArray((c as any).validators)
    ? [...new Set(((c as any).validators as unknown[]).filter((v): v is string => typeof v === 'string'))]
    : null;
  let validators: TrustReceipt['validators'] = null;
  if (validatorNames) {
    // ponytail: agent_name is not unique (six agents are named HUMAN), so a shared name contributes
    // every family recorded under it. Exact once validators are recorded by id.
    const { data: va } = validatorNames.length
      ? await db.from('repid_agents').select('model_family').in('agent_name', validatorNames)
      : { data: [] as Array<{ model_family: string | null }> };
    validators = {
      families: [...new Set((va ?? []).map((a) => a.model_family).filter((f): f is string => typeof f === 'string' && f.trim() !== ''))].sort(),
      includes_provider: validatorNames.includes(names[c.provider_agent_id]!),
    };
  }

  const { data: settlement } = await db
    .from('x402_settlements')
    // payer_address + x_payment_header are read ONLY to derive the two wallets below; the header (it
    // carries the payer's signature) is never copied into the receipt.
    .select('tx_hash, is_simulated, status, created_at, delivered_at, payer_address, x_payment_header')
    .eq('idempotency_key', contractId)
    .maybeSingle();
  if (settlement && settlement.is_simulated) {
    caveats.push('This settlement was SIMULATED — no money actually moved.');
  }
  if (!settlement) caveats.push('No x402 settlement is on record for this contract.');
  // chainId only labels proofOfPaymentFrom's result, which is not published; the receipt is Base
  // Sepolia throughout (see scan()).
  const paid = proofOfPaymentFrom(settlement, 84532);
  // Whenever the wallets are not shown, say so (XC1 review of #1386: a non-simulated row with no tx
  // hash used to publish null wallets with no caveat).
  if (!paid) {
    caveats.push('The settlement record does not name both the payer and the payee wallet of a real payment, so who paid whom is not shown.');
  }

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
    .select('agent_id, event_type, delta, repid_before, repid_after, metadata, zk_proof_id, is_shadow')
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

  const proofs = await linkedProofs(contractId, (events ?? []).map((e) => (e as { zk_proof_id?: string | null }).zk_proof_id));

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
    // Lower-cased first: a stored address with a bad mixed-case checksum must not throw the route.
    payer_wallet: paid ? getAddress(paid.fromAddress.toLowerCase()) : null,
    payee_wallet: paid ? getAddress(paid.toAddress.toLowerCase()) : null,
    wallets_source: paid ? 'settlement_record' : null,
    paid_before_delivery,
    // SHADOW ROWS ARE NOT REPUTATION. `is_shadow` rows record what a would-be policy WOULD have
    // paid; the applier forces their applied delta to 0, so they moved nothing. Published here
    // they read as real gains ("+15 1371 -> 1371") and the receipt's own verifier could not
    // balance the ledger. Measured 2026-10-16: a third of the reputation rows on the daily
    // receipts were shadow rows. They stay in repid_score_events for whoever measures the shadow.
    reputation_events: (events ?? []).filter((e) => (e as { is_shadow?: boolean | null }).is_shadow !== true).map((e) => {
      // `decayApplied` ABSENT and `decayApplied: 0` are different facts and are
      // published differently. Absent means no writer recorded a decomposition,
      // so a reader cannot tell an honest decay from a rewritten score; zero
      // means a writer stated there was none. Collapsing absent to 0 would hand
      // the verifier a number nobody asserted and let it return VERIFIED on the
      // strength of it — the same "not checked scored as checked" this receipt
      // exists to prevent. Measured 2026-09-04: absent on every one of the 1,339
      // contract-linked events in the ledger, so `null` is the live answer here,
      // not a defensive branch.
      const md = (e as { metadata?: Record<string, unknown> | null }).metadata;
      const hasDecay =
        !!md && typeof md === 'object' && Object.prototype.hasOwnProperty.call(md, 'decayApplied');
      return {
        agent: names[e.agent_id] ?? String(e.agent_id).slice(0, 8),
        event: e.event_type,
        delta: e.delta,
        from: e.repid_before,
        to: e.repid_after,
        decay: hasDecay ? Number((md as Record<string, unknown>)['decayApplied']) : null,
      };
    }),
    onchain_tx: onchain?.tx_hash ?? null,
    onchain_url: onchain?.tx_hash ? scan(onchain.tx_hash) : null,
    onchain_repid: onchain?.repid_value ?? null,
    onchain_link_is_proven: !!onchain,
    zk_proofs: proofs.map((p) => ({
      job_id: p.job_id ?? null,
      agent: p.agent_id ? names[p.agent_id] ?? String(p.agent_id).slice(0, 8) : null,
      scheme: p.scheme ?? null,
      is_real: p.is_real ?? null,
      statement: p.statement ?? null,
      eas_attestation_uid: p.eas_attestation_uid ?? null,
      work_statement_hash: p.work_statement_hash ?? null,
      proof_url: p.job_id ? `/api/v1/receipt/${c.id}/proof/${p.job_id}` : null,
    })),
    work_statement_hash: c.work_statement_hash ?? null,
    work_statement: (c as any).work_statement ?? null,
    criterion_ratings: (c as any).criterion_ratings ?? null,
    buyer_satisfaction_score:
      (c as any).buyer_satisfaction_score === null || (c as any).buyer_satisfaction_score === undefined
        ? null
        : Number((c as any).buyer_satisfaction_score),
    validators,
    caveats,
  };
}

const PROOF_COLS = 'id, job_id, agent_id, scheme, is_real, statement, eas_attestation_uid, work_statement_hash, created_at';
type LinkedProof = {
  id: number; job_id: string | null; agent_id: string | null; scheme: string | null; is_real: boolean | null;
  statement: unknown; eas_attestation_uid: string | null; work_statement_hash: string | null; created_at: string | null;
};

/**
 * Proofs linked to a contract: by `contract_id` on the proof row, or by the job ids its score events
 * recorded. Two parameterised queries rather than one `.or()` string, because the contract id comes
 * from the URL and must never be spliced into a PostgREST filter. One row per job (a retried job can
 * leave two rows; the newest wins). Oldest first, matching the reputation events.
 */
async function linkedProofs(contractId: string, jobIds: Array<string | null | undefined>): Promise<LinkedProof[]> {
  const ids = [...new Set(jobIds.filter((j): j is string => typeof j === 'string' && j.length > 0))];
  const [byContract, byJob] = await Promise.all([
    db.from('repid_zkp_proofs').select(PROOF_COLS).eq('contract_id', contractId).limit(20),
    ids.length
      ? db.from('repid_zkp_proofs').select(PROOF_COLS).in('job_id', ids).limit(20)
      : Promise.resolve({ data: [] as LinkedProof[] }),
  ]);
  const byKey = new Map<string, LinkedProof>();
  for (const p of [...((byContract.data ?? []) as LinkedProof[]), ...((byJob.data ?? []) as LinkedProof[])]) {
    const key = p.job_id ?? `row:${p.id}`;
    const prev = byKey.get(key);
    if (!prev || String(p.created_at ?? '') > String(prev.created_at ?? '')) byKey.set(key, p);
  }
  return [...byKey.values()].sort((a, b) => String(a.created_at ?? '').localeCompare(String(b.created_at ?? '')));
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
