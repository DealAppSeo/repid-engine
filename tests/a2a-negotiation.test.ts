/**
 * a2a-negotiation.test.ts
 *
 * Covers the invariants that actually carry weight:
 *   - the accept path has NO price input and copies the price out of the
 *     accepted round (the bug this feature exists to fix)
 *   - route-level identity binding, NOT the auth middleware's OR-chain
 *   - the sealed-bid filter
 *   - RepID never moves a price or an ordering
 *   - a below-floor price is refused (the ~$0.000001 RepID-minting wash trade)
 *   - an abandoned RFQ still counts against the buyer's award ratio
 *   - a non-lowest / uncontested award without a real written reason writes
 *     NOTHING — no contract, no award
 *
 * The Supabase client is replaced with an in-memory fake. No network, no DB.
 */
import express from 'express';
import request from 'supertest';

// ── in-memory fake of the supabase-js query builder ──────────────────────────

// Deliberately `any` — this is an in-memory stand-in for a dynamically-typed
// PostgREST client, not a modelled schema.
type Row = any;
type Store = Record<string, Row[]>;

const store: Store = {};
let rpcCalls: Array<{ name: string; args: Row }> = [];
let rpcHandler: (name: string, args: Row) => { data: any; error: any } = () => ({
  data: null,
  error: { code: '42883', message: 'function public.a2a_accept_and_award does not exist' },
});

let idCounter = 0;
function nextId(prefix: string): string {
  idCounter += 1;
  const n = String(idCounter).padStart(12, '0');
  return `${prefix}${'0'.repeat(8 - prefix.length)}-1111-2222-3333-${n}`;
}

interface Filter {
  kind: 'eq' | 'in' | 'gte' | 'lte' | 'or';
  col?: string;
  value?: any;
  expr?: string;
}

function matches(row: Row, filters: Filter[]): boolean {
  return filters.every((f) => {
    if (f.kind === 'eq') return String(row[f.col as string]) === String(f.value);
    if (f.kind === 'in') return (f.value as any[]).map(String).includes(String(row[f.col as string]));
    if (f.kind === 'gte') return String(row[f.col as string]) >= String(f.value);
    if (f.kind === 'lte') return String(row[f.col as string]) <= String(f.value);
    if (f.kind === 'or') {
      const clauses = String(f.expr).split(',');
      return clauses.some((c) => {
        const parts = c.split('.');
        const col = parts[0];
        const val = parts.slice(2).join('.');
        return col !== undefined && String(row[col]) === val;
      });
    }
    return true;
  });
}

class FakeQuery implements PromiseLike<any> {
  private filters: Filter[] = [];
  private op: 'select' | 'insert' | 'update' | 'delete' = 'select';
  private payload: Row | null = null;
  private wantCount = false;
  private headOnly = false;
  private limitN: number | null = null;
  private orderCol: string | null = null;
  private orderAsc = true;
  private returning = false;

  constructor(private table: string) {
    if (!store[this.table]) store[this.table] = [];
  }

  select(_cols?: string, opts?: { count?: string; head?: boolean }): this {
    if (this.op === 'select') this.op = 'select';
    else this.returning = true;
    if (opts?.count) this.wantCount = true;
    if (opts?.head) this.headOnly = true;
    return this;
  }
  insert(payload: Row): this {
    this.op = 'insert';
    this.payload = payload;
    return this;
  }
  update(payload: Row): this {
    this.op = 'update';
    this.payload = payload;
    return this;
  }
  delete(): this {
    this.op = 'delete';
    return this;
  }
  eq(col: string, value: any): this {
    this.filters.push({ kind: 'eq', col, value });
    return this;
  }
  in(col: string, value: any[]): this {
    this.filters.push({ kind: 'in', col, value });
    return this;
  }
  gte(col: string, value: any): this {
    this.filters.push({ kind: 'gte', col, value });
    return this;
  }
  lte(col: string, value: any): this {
    this.filters.push({ kind: 'lte', col, value });
    return this;
  }
  or(expr: string): this {
    this.filters.push({ kind: 'or', expr });
    return this;
  }
  order(col: string, opts?: { ascending?: boolean }): this {
    this.orderCol = col;
    this.orderAsc = opts?.ascending !== false;
    return this;
  }
  limit(n: number): this {
    this.limitN = n;
    return this;
  }

