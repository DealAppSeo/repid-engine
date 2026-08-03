/**
 * listing → contract bridge.
 *
 * The "buy" button had nowhere to land: marketplace_listings had list and browse,
 * marketplace_offers was a table with no endpoints, and the RFQ engine is a
 * separate entry. This is the join.
 *
 * The two failure modes worth most of the tests:
 *
 *   1. PAYING THE WRONG PARTY. A listing's `kind` decides direction — 'have'
 *      means the poster provides, 'want' means the poster buys. Invert it and
 *      money flows backwards. Tested both ways.
 *
 *   2. MINTING AN ELIGIBILITY PROOF. service_contracts.service_id is a NOT NULL
 *      FK to agent_services, and the RFQ path calls it "the provide-side
 *      eligibility proof". The shortcut is to auto-create a service per listing to
 *      satisfy the FK — which would let anyone type a title and become a
 *      publisher, and would make the manifest/catalog/llms.txt start reporting
 *      listings as capabilities. Refused, and pinned here.
 */

interface DbState {
  listing: any;
  offer: any;
  service: any;
  binding: any[];
  inserts: Array<{ table: string; row: any }>;
  updates: Array<{ table: string; patch: any }>;
  insertError: any;
  contractId: string;
}
const st: DbState = {
  listing: null,
  offer: null,
  service: null,
  binding: [],
  inserts: [],
  updates: [],
  insertError: null,
  contractId: 'contract-new',
};

function makeQuery(table: string) {
  const q: any = {};
  let pendingPatch: any = null;

  q.select = () => q;
  q.eq = () => q;
  q.is = () => q;
  q.order = () => q;
  q.limit = () => q;

  q.maybeSingle = async () => {
    if (table === 'marketplace_listings') return { data: st.listing, error: null };
    if (table === 'marketplace_offers') return { data: st.offer, error: null };
    if (table === 'agent_services') return { data: st.service, error: null };
    return { data: null, error: null };
  };
  q.single = async () => {
    if (pendingInsert) {
      const row = pendingInsert;
      pendingInsert = null;
      if (st.insertError) return { data: null, error: st.insertError };
      if (row.table === 'service_contracts') return { data: { id: st.contractId }, error: null };
      return { data: { ...row.row, id: 'offer-new', created_at: 'now' }, error: null };
    }
    return q.maybeSingle();
  };

  let pendingInsert: { table: string; row: any } | null = null;
  q.insert = (row: any) => {
    st.inserts.push({ table, row });
    pendingInsert = { table, row };
    return q;
  };
  q.update = (patch: any) => {
    pendingPatch = patch;
    return q;
  };
  q.then = (resolve: any) => {
    if (pendingPatch) {
      st.updates.push({ table, patch: pendingPatch });
      pendingPatch = null;
      return resolve({ data: null, error: null });
    }
    if (table === 'human_agent_bindings') return resolve({ data: st.binding, error: null });
    return resolve({ data: [], error: null });
  };
  return q;
}

jest.mock('../src/db', () => ({ db: { from: (t: string) => makeQuery(t) } }));

const ORIGINAL_ENV = { ...process.env };

function load() {
  let mod: typeof import('../src/services/listing-bridge');
  jest.isolateModules(() => {
    mod = require('../src/services/listing-bridge');
  });
  return mod!;
}

const AGENT_POSTER = 'aaaa1111-1111-4111-8111-aaaaaaaaaaaa';
const AGENT_OFFERER = 'bbbb2222-2222-4222-8222-bbbbbbbbbbbb';
const SERVICE_ID = 'svc-1';

beforeEach(() => {
  st.listing = {
    id: 'listing-1',
    poster_type: 'agent',
    poster_id: AGENT_POSTER,
    kind: 'have',
    status: 'open',
    price_usdc: 0.5,
  };
  st.offer = {
    id: 'offer-1',
    listing_id: 'listing-1',
    offerer_id: AGENT_OFFERER,
    offerer_type: 'agent',
    amount_usdc: 0.5,
    message: null,
    status: 'pending',
  };
  st.service = { id: SERVICE_ID, provider_agent_id: AGENT_POSTER, active: true, base_price_usdc_raw: 500000 };
  st.binding = [];
  st.inserts = [];
  st.updates = [];
  st.insertError = null;
  process.env = { ...ORIGINAL_ENV, LISTING_BRIDGE_ENABLED: 'true' };
});

afterAll(() => {
  process.env = ORIGINAL_ENV;
});

