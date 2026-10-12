/**
 * The passport must never publish a "registry address" it cannot recognise.
 *
 * `identity_erc8004.contract_address` was `repid_agents.erc8004_address` copied verbatim. For most
 * agents that column is not a registry address: a non-hex placeholder, a transaction hash, an EOA,
 * the registry with a character wrong. MEASURED 2026-10-12 (shapes only, via a read-only query).
 *
 * The guard publishes the canonical IdentityRegistry only when the stored value IS it, and
 * otherwise `null` + a reason. It must also do that WITHOUT touching the identity state: a record
 * with garbage in this column is still MINTED if we hold its mint tx, and an UNVERIFIED agent stays
 * UNVERIFIED. Dropping the address must never turn into inventing, or denying, a mint.
 *
 * Fixtures are built by mutating the canonical string, so an "off-by-one" here is a real
 * off-by-one of the address the code compares against, not a hand-typed lookalike.
 */
import { buildAgentPassport } from '../src/services/agent-passport';
import {
  canonicalIdentityRegistry,
  guardRegistryAddress,
  type RegistryRejection,
} from '../src/identity/registry-address';

/** docs/AGENT-ADDRESSES.md "ERC-8004 IdentityRegistry". Spelled out so a change to config is caught. */
const CANONICAL = '0x8004A818BFB912233c491871b3d84c89A494BD9e';
const TX_HASH = '0x' + 'ab'.repeat(32);
const EOA = '0x93223C321d2f4c136bf1da64DEb3C6Ad484334E1'; // a well-formed address that is a wallet, not the registry

/** Same address, one hex digit different (valid shape, wrong value). */
function offByOneDigit(addr: string): string {
  const last = addr.slice(-1);
  return addr.slice(0, -1) + (last === '0' ? '1' : '0');
}

describe('canonical registry', () => {
  it('is the IdentityRegistry from docs/AGENT-ADDRESSES.md', () => {
    expect(canonicalIdentityRegistry(84532)).toBe(CANONICAL);
    // A record that does not name its chain is compared against the one chain minted on.
    expect(canonicalIdentityRegistry(null)).toBe(CANONICAL);
  });

  it('is unknown for a chain this engine holds no registry for', () => {
    expect(canonicalIdentityRegistry(1)).toBeNull();
    // Base mainnet's registry is "TBD" in config: an empty string is not an address.
    expect(canonicalIdentityRegistry(8453)).toBeNull();
  });
});

describe('guardRegistryAddress on a MINTED record', () => {
  const minted = { state: 'MINTED' as const, chainId: 84532 };

  it('VALID: the canonical registry is published, in canonical form', () => {
    for (const stored of [CANONICAL, CANONICAL.toLowerCase(), '  ' + CANONICAL + ' ']) {
      expect(guardRegistryAddress(stored, minted)).toEqual({ status: 'CANONICAL', address: CANONICAL, reason: null });
    }
  });

  const rejected: Array<[string, unknown, RegistryRejection]> = [
    ['placeholder with 0x8004 prefix and non-hex tail', '0x8004Nexus_placeholder_not_hex_value_', 'not_an_address'],
    ['external: placeholder', 'external:some-agent', 'not_an_address'],
    ['agent-creation placeholder (0xAGENT_ + hex)', '0xAGENT_' + 'a'.repeat(34), 'not_an_address'],
    ['transaction hash (0x + 64 hex)', TX_HASH, 'transaction_hash'],
    ['EOA (well-formed, not the registry)', EOA, 'not_the_canonical_registry'],
    ['off-by-one digit', offByOneDigit(CANONICAL), 'not_the_canonical_registry'],
    ['off-by-one length: a digit short', CANONICAL.slice(0, -1), 'not_an_address'],
    ['off-by-one length: a digit long', CANONICAL + '0', 'not_an_address'],
    ['null', null, 'no_address_recorded'],
    ['undefined', undefined, 'no_address_recorded'],
    ['empty string', '', 'no_address_recorded'],
    ['whitespace', '   ', 'no_address_recorded'],
    ['a number', 12345, 'no_address_recorded'],
  ];

  it.each(rejected)('%s -> NOT_CHECKED, never the stored value', (_label, stored, reason) => {
    const got = guardRegistryAddress(stored, minted);
    expect(got).toEqual({ status: 'NOT_CHECKED', address: null, reason });
  });

  it('the canonical registry on a chain it is not the registry for is refused', () => {
    // Stored value is the Base-Sepolia registry but the record says mainnet, where none is configured.
    expect(guardRegistryAddress(CANONICAL, { state: 'MINTED', chainId: 8453 })).toEqual({
      status: 'NOT_CHECKED',
      address: null,
      reason: 'no_canonical_registry_for_chain',
    });
  });

  it('PROPERTY: whatever goes in, the output is the canonical registry or null — never the input', () => {
    const inputs: unknown[] = [
      CANONICAL, TX_HASH, EOA, offByOneDigit(CANONICAL), '0xdead', 'garbage', '', null, undefined, 0, {}, [],
      '0x' + 'f'.repeat(40), '0X' + CANONICAL.slice(2), CANONICAL.replace('0x', ''),
    ];
    for (const stored of inputs) {
      const got = guardRegistryAddress(stored, minted);
      expect([CANONICAL, null]).toContain(got.address);
      if (got.address !== null) expect(got.status).toBe('CANONICAL');
      else expect(got.status).toBe('NOT_CHECKED');
    }
  });
});