  private run(): { data: any; error: any; count?: number } {
    const table = store[this.table] as Row[];
    if (this.op === 'insert') {
      const row: Row = { id: nextId('aaaaaaaa'), created_at: new Date().toISOString(), ...this.payload };
      table.push(row);
      return { data: [row], error: null };
    }
    const hit = table.filter((r) => matches(r, this.filters));
    if (this.op === 'update') {
      for (const r of hit) Object.assign(r, this.payload);
      return { data: hit, error: null };
    }
    if (this.op === 'delete') {
      for (const r of hit) {
        const i = table.indexOf(r);
        if (i >= 0) table.splice(i, 1);
      }
      return { data: hit, error: null };
    }
    let out = [...hit];
    if (this.orderCol) {
      const col = this.orderCol;
      out.sort((a, b) => (String(a[col]) < String(b[col]) ? -1 : String(a[col]) > String(b[col]) ? 1 : 0));
      if (!this.orderAsc) out.reverse();
    }
    if (this.limitN !== null) out = out.slice(0, this.limitN);
    if (this.headOnly) return { data: null, error: null, count: hit.length };
    return { data: out, error: null, count: this.wantCount ? hit.length : undefined };
  }

  async single(): Promise<{ data: any; error: any }> {
    const r = this.run();
    const rows = (r.data ?? []) as Row[];
    if (rows.length === 0) return { data: null, error: { code: 'PGRST116', message: 'no rows' } };
    return { data: rows[0], error: null };
  }
  async maybeSingle(): Promise<{ data: any; error: any }> {
    const r = this.run();
    const rows = (r.data ?? []) as Row[];
    return { data: rows.length > 0 ? rows[0] : null, error: null };
  }
  then<T1 = any, T2 = never>(
    onOk?: ((v: any) => T1 | PromiseLike<T1>) | null,
    onErr?: ((r: any) => T2 | PromiseLike<T2>) | null,
  ): PromiseLike<T1 | T2> {
    return Promise.resolve(this.run()).then(onOk, onErr);
  }
}

// `jest.mock` is hoisted above the compiled requires, so the factory may only
// reference HOISTED function declarations — never the FakeQuery class binding
// (which is still in TDZ at that point). The closures below are invoked long
// after module init, by which time everything is live.
function makeQuery(table: string): FakeQuery {
  return new FakeQuery(table);
}
function callRpc(name: string, args: Row): { data: any; error: any } {
  rpcCalls.push({ name, args });
  return rpcHandler(name, args);
}

jest.mock('../src/db', () => ({
  db: {
    from: (table: string) => makeQuery(table),
    rpc: async (name: string, args: any) => callRpc(name, args),
  },
}));

// ── imports under test (after the mock is in place) ──────────────────────────
import negotiationRouter from '../src/routes/v1/negotiation';
import {
  applySnipeExtension,
  computeBuyerPanel,
  computeConcentration,
  computeOfferHash,
  filterVisibleBids,
  negotiationConfig,
  offerCap,
  operatorFingerprint,
  roundCapExceeded,
  sharedIdentityKeys,
  sortBidsDeterministic,
  validateAwardRationale,
  validatePrice,
  verifyStoredOfferHash,
  type BidRow,
  type BidWithRounds,
  type RoundRow,
} from '../src/services/a2a-negotiation';

// ── fixtures ────────────────────────────────────────────────────────────────

const BUYER = 'b0000000-1111-2222-3333-000000000001';
const PROV_A = 'a0000000-1111-2222-3333-000000000002';
const PROV_B = 'a0000000-1111-2222-3333-000000000003';
const RFQ_ID = 'f0000000-1111-2222-3333-000000000010';
const SVC_A = '50000000-1111-2222-3333-000000000020';
const SVC_B = '50000000-1111-2222-3333-000000000021';

const HOUR = 60 * 60 * 1000;

function isoIn(ms: number): string {
  return new Date(Date.now() + ms).toISOString();
}

function makeRound(over: Partial<RoundRow> & Pick<RoundRow, 'bid_id' | 'round_no' | 'price_usdc_raw'>): RoundRow {
  const base: RoundRow = {
    id: over.id ?? `r-${over.bid_id}-${over.round_no}`,
    bid_id: over.bid_id,
    rfq_id: over.rfq_id ?? RFQ_ID,
    round_no: over.round_no,
    offered_by: over.offered_by ?? 'provider',
    actor_agent_id: over.actor_agent_id ?? PROV_A,
    price_usdc_raw: over.price_usdc_raw,
    eta_seconds: over.eta_seconds ?? 3600,
    terms: over.terms ?? {},
    accepts_round_id: over.accepts_round_id ?? null,
    offer_hash: '',
    actor_signature: null,
    actor_signing_address: null,
    signature_verified: false,
    attestation_level: 'server_attested',
    expires_at: over.expires_at ?? isoIn(6 * HOUR),
    created_at: over.created_at ?? new Date().toISOString(),
  };
  base.offer_hash = computeOfferHash({
    bid_id: base.bid_id,
    round_no: base.round_no,
    offered_by: base.offered_by,
    actor_agent_id: base.actor_agent_id,
    price_usdc_raw: base.price_usdc_raw,
    eta_seconds: base.eta_seconds,
    terms: base.terms,
    expires_at: base.expires_at,
  });
  return base;
}

