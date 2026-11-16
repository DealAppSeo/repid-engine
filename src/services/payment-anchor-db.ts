/**
 * payment-anchor-db.ts — the Supabase side of `payment-anchor-verify.ts`.
 *
 * TERMS come from three tables, all written by the engine, none by the caller:
 *   service_contracts   provider, buyer, agreed_price_usdc_raw (the price, in USDC's smallest unit)
 *   repid_agents        the provider's `wallet_address` = the payee
 *   x402_settlements    the settlement recorded for the contract (`idempotency_key` = contract id):
 *                       its `tx_hash` and the facilitator-verified `payer_address`
 *
 * Why `wallet_address` and not `erc8004_address`: MEASURED 2026-11-16 on the five most recent real
 * settlements, every payee was the provider's `wallet_address`, while `erc8004_address` held values
 * such as `pending-mint:…`, a registry contract's address, and free text. A payee read from that
 * column would refuse real payments or accept payments to the wrong address.
 *
 * Why the payer is NOT the buyer's wallet: the same five settlements were all paid by the custodian
 * wallet, not by the buyer agent's own `wallet_address`. The payer is what the facilitator verified
 * from the signed authorization, which `x402_settlements.payer_address` records.
 *
 * REPLAY TABLE: `payment_anchor_claims`, created by the DRAFT migration
 * `supabase/migrations/20261116130000_payment_anchor_claims.sql`. Until Sean applies it, an anchor
 * the chain refuses is still REFUSED, and one the chain accepts reports NOT_CHECKED
 * `replay_store_unreachable` with `chain_verified: true`: it says exactly what is missing instead of
 * passing.
 */
import { db } from '../db';
import type { AnchorBindingRow, AnchorReplayStore, AnchorTerms } from './payment-anchor-verify';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HEX32 = /^0x[0-9a-fA-F]{64}$/;

/** Load a contract's payment terms. null = no such contract. Throws when the read fails. */
export async function dbAnchorTerms(contractId: string): Promise<AnchorTerms | null> {
  if (!UUID.test(contractId)) return null; // service_contracts.id is a uuid; anything else is not a contract

  const { data: c, error: cErr } = await db
    .from('service_contracts')
    .select('id, provider_agent_id, agreed_price_usdc_raw')
    .eq('id', contractId)
    .maybeSingle();
  if (cErr) throw new Error('service_contracts read failed');
  if (!c) return null;

  const { data: p, error: pErr } = await db
    .from('repid_agents')
    .select('wallet_address')
    .eq('id', (c as any).provider_agent_id)
    .maybeSingle();
  if (pErr) throw new Error('repid_agents read failed');

  // More than one settlement row for a contract is itself an anomaly: maybeSingle errors, which
  // surfaces as NOT_CHECKED rather than picking one.
  const { data: s, error: sErr } = await db
    .from('x402_settlements')
    .select('tx_hash, payer_address, is_simulated')
    .eq('idempotency_key', contractId)
    .maybeSingle();
  if (sErr) throw new Error('x402_settlements read failed');

  const recordedTx =
    s && (s as any).is_simulated === false && HEX32.test(String((s as any).tx_hash ?? '')) ? String((s as any).tx_hash) : null;

  let units: bigint;
  try {
    units = BigInt((c as any).agreed_price_usdc_raw ?? 0);
  } catch {
    units = 0n;
  }

  return {
    contractId,
    payeeAddress: (p as any)?.wallet_address ?? null,
    claimedUnits: units,
    payerAddress: recordedTx ? ((s as any).payer_address ?? null) : null,
    recordedTxHash: recordedTx,
  };
}

/** The replay table. Any read or write error throws, which the verifier reports as NOT_CHECKED. */
export function dbAnchorReplayStore(): AnchorReplayStore {
  return {
    async find(chainId, txHash) {
      const { data, error } = await db
        .from('payment_anchor_claims')
        .select('contract_id')
        .eq('chain_id', chainId)
        .eq('tx_hash', txHash.toLowerCase())
        .maybeSingle();
      if (error) throw new Error('payment_anchor_claims read failed');
      return data ? { contract_id: String((data as any).contract_id) } : null;
    },
    async bind(row: AnchorBindingRow) {
      const { error } = await db.from('payment_anchor_claims').insert(row);
      if (!error) return 'ok';
      if (String(error.code) === '23505') return 'duplicate';
      throw new Error('payment_anchor_claims write failed');
    },
  };
}