// ===========================================================================
describe('direction — a mistake here pays the wrong party', () => {
  it("'have': the poster provides, the offerer buys", () => {
    const { resolveRoles } = load();
    const r = resolveRoles('have', { type: 'agent', id: 'P' }, { type: 'agent', id: 'O' });
    expect(r.provider.id).toBe('P');
    expect(r.buyer.id).toBe('O');
  });

  it("'want': the poster buys, the offerer provides", () => {
    const { resolveRoles } = load();
    const r = resolveRoles('want', { type: 'agent', id: 'P' }, { type: 'agent', id: 'O' });
    expect(r.buyer.id).toBe('P');
    expect(r.provider.id).toBe('O');
  });

  it('a `want` listing puts the poster on the buyer side of the real contract', async () => {
    const { acceptOffer } = load();
    st.listing = { ...st.listing, kind: 'want' };
    st.service = { ...st.service, provider_agent_id: AGENT_OFFERER }; // offerer provides
    const r = await acceptOffer({
      offerId: 'offer-1',
      caller: { type: 'agent', id: AGENT_POSTER },
      serviceId: SERVICE_ID,
    });
    expect(r.ok).toBe(true);
    expect(r.data!.buyer_agent_id).toBe(AGENT_POSTER);
    expect(r.data!.provider_agent_id).toBe(AGENT_OFFERER);
  });
});

// ===========================================================================
describe('the eligibility proof is never minted', () => {
  it('refuses without a service_id rather than creating one', async () => {
    const { acceptOffer } = load();
    const r = await acceptOffer({ offerId: 'offer-1', caller: { type: 'agent', id: AGENT_POSTER } });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('service_required');
    expect(st.inserts.find((i) => i.table === 'agent_services')).toBeUndefined();
    expect(st.inserts.find((i) => i.table === 'service_contracts')).toBeUndefined();
  });

  it("refuses a service owned by somebody other than the provider", async () => {
    const { acceptOffer } = load();
    st.service = { ...st.service, provider_agent_id: 'someone-else' };
    const r = await acceptOffer({
      offerId: 'offer-1',
      caller: { type: 'agent', id: AGENT_POSTER },
      serviceId: SERVICE_ID,
    });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('service_not_owned_by_provider');
  });

  it('refuses an inactive service', async () => {
    const { acceptOffer } = load();
    st.service = { ...st.service, active: false };
    const r = await acceptOffer({
      offerId: 'offer-1',
      caller: { type: 'agent', id: AGENT_POSTER },
      serviceId: SERVICE_ID,
    });
    expect(r.reason).toBe('service_not_found');
  });
});

// ===========================================================================
describe('who may accept', () => {
  it('only the poster', async () => {
    const { acceptOffer } = load();
    const r = await acceptOffer({
      offerId: 'offer-1',
      caller: { type: 'agent', id: 'a-stranger' },
      serviceId: SERVICE_ID,
    });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('not_the_poster');
  });

  it('refuses an offer on your own listing', async () => {
    const { createOffer } = load();
    const r = await createOffer({
      listingId: 'listing-1',
      offerer: { type: 'agent', id: AGENT_POSTER },
    });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('self_dealing');
  });

  it('refuses when both sides resolve to the same agent — before the DB constraint fires', async () => {
    const { acceptOffer } = load();
    st.offer = { ...st.offer, offerer_id: AGENT_POSTER };
    const r = await acceptOffer({
      offerId: 'offer-1',
      caller: { type: 'agent', id: AGENT_POSTER },
      serviceId: SERVICE_ID,
    });
    expect(r.reason).toBe('self_dealing');
  });
});

// ===========================================================================
describe('humans transact through an agent they own (spec §2)', () => {
  it('refuses when ownership binding is disabled, and says an A2A exchange works today', async () => {
    process.env.HUMAN_AGENT_BIND_ENABLED = 'false';
    const { acceptOffer } = load();
    st.listing = { ...st.listing, poster_type: 'human', poster_id: 'builder-1' };
    const r = await acceptOffer({
      offerId: 'offer-1',
      caller: { type: 'human', id: 'builder-1' },
      serviceId: SERVICE_ID,
    });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('binding_disabled');
    expect(r.detail).toMatch(/agent-to-agent exchange works today/);
  });

  it('refuses a human with no bound agent rather than picking one', async () => {
    process.env.HUMAN_AGENT_BIND_ENABLED = 'true';
    const { acceptOffer } = load();
    st.listing = { ...st.listing, poster_type: 'human', poster_id: 'builder-1' };
    st.binding = [];
    const r = await acceptOffer({
      offerId: 'offer-1',
      caller: { type: 'human', id: 'builder-1' },
      serviceId: SERVICE_ID,
    });
    expect(r.reason).toBe('human_not_bound');
    expect(st.inserts.find((i) => i.table === 'service_contracts')).toBeUndefined();
  });

  it('resolves a bound human to their agent', async () => {
    process.env.HUMAN_AGENT_BIND_ENABLED = 'true';
    const { resolveToAgent } = load();
    st.binding = [{ agent_id: AGENT_POSTER }];
    const r = await resolveToAgent({ type: 'human', id: 'builder-1' });
    expect(r.ok).toBe(true);
    expect(r.data).toBe(AGENT_POSTER);
  });
});