function makeBid(over: Partial<BidRow> & Pick<BidRow, 'id' | 'provider_agent_id'>): BidRow {
  return {
    id: over.id,
    rfq_id: over.rfq_id ?? RFQ_ID,
    provider_agent_id: over.provider_agent_id,
    service_id: over.service_id ?? SVC_A,
    status: over.status ?? 'open',
    rounds_used: over.rounds_used ?? 1,
    current_round_id: over.current_round_id ?? null,
    provider_repid_at_bid: over.provider_repid_at_bid ?? 1500,
    bond_repid: 0,
    bond_enforcement: 'not_implemented',
    related_bidder_flag: false,
    related_to_buyer_flag: false,
    created_at: over.created_at ?? new Date().toISOString(),
    updated_at: over.updated_at ?? new Date().toISOString(),
  };
}

function seedAgents(repidA = 1500, repidB = 1500): void {
  store['repid_agents'] = [
    {
      id: BUYER,
      agent_name: 'buyer-agent',
      current_repid: 2000,
      tier: 'ESTABLISHED',
      lifecycle_status: 'active',
      wallet_address: '0x1111111111111111111111111111111111111111',
      signing_address: null,
      builder_id: null,
      erc8004_address: '0xB000000000000000000000000000000000000001',
      erc8004_token_id: '1',
      reputation_write_count: 3,
      last_reputation_tx_hash: '0xdeadbeef',
      last_reputation_block_number: 100,
      last_reputation_written_at: new Date().toISOString(),
      mint_tx_hash: null,
      mint_chain_id: 84532,
    },
    {
      id: PROV_A,
      agent_name: 'provider-a',
      current_repid: repidA,
      tier: 'ESTABLISHED',
      lifecycle_status: 'active',
      wallet_address: '0x2222222222222222222222222222222222222222',
      signing_address: null,
      builder_id: null,
      erc8004_address: '0xA000000000000000000000000000000000000002',
      erc8004_token_id: '2',
      reputation_write_count: 5,
      last_reputation_tx_hash: '0xcafe',
      last_reputation_block_number: 200,
      last_reputation_written_at: new Date().toISOString(),
      mint_tx_hash: null,
      mint_chain_id: 84532,
    },
    {
      id: PROV_B,
      agent_name: 'provider-b',
      current_repid: repidB,
      tier: 'ESTABLISHED',
      lifecycle_status: 'active',
      wallet_address: '0x3333333333333333333333333333333333333333',
      signing_address: null,
      builder_id: null,
      erc8004_address: '0xA000000000000000000000000000000000000003',
      erc8004_token_id: '3',
      reputation_write_count: 1,
      last_reputation_tx_hash: null,
      last_reputation_block_number: null,
      last_reputation_written_at: null,
      mint_tx_hash: null,
      mint_chain_id: 84532,
    },
  ];
  store['agent_services'] = [
    {
      id: SVC_A,
      provider_agent_id: PROV_A,
      service_type: 'verification',
      active: true,
      base_price_usdc_raw: 100000,
      min_repid_to_purchase: 500,
      total_fulfilled: 10,
      total_satisfied: 9,
      avg_satisfaction: 0.9,
    },
    {
      id: SVC_B,
      provider_agent_id: PROV_B,
      service_type: 'verification',
      active: true,
      base_price_usdc_raw: 100000,
      min_repid_to_purchase: 500,
      total_fulfilled: 4,
      total_satisfied: 4,
      avg_satisfaction: 1.0,
    },
  ];
}

/** RFQ already past bids_close_at, still inside expires_at → awardable. */
function seedClosedRfq(): void {
  store['a2a_rfqs'] = [
    {
      id: RFQ_ID,
      buyer_agent_id: BUYER,
      service_type: 'verification',
      scope: { task: 'verify a claim' },
      min_price_usdc_raw: 10000,
      max_price_usdc_raw: null,
      min_provider_repid: 1000,
      award_mode: 'sealed_close',
      max_rounds: 3,
      max_bids: 25,
      bids_close_at: isoIn(-HOUR),
      close_extensions: 0,
      expires_at: isoIn(6 * HOUR),
      deadline_at: null,
      status: 'closed',
      outcome: null,
      created_at: isoIn(-2 * HOUR),
      closed_at: null,
    },
  ];
}

