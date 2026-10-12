/**
 * The ERC-8004 IdentityRegistry address a public payload may publish — or NOT_CHECKED with a reason.
 *
 * WHY THIS EXISTS. `GET /api/v1/passport/:id` published `repid_agents.erc8004_address` verbatim as
 * `identity_erc8004.contract_address`. MEASURED 2026-10-12 against the live table, over the agents
 * that carry a mint transaction and a token id: only a small minority held the canonical registry.
 * The rest held a non-hex placeholder, a 32-byte transaction hash, or some other 40-hex address (an
 * EOA, or the registry with a character wrong). A counterparty deciding whether to authorize an
 * agent was being handed a "contract address" that is not a contract address, labelled as one.
 * (Exact counts are in the PR thread, not here: this repository is public.)
 *
 * The column is bookkeeping and it is wrong for most rows. Whether it is wrong because the mint
 * script wrote the wrong field or because it was hand-edited is not knowable from here, and fixing
 * the rows is a data change for a human (it changes what the public passport says about an
 * identity). So this module does the one thing the API layer can do honestly: refuse to repeat a
 * value it cannot recognise.
 *
 * THE RULE. A stored value is published ONLY if it is, after case-folding, the canonical registry
 * for the chain the record names — and then what is published is the canonical form from config,
 * never the stored string. Everything else is `null` with a machine-readable reason:
 *
 *   not_minted                  state is NOT_MINTED: there is no registry to name.
 *   mint_unverified             state is UNVERIFIED: a token id with no mint tx. We do not assert a
 *                               registry for a mint we have not evidenced, and we do not claim the
 *                               mint is absent either — UNVERIFIED stays UNVERIFIED.
 *   no_address_recorded         MINTED but the column is empty.
 *   not_an_address              not 0x + 40 hex (a placeholder such as "external:…", "0x8004Nexu…").
 *   transaction_hash            0x + 64 hex: a tx hash sitting where an address belongs.
 *   not_the_canonical_registry  a well-formed address that is not the registry (an EOA, an
 *                               off-by-one). Well-formed is not correct.
 *   no_canonical_registry_for_chain  the record names a chain this engine holds no registry for.
 *
 * It never invents a mint: the state comes from identity-state.ts and is passed in, unchanged.
 * It never reaches the chain. `NOT_CHECKED` here means "we will not vouch for this value", not
 * "there is no registry".
 */
import { NETWORKS } from '../config/network';
import type { IdentityState } from '../services/identity-state';

export type RegistryRejection =
  | 'not_minted'
  | 'mint_unverified'
  | 'no_address_recorded'
  | 'not_an_address'
  | 'transaction_hash'
  | 'not_the_canonical_registry'
  | 'no_canonical_registry_for_chain';

export type RegistryReading =
  | { status: 'CANONICAL'; address: string; reason: null }
  | { status: 'NOT_CHECKED'; address: null; reason: RegistryRejection };

const ADDRESS_SHAPE = /^0x[0-9a-fA-F]{40}$/;
const TX_HASH_SHAPE = /^0x[0-9a-fA-F]{64}$/;

/**
 * The canonical identity registry for a chain id, or null. A null chain id means the row does not
 * say; the only chain this engine has minted on is Base Sepolia, so that is the one assumed —
 * and only ever to compare a stored value against, never to make one up.
 */
export function canonicalIdentityRegistry(chainId: number | null): string | null {
  const net = chainId == null ? NETWORKS['base-sepolia'] : Object.values(NETWORKS).find((n) => n.chainId === chainId);
  const addr = net?.contracts.identityRegistry;
  return addr && ADDRESS_SHAPE.test(addr) ? addr : null;
}

export function guardRegistryAddress(
  stored: unknown,
  ctx: { state: IdentityState; chainId: number | null },
): RegistryReading {
  const reject = (reason: RegistryRejection): RegistryReading => ({ status: 'NOT_CHECKED', address: null, reason });

  if (ctx.state === 'NOT_MINTED') return reject('not_minted');
  if (ctx.state === 'UNVERIFIED') return reject('mint_unverified');

  if (typeof stored !== 'string' || stored.trim() === '') return reject('no_address_recorded');
  const value = stored.trim();
  if (TX_HASH_SHAPE.test(value)) return reject('transaction_hash');
  if (!ADDRESS_SHAPE.test(value)) return reject('not_an_address');

  const canonical = canonicalIdentityRegistry(ctx.chainId);
  if (!canonical) return reject('no_canonical_registry_for_chain');
  if (value.toLowerCase() !== canonical.toLowerCase()) return reject('not_the_canonical_registry');
  return { status: 'CANONICAL', address: canonical, reason: null };
}