// ===========================================================================
describe('the contract that comes out', () => {
  it('is pending, priced, and points back at the listing', async () => {
    const { acceptOffer } = load();
    const r = await acceptOffer({
      offerId: 'offer-1',
      caller: { type: 'agent', id: AGENT_POSTER },
      serviceId: SERVICE_ID,
    });
    expect(r.ok).toBe(true);
    const row = st.inserts.find((i) => i.table === 'service_contracts')!.row;
    expect(row.status).toBe('pending');
    expect(row.agreed_price_usdc_raw).toBe(500000);
    expect(row.service_id).toBe(SERVICE_ID);
    expect(row.payload.listing_id).toBe('listing-1');
    expect(row.payload.source).toBe('marketplace_listing');
  });

  it('hands off to escrow and says no money has moved', async () => {
    const { acceptOffer } = load();
    const r = await acceptOffer({
      offerId: 'offer-1',
      caller: { type: 'agent', id: AGENT_POSTER },
      serviceId: SERVICE_ID,
    });
    expect(r.data!.next).toContain('/escrow');
  });

  it('marks the listing matched and the offer accepted', async () => {
    const { acceptOffer } = load();
    await acceptOffer({ offerId: 'offer-1', caller: { type: 'agent', id: AGENT_POSTER }, serviceId: SERVICE_ID });
    expect(st.updates.some((u) => u.table === 'marketplace_offers' && u.patch.status === 'accepted')).toBe(true);
    expect(st.updates.some((u) => u.table === 'marketplace_listings' && u.patch.status === 'matched')).toBe(true);
  });

  it('refuses a zero price — the DB CHECK requires > 0', async () => {
    const { acceptOffer } = load();
    st.offer = { ...st.offer, amount_usdc: 0 };
    st.listing = { ...st.listing, price_usdc: 0 };
    st.service = { ...st.service, base_price_usdc_raw: 0 };
    const r = await acceptOffer({
      offerId: 'offer-1',
      caller: { type: 'agent', id: AGENT_POSTER },
      serviceId: SERVICE_ID,
    });
    expect(r.reason).toBe('invalid_amount');
  });
});

// ===========================================================================
describe('state guards and the flag', () => {
  it('is inert by default', async () => {
    delete process.env.LISTING_BRIDGE_ENABLED;
    const { createOffer, acceptOffer, LISTING_BRIDGE_ENABLED } = load();
    expect(LISTING_BRIDGE_ENABLED).toBe(false);
    expect((await createOffer({ listingId: 'listing-1', offerer: { type: 'agent', id: AGENT_OFFERER } })).reason).toBe('disabled');
    expect((await acceptOffer({ offerId: 'offer-1', caller: { type: 'agent', id: AGENT_POSTER } })).reason).toBe('disabled');
    expect(st.inserts).toHaveLength(0);
  });

  it('refuses an offer on a listing that is not open', async () => {
    const { createOffer } = load();
    st.listing = { ...st.listing, status: 'matched' };
    const r = await createOffer({ listingId: 'listing-1', offerer: { type: 'agent', id: AGENT_OFFERER } });
    expect(r.reason).toBe('listing_not_open');
  });

  it('refuses to accept an already-accepted offer', async () => {
    const { acceptOffer } = load();
    st.offer = { ...st.offer, status: 'accepted' };
    const r = await acceptOffer({ offerId: 'offer-1', caller: { type: 'agent', id: AGENT_POSTER }, serviceId: SERVICE_ID });
    expect(r.reason).toBe('offer_not_pending');
  });

  it('reads a service_id carried on the offer when none is passed at accept', async () => {
    const { acceptOffer, serviceIdFromOffer } = load();
    expect(serviceIdFromOffer(JSON.stringify({ service_id: SERVICE_ID }))).toBe(SERVICE_ID);
    st.offer = { ...st.offer, message: JSON.stringify({ note: 'hi', service_id: SERVICE_ID }) };
    const r = await acceptOffer({ offerId: 'offer-1', caller: { type: 'agent', id: AGENT_POSTER } });
    expect(r.ok).toBe(true);
  });

  it('treats a plain-text message as having no service_id', () => {
    const { serviceIdFromOffer } = load();
    expect(serviceIdFromOffer('just a note')).toBeNull();
    expect(serviceIdFromOffer(null)).toBeNull();
  });
});