function seedTwoBids(priceA: number, priceB: number): { bidA: Row; bidB: Row } {
  const bidA = makeBid({ id: 'bid-a', provider_agent_id: PROV_A, service_id: SVC_A, current_round_id: 'r-bid-a-1' });
  const bidB = makeBid({ id: 'bid-b', provider_agent_id: PROV_B, service_id: SVC_B, current_round_id: 'r-bid-b-1' });
  const roundA = makeRound({ bid_id: 'bid-a', round_no: 1, price_usdc_raw: priceA, actor_agent_id: PROV_A });
  const roundB = makeRound({ bid_id: 'bid-b', round_no: 1, price_usdc_raw: priceB, actor_agent_id: PROV_B });
  store['a2a_bids'] = [bidA, bidB];
  store['a2a_bid_rounds'] = [roundA, roundB];
  return { bidA, bidB };
}

// ── app ─────────────────────────────────────────────────────────────────────

function makeApp() {
  const app = express();
  app.use(express.json());
  // Stand-in for authMiddleware's bound-key binding: the header IS the binding.
  app.use((req, _res, next) => {
    const bound = req.header('x-test-bound-agent');
    if (bound) (req as any).agent_id = bound;
    next();
  });
  app.use('/api/v1/negotiation', negotiationRouter);
  return app;
}

beforeEach(() => {
  for (const k of Object.keys(store)) delete store[k];
  store['x402_settlements'] = [];
  store['a2a_awards'] = [];
  store['service_contracts'] = [];
  rpcCalls = [];
  idCounter = 0;
  rpcHandler = (_name, args) => {
    const contractId = nextId('cccccccc');
    const awardId = nextId('dddddddd');
    (store['service_contracts'] as Row[]).push({
      id: contractId,
      service_id: args.p_service_id,
      buyer_agent_id: args.p_buyer_agent_id,
      provider_agent_id: args.p_provider_agent_id,
      agreed_price_usdc_raw: args.p_price_usdc_raw,
      status: 'pending',
      metadata: args.p_contract_metadata,
    });
    (store['a2a_awards'] as Row[]).push({
      id: awardId,
      rfq_id: args.p_rfq_id,
      contract_id: contractId,
      winning_bid_id: args.p_bid_id,
      winning_round_id: args.p_round_id,
      buyer_agent_id: args.p_buyer_agent_id,
      provider_agent_id: args.p_provider_agent_id,
      awarded_price_usdc_raw: args.p_price_usdc_raw,
      is_uncontested: args.p_is_uncontested,
    });
    return { data: { contract_id: contractId, award_id: awardId }, error: null };
  };
  delete process.env.A2A_BUYER_SEES_SEALED_PRICES;
  delete process.env.A2A_REQUIRE_SIGNED_ROUNDS;
  delete process.env.A2A_MIN_PRICE_USDC_RAW;
  process.env.VALUE_CAP_ENFORCEMENT = 'enforce';
});

// ─────────────────────────────────────────────────────────────────────────────
// Pure invariants
// ─────────────────────────────────────────────────────────────────────────────

describe('offer_hash', () => {
  test('is stable and key-order independent for terms', () => {
    const a = computeOfferHash({
      bid_id: 'b1', round_no: 1, offered_by: 'provider', actor_agent_id: PROV_A,
      price_usdc_raw: 100000, eta_seconds: 3600, terms: { z: 1, a: 2 }, expires_at: '2026-08-01T00:00:00.000Z',
    });
    const b = computeOfferHash({
      bid_id: 'b1', round_no: 1, offered_by: 'provider', actor_agent_id: PROV_A,
      price_usdc_raw: 100000, eta_seconds: 3600, terms: { a: 2, z: 1 }, expires_at: '2026-08-01T00:00:00.000Z',
    });
    expect(a).toBe(b);
  });

  test('changes when the price changes, and a tampered stored row fails verification', () => {
    const round = makeRound({ bid_id: 'bid-a', round_no: 1, price_usdc_raw: 100000 });
    expect(verifyStoredOfferHash(round)).toBe(true);
    const tampered: RoundRow = { ...round, price_usdc_raw: 1 };
    expect(verifyStoredOfferHash(tampered)).toBe(false);
  });
});