describe('guardRegistryAddress does not decide the mint', () => {
  it('UNVERIFIED publishes no registry even when the stored value is the canonical one', () => {
    expect(guardRegistryAddress(CANONICAL, { state: 'UNVERIFIED', chainId: null })).toEqual({
      status: 'NOT_CHECKED',
      address: null,
      reason: 'mint_unverified',
    });
  });

  it('NOT_MINTED publishes no registry', () => {
    expect(guardRegistryAddress(CANONICAL, { state: 'NOT_MINTED', chainId: null }).reason).toBe('not_minted');
  });
});

/* ---------------- through the real passport builder, on stubbed records ---------------- */

function chainResult(result: any) {
  const chain: any = {};
  for (const m of ['select', 'eq', 'or', 'order', 'limit', 'not']) chain[m] = () => chain;
  chain.maybeSingle = () => Promise.resolve(result);
  chain.then = (onF: any, onR: any) => Promise.resolve(result).then(onF, onR);
  return chain;
}

function dbFor(agentRow: Record<string, unknown>) {
  const script: Record<string, any[]> = {
    repid_agents: [{ data: agentRow, error: null }],
    x402_settlements: [{ count: 0, error: null }, { count: 0, error: null }, { data: null, error: null }],
    erc8004_reputation_writes: [{ count: 0, error: null }, { data: null, error: null }],
    repid_zkp_proofs: [{ data: null, error: null }],
  };
  return {
    from: (table: string) => {
      const q = script[table];
      if (!q || q.length === 0) throw new Error(`unexpected query on table ${table}`);
      return chainResult(q.shift());
    },
  } as any;
}

// Deliberately DIFFERENT from the stored-address fixtures below (TX_HASH, EOA). The "stored value
// appears nowhere in the identity block" assertion is only meaningful if the row's own mint tx and
// conservator cannot be the substring it finds.
const MINT_TX = '0x' + 'cd'.repeat(32);
const CONSERVATOR = '0x' + '1234567890'.repeat(4);

const BASE_ROW = {
  id: '11111111-2222-3333-4444-555555555555',
  agent_name: 'trinity-fixture',
  display_name: null,
  current_repid: 1200,
  tier: 'ESTABLISHED',
  activity_30d: 1,
  created_at: '2026-04-01T00:00:00.000Z',
  erc8004_token_id: '4242',
  mint_tx_hash: MINT_TX,
  mint_chain_id: 84532,
  minted_at: '2026-05-10T00:00:00.000Z',
  conservator_address: CONSERVATOR,
};

describe('GET /passport/:id — identity_erc8004 on a stubbed record of each shape', () => {
  const shapes: Array<[string, string | null]> = [
    ['valid canonical', CANONICAL],
    ['non-hex placeholder', '0x8004Nexus_placeholder_not_hex_value_'],
    ['transaction hash', TX_HASH],
    ['EOA', EOA],
    ['off-by-one', offByOneDigit(CANONICAL)],
    ['null', null],
  ];

  it.each(shapes)('%s -> canonical or NOT_CHECKED, never garbage', async (_label, stored) => {
    const p = await buildAgentPassport(dbFor({ ...BASE_ROW, erc8004_address: stored }), BASE_ROW.id);
    const id = p!.identity_erc8004;
    expect([CANONICAL, null]).toContain(id.contract_address);
    if (stored === CANONICAL) {
      expect(id.contract_address).toBe(CANONICAL);
      expect(id.contract_address_check).toBe('CANONICAL');
      expect(id.contract_address_reason).toBeNull();
    } else {
      expect(id.contract_address).toBeNull();
      expect(id.contract_address_check).toBe('NOT_CHECKED');
      expect(typeof id.contract_address_reason).toBe('string');
    }
    // Rejecting the address does not touch the mint: we still hold the mint tx, so still MINTED,
    // and the token id and tx are still reported. No mint is invented or withdrawn.
    expect(id.registered_onchain).toBe('MINTED');
    expect(id.token_id).toBe('4242');
    expect(id.mint_tx_hash).toBe(MINT_TX);
    // And the raw stored string appears nowhere in the identity block unless it IS the registry.
    if (stored !== null && stored !== CANONICAL) expect(JSON.stringify(id)).not.toContain(stored);
  });

  it('UNVERIFIED stays UNVERIFIED, with no registry, even if the column holds the canonical address', async () => {
    const p = await buildAgentPassport(
      dbFor({ ...BASE_ROW, mint_tx_hash: null, mint_chain_id: null, erc8004_address: CANONICAL }),
      BASE_ROW.id,
    );
    expect(p!.identity_erc8004.registered_onchain).toBe('UNVERIFIED');
    expect(p!.identity_erc8004.contract_address).toBeNull();
    expect(p!.identity_erc8004.contract_address_reason).toBe('mint_unverified');
    expect(p!.identity_erc8004.token_id).toBe('4242');
  });

  it('NOT_MINTED stays NOT_MINTED, with no registry', async () => {
    const p = await buildAgentPassport(
      dbFor({ ...BASE_ROW, mint_tx_hash: null, erc8004_token_id: null, erc8004_address: '0xAGENT_' + 'a'.repeat(34) }),
      BASE_ROW.id,
    );
    expect(p!.identity_erc8004.registered_onchain).toBe('NOT_MINTED');
    expect(p!.identity_erc8004.contract_address).toBeNull();
    expect(p!.identity_erc8004.contract_address_reason).toBe('not_minted');
  });
});