describe('sealed-bid visibility', () => {
  const cfg = () => negotiationConfig();
  const rfq = {
    buyer_agent_id: BUYER,
    bids_close_at: isoIn(HOUR),
    award_mode: 'sealed_close' as const,
  };
  const bids: BidWithRounds[] = [
    { bid: makeBid({ id: 'bid-a', provider_agent_id: PROV_A }), rounds: [makeRound({ bid_id: 'bid-a', round_no: 1, price_usdc_raw: 300000 })] },
    { bid: makeBid({ id: 'bid-b', provider_agent_id: PROV_B }), rounds: [makeRound({ bid_id: 'bid-b', round_no: 1, price_usdc_raw: 200000 })] },
  ];

  test('a bidder sees only its own thread before close', () => {
    const v = filterVisibleBids({ rfq, bids, viewerAgentId: PROV_A, now: new Date(), cfg: cfg() });
    expect(v.sealed).toBe(true);
    expect(v.visible).toHaveLength(1);
    expect(v.visible[0]?.bid.provider_agent_id).toBe(PROV_A);
    expect(v.hidden_count).toBe(1);
  });

  test('the BUYER also sees no sealed prices by default — the counter-channel leak', () => {
    const v = filterVisibleBids({ rfq, bids, viewerAgentId: BUYER, now: new Date(), cfg: cfg() });
    expect(v.viewer_role).toBe('buyer');
    expect(v.visible).toHaveLength(0);
    expect(v.hidden_count).toBe(2);
  });

  test('after close every participant sees every thread', () => {
    const closed = { ...rfq, bids_close_at: isoIn(-HOUR) };
    for (const viewer of [BUYER, PROV_A, PROV_B]) {
      const v = filterVisibleBids({ rfq: closed, bids, viewerAgentId: viewer, now: new Date(), cfg: cfg() });
      expect(v.sealed).toBe(false);
      expect(v.visible).toHaveLength(2);
    }
  });

  test('an outsider sees nothing', () => {
    const v = filterVisibleBids({ rfq, bids, viewerAgentId: 'z0000000-0000-0000-0000-000000000000', now: new Date(), cfg: cfg() });
    expect(v.viewer_role).toBe('outsider');
    expect(v.visible).toHaveLength(0);
  });
});

describe('RepID never touches a price or an ordering', () => {
  test('bid order is byte-identical across the whole [10, 10000] RepID band', () => {
    const bids: BidWithRounds[] = [
      { bid: makeBid({ id: 'bid-a', provider_agent_id: PROV_A }), rounds: [makeRound({ bid_id: 'bid-a', round_no: 1, price_usdc_raw: 300000 })] },
      { bid: makeBid({ id: 'bid-b', provider_agent_id: PROV_B }), rounds: [makeRound({ bid_id: 'bid-b', round_no: 1, price_usdc_raw: 200000 })] },
    ];
    const baseline = sortBidsDeterministic(bids).map((b) => b.bid.id);
    for (const repid of [10, 499, 500, 999, 1000, 4999, 5000, 7999, 8000, 10000]) {
      const varied = bids.map((b) => ({ ...b, bid: { ...b.bid, provider_repid_at_bid: repid } }));
      expect(sortBidsDeterministic(varied).map((b) => b.bid.id)).toEqual(baseline);
    }
    expect(baseline).toEqual(['bid-b', 'bid-a']);
  });
});

describe('price floor', () => {
  test('1 raw unit is refused — a sub-cent contract would mint the same RepID as a real one', () => {
    const cfg = negotiationConfig();
    const r = validatePrice(1, { min_price_usdc_raw: 10000, max_price_usdc_raw: null }, cfg);
    expect(r.ok).toBe(false);
    expect(r.error).toBe('price_below_floor');
  });

  test('the RFQ reserve raises the floor above the system floor', () => {
    const cfg = negotiationConfig();
    expect(validatePrice(50000, { min_price_usdc_raw: 100000, max_price_usdc_raw: null }, cfg).ok).toBe(false);
    expect(validatePrice(100000, { min_price_usdc_raw: 100000, max_price_usdc_raw: null }, cfg).ok).toBe(true);
  });
});

describe('award rationale', () => {
  test('a single character is not a reason', () => {
    const r = validateAwardRationale('other', 'x');
    expect(r.ok).toBe(false);
  });
  test('a reason code alone is not enough', () => {
    expect(validateAwardRationale('faster_eta', '').ok).toBe(false);
    expect(validateAwardRationale('not_a_code', 'a'.repeat(40)).ok).toBe(false);
  });
  test('a structured code plus real prose passes', () => {
    const r = validateAwardRationale('faster_eta', 'Chosen for a 2h ETA against the cheaper bid at 48h.');
    expect(r.ok).toBe(true);
  });
});

describe('round cap and soft close', () => {
  test('offer number max_rounds*2 + 1 is refused', () => {
    const rfq = { max_rounds: 3 };
    expect(offerCap(rfq)).toBe(6);
    expect(roundCapExceeded({ rounds_used: 5 }, rfq)).toBe(false);
    expect(roundCapExceeded({ rounds_used: 6 }, rfq)).toBe(true);
  });

  test('snipe extension fires inside the window and stops after the cap', () => {
    const cfg = negotiationConfig();
    const now = new Date();
    const rfq = { bids_close_at: new Date(now.getTime() + 30_000).toISOString(), expires_at: isoIn(6 * HOUR), close_extensions: 0 };
    expect(applySnipeExtension(rfq, now, cfg)).not.toBeNull();
    expect(applySnipeExtension({ ...rfq, close_extensions: cfg.maxCloseExtensions }, now, cfg)).toBeNull();
    const early = { ...rfq, bids_close_at: isoIn(2 * HOUR) };
    expect(applySnipeExtension(early, now, cfg)).toBeNull();
  });
});

describe('buyer award ratio is computed from the clock, not from status', () => {
  test('an RFQ nobody ever touched again still counts as a lapse', () => {
    const now = new Date();
    const panel = computeBuyerPanel(
      [
        // harvested and abandoned: status frozen at 'open', clock says lapsed
        { status: 'open', outcome: null, expires_at: isoIn(-HOUR), bid_count: 4 },
        { status: 'open', outcome: null, expires_at: isoIn(-2 * HOUR), bid_count: 3 },
        { status: 'awarded', outcome: 'awarded', expires_at: isoIn(-3 * HOUR) },
        { status: 'open', outcome: null, expires_at: isoIn(HOUR), bid_count: 1 },
      ],
      now,
    );
    expect(panel.expired_no_award).toBe(2);
    expect(panel.rfqs_awarded).toBe(1);
    expect(panel.rfqs_open).toBe(1);
    expect(panel.award_ratio).toBeCloseTo(1 / 3);
    expect(panel.ratio_basis).toBe('timestamp');
  });

  test('cancelling is not a cheaper exit than abandoning', () => {
    const now = new Date();
    const cancelled = computeBuyerPanel([{ status: 'cancelled', outcome: 'cancelled_by_buyer', expires_at: isoIn(HOUR) }], now);
    const abandoned = computeBuyerPanel([{ status: 'open', outcome: null, expires_at: isoIn(-HOUR), bid_count: 2 }], now);
    expect(cancelled.award_ratio).toBe(0);
    expect(abandoned.award_ratio).toBe(0);
  });
});

describe('relatedness and concentration', () => {
  test('buyer<->provider shared keys are detected; the zero address is ignored', () => {
    const w = '0xabcabcabcabcabcabcabcabcabcabcabcabcabca';
    expect(sharedIdentityKeys({ wallet_address: w, signing_address: null, builder_id: null }, { wallet_address: w.toUpperCase(), signing_address: null, builder_id: null })).toEqual(['wallet_address']);
    const zero = '0x0000000000000000000000000000000000000000';
    expect(sharedIdentityKeys({ wallet_address: zero, signing_address: null, builder_id: null }, { wallet_address: zero, signing_address: null, builder_id: null })).toEqual([]);
    expect(operatorFingerprint({ wallet_address: w, signing_address: null, builder_id: 'op-7' })).toBe('op-7');
  });

  test('concentration counts the buyer→provider edge and uncontested awards', () => {
    const c = computeConcentration(
      [
        { buyer_agent_id: BUYER, provider_agent_id: PROV_A, is_uncontested: true },
        { buyer_agent_id: BUYER, provider_agent_id: PROV_A, is_uncontested: true },
        { buyer_agent_id: 'other', provider_agent_id: PROV_A, is_uncontested: false },
      ],
      BUYER,
      PROV_A,
    );
    expect(c.provider_awards_total).toBe(3);
    expect(c.awards_from_this_buyer).toBe(2);
    expect(c.provider_award_share_from_this_buyer).toBeCloseTo(2 / 3);
    expect(c.provider_uncontested_awards).toBe(2);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Route invariants
// ─────────────────────────────────────────────────────────────────────────────

describe('identity binding is enforced at the route, not delegated', () => {
  test('an operator key (no agent binding) is 403 on every write', async () => {
    seedAgents();
    seedClosedRfq();
    const res = await request(makeApp())
      .post('/api/v1/negotiation/rfqs')
      .send({ buyer_agent_id: BUYER, service_type: 'verification', scope: {}, bids_close_at: isoIn(2 * HOUR), expires_at: isoIn(4 * HOUR) });
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('operator_key_forbidden');
  });

  test('a body carrying own agent_id AND a victim provider_agent_id is refused', async () => {
    seedAgents();
    seedClosedRfq();
    // The middleware OR-chain would resolve `agent_id` first and pass. The
    // route compares provider_agent_id directly, so this 403s.
    const res = await request(makeApp())
      .post(`/api/v1/negotiation/rfqs/${RFQ_ID}/bids`)
      .set('x-test-bound-agent', PROV_A)
      .send({ agent_id: PROV_A, provider_agent_id: PROV_B, service_id: SVC_B, price_usdc_raw: 100000, eta_seconds: 3600 });
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('agent_binding_mismatch');
    expect(store['a2a_bids'] ?? []).toHaveLength(0);
  });
});

describe('accept has no price input', () => {
  test('a price field in the accept body is refused outright', async () => {
    seedAgents();
    seedClosedRfq();
    seedTwoBids(300000, 200000);
    const res = await request(makeApp())
      .post(`/api/v1/negotiation/rfqs/${RFQ_ID}/accept`)
      .set('x-test-bound-agent', BUYER)
      .send({ bid_id: 'bid-b', round_id: 'r-bid-b-1', agreed_price_usdc_raw: 1 });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('price_not_accepted_here');
    expect(rpcCalls).toHaveLength(0);
  });

  test('the contract price is the accepted ROUND price, whatever the caller sends', async () => {
    seedAgents();
    seedClosedRfq();
    seedTwoBids(300000, 200000);
    const res = await request(makeApp())
      .post(`/api/v1/negotiation/rfqs/${RFQ_ID}/accept`)
      .set('x-test-bound-agent', BUYER)
      .send({ bid_id: 'bid-b', round_id: 'r-bid-b-1' });
    expect(res.status).toBe(201);
    expect(res.body.awarded_price_usdc_raw).toBe(200000);
    const call = rpcCalls[0];
    expect(call?.name).toBe('a2a_accept_and_award');
    expect(call?.args.p_price_usdc_raw).toBe(200000);
    const contract = (store['service_contracts'] as Row[])[0];
    expect(contract?.agreed_price_usdc_raw).toBe(200000);
    expect(res.body.was_lowest_price).toBe(true);
    expect(res.body.is_uncontested).toBe(false);
  });

  test('a tampered round fails closed and writes nothing', async () => {
    seedAgents();
    seedClosedRfq();
    seedTwoBids(300000, 200000);
    const rounds = store['a2a_bid_rounds'] as Row[];
    const target = rounds.find((r) => r.id === 'r-bid-b-1');
    if (target) target.price_usdc_raw = 1; // hash no longer matches
    const res = await request(makeApp())
      .post(`/api/v1/negotiation/rfqs/${RFQ_ID}/accept`)
      .set('x-test-bound-agent', BUYER)
      .send({ bid_id: 'bid-b', round_id: 'r-bid-b-1' });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('offer_tampered');
    expect(rpcCalls).toHaveLength(0);
    expect(store['service_contracts']).toHaveLength(0);
  });
});

describe('non-lowest and uncontested awards need a real written reason — and nothing is written without one', () => {
  test('awarding the dearer bid with no rationale writes no contract', async () => {
    seedAgents();
    seedClosedRfq();
    seedTwoBids(300000, 200000);
    const res = await request(makeApp())
      .post(`/api/v1/negotiation/rfqs/${RFQ_ID}/accept`)
      .set('x-test-bound-agent', BUYER)
      .send({ bid_id: 'bid-a', round_id: 'r-bid-a-1' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/award_rationale|award_reason_code/);
    expect(rpcCalls).toHaveLength(0);
    expect(store['service_contracts']).toHaveLength(0);
    expect(store['a2a_awards']).toHaveLength(0);
  });

  test('a one-character rationale does not unlock it', async () => {
    seedAgents();
    seedClosedRfq();
    seedTwoBids(300000, 200000);
    const res = await request(makeApp())
      .post(`/api/v1/negotiation/rfqs/${RFQ_ID}/accept`)
      .set('x-test-bound-agent', BUYER)
      .send({ bid_id: 'bid-a', round_id: 'r-bid-a-1', award_reason_code: 'other', award_rationale: 'x' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('award_rationale_too_short');
    expect(rpcCalls).toHaveLength(0);
  });

  test('an UNCONTESTED award needs a written reason even though it is trivially the lowest', async () => {
    seedAgents();
    seedClosedRfq();
    seedTwoBids(300000, 200000);
    // Remove the rival so exactly one valid bid remains.
    store['a2a_bids'] = (store['a2a_bids'] as Row[]).filter((b) => b.id === 'bid-b');
    store['a2a_bid_rounds'] = (store['a2a_bid_rounds'] as Row[]).filter((r) => r.bid_id === 'bid-b');
    const bare = await request(makeApp())
      .post(`/api/v1/negotiation/rfqs/${RFQ_ID}/accept`)
      .set('x-test-bound-agent', BUYER)
      .send({ bid_id: 'bid-b', round_id: 'r-bid-b-1' });
    expect(bare.status).toBe(400);
    expect(bare.body.why).toMatch(/UNCONTESTED/);
    expect(rpcCalls).toHaveLength(0);

    const withReason = await request(makeApp())
      .post(`/api/v1/negotiation/rfqs/${RFQ_ID}/accept`)
      .set('x-test-bound-agent', BUYER)
      .send({
        bid_id: 'bid-b',
        round_id: 'r-bid-b-1',
        award_reason_code: 'sole_eligible_bid',
        award_rationale: 'Only one provider cleared the RepID floor for this scope.',
      });
    expect(withReason.status).toBe(201);
    expect(withReason.body.is_uncontested).toBe(true);
    expect(withReason.body.award_reason_code).toBe('sole_eligible_bid');
  });
});

describe('sealed_close gates', () => {
  function seedOpenSealedRfq() {
    seedClosedRfq();
    const rfq = (store['a2a_rfqs'] as Row[])[0];
    if (rfq) {
      rfq.status = 'open';
      rfq.bids_close_at = isoIn(2 * HOUR);
      rfq.expires_at = isoIn(6 * HOUR);
    }
  }

  test('the buyer cannot counter before the bids close', async () => {
    seedAgents();
    seedOpenSealedRfq();
    seedTwoBids(300000, 200000);
    const res = await request(makeApp())
      .post('/api/v1/negotiation/bids/bid-b/counter')
      .set('x-test-bound-agent', BUYER)
      .send({ price_usdc_raw: 199999, eta_seconds: 3600 });
    expect(res.status).toBe(425);
    expect(res.body.error).toBe('sealed_until_close');
    expect(store['a2a_bid_rounds']).toHaveLength(2);
  });

  test('no award may land before the bids close', async () => {
    seedAgents();
    seedOpenSealedRfq();
    seedTwoBids(300000, 200000);
    const res = await request(makeApp())
      .post(`/api/v1/negotiation/rfqs/${RFQ_ID}/accept`)
      .set('x-test-bound-agent', BUYER)
      .send({ bid_id: 'bid-b', round_id: 'r-bid-b-1' });
    expect(res.status).toBe(425);
    expect(rpcCalls).toHaveLength(0);
  });
});

describe('the accept fails closed when the atomic function is missing', () => {
  test('501 rather than a partial sequential write', async () => {
    seedAgents();
    seedClosedRfq();
    seedTwoBids(300000, 200000);
    rpcHandler = () => ({ data: null, error: { code: '42883', message: 'function public.a2a_accept_and_award does not exist' } });
    const res = await request(makeApp())
      .post(`/api/v1/negotiation/rfqs/${RFQ_ID}/accept`)
      .set('x-test-bound-agent', BUYER)
      .send({ bid_id: 'bid-b', round_id: 'r-bid-b-1' });
    expect(res.status).toBe(501);
    expect(res.body.error).toBe('negotiation_rpc_not_installed');
    expect(store['service_contracts']).toHaveLength(0);
  });
});

describe('negotiation is RepID-neutral', () => {
  test('no negotiation write touches repid_score_events or repid_proof_queue', async () => {
    seedAgents();
    seedClosedRfq();
    seedTwoBids(300000, 200000);
    await request(makeApp())
      .post(`/api/v1/negotiation/rfqs/${RFQ_ID}/accept`)
      .set('x-test-bound-agent', BUYER)
      .send({ bid_id: 'bid-b', round_id: 'r-bid-b-1' });
    expect(store['repid_score_events']).toBeUndefined();
    expect(store['repid_proof_queue']).toBeUndefined();
    expect(store['repid_agents']?.map((a) => a.current_repid)).toEqual([2000, 1500, 1500]);
  });
});
