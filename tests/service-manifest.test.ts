/**
 * The canonical service manifest — spec TRUSTMARKET_UX_MERGED_SPEC_v1 §1.2/§4/§10.
 *
 * The spec's second load-bearing idea is that the human page and the machine
 * endpoint are two renderers of ONE object, so drift is impossible by
 * construction. That only holds if the object refuses to flatter itself, so what
 * is pinned here is mostly what it must NOT say:
 *
 *   · a success rate with no denominator
 *   · a rate at all when there is no sample
 *   · "$0.00 at risk" when the truth is "no stake recorded"
 *   · a fabricated sample receipt when the provider has never settled anything
 *   · an inactive service rendered as live
 */

interface DbState {
  service: any;
  agent: any;
  settledCount: number;
  disputedCount: number;
  stakes: any[];
  sample: any[];
}
const st: DbState = {
  service: null,
  agent: null,
  settledCount: 0,
  disputedCount: 0,
  stakes: [],
  sample: [],
};

function makeQuery(table: string) {
  const q: any = {};
  const filters: Array<[string, unknown]> = [];
  let notDisputed = false;
  let headCount = false;

  q.select = (_sel?: string, opts?: any) => {
    if (opts && opts.head) headCount = true;
    return q;
  };
  q.eq = (c: string, v: unknown) => {
    filters.push([c, v]);
    return q;
  };
  q.not = (c: string) => {
    if (c === 'disputed_at') notDisputed = true;
    return q;
  };
  q.order = () => q;
  q.limit = () => q;

  const countResult = () => {
    if (table !== 'service_contracts') return { count: 0, data: [], error: null };
    if (notDisputed) return { count: st.disputedCount, data: [], error: null };
    const wantsSettled = filters.some(([c, v]) => c === 'status' && v === 'settled');
    return { count: wantsSettled ? st.settledCount : 0, data: [], error: null };
  };

  q.maybeSingle = async () => {
    if (table === 'agent_services') return { data: st.service, error: null };
    if (table === 'repid_agents') return { data: st.agent, error: null };
    return { data: null, error: null };
  };
  q.single = q.maybeSingle;

  q.then = (resolve: any) => {
    if (headCount) return resolve(countResult());
    if (table === 'agent_stakes') return resolve({ data: st.stakes, error: null });
    if (table === 'service_contracts') return resolve({ data: st.sample, error: null });
    if (table === 'agent_services') return resolve({ data: st.service ? [st.service] : [], error: null });
    return resolve({ data: [], error: null });
  };
  return q;
}

jest.mock('../src/db', () => ({ db: { from: (t: string) => makeQuery(t) } }));

import { buildServiceManifest, buildTrackRecord, MIN_MEANINGFUL_JOBS } from '../src/services/service-manifest';

const SERVICE_ID = 'svc-1';

beforeEach(() => {
  st.service = {
    id: SERVICE_ID,
    provider_agent_id: 'prov-1',
    service_type: 'verification',
    service_name: 'Constitutional Verification',
    description: 'checks a claim',
    base_price_usdc_raw: 100000,
    min_repid_to_purchase: 500,
    active: true,
  };
  st.agent = { id: 'prov-1', agent_name: 'trinity-orch', current_repid: 1611, tier: 'ESTABLISHED', erc8004_token_id: '6705' };
  st.settledCount = 0;
  st.disputedCount = 0;
  st.stakes = [];
  st.sample = [];
});

// ===========================================================================
describe('track record is always denominatored (§10)', () => {
  it('never reports a rate with no sample', () => {
    const t = buildTrackRecord(0, 0);
    expect(t.verified_rate).toBeNull();
    expect(t.summary).toBe('No completed jobs yet.');
  });

  it('carries the denominator, not a bare percentage', () => {
    const t = buildTrackRecord(412, 3);
    expect(t.summary).toContain('412 settled jobs');
    expect(t.summary).toContain('3 disputes');
    expect(t.summary).toContain('%');
  });

  it('warns when a perfect rate rests on one job — the most misleading number available', () => {
    const t = buildTrackRecord(1, 0);
    expect(t.verified_rate).toBe(100);
    expect(t.sample_size_warning).toBe(true);
    expect(t.summary).toMatch(/too few jobs/);
  });

  it('stops warning once the sample is meaningful', () => {
    const t = buildTrackRecord(MIN_MEANINGFUL_JOBS, 0);
    expect(t.sample_size_warning).toBe(false);
    expect(t.summary).not.toMatch(/too few jobs/);
  });

  it('counts disputes against the rate rather than hiding them', () => {
    const t = buildTrackRecord(9, 1);
    expect(t.verified_rate).toBe(90);
    expect(t.summary).toContain('1 dispute');
  });
});

// ===========================================================================
describe('stake-at-risk tells the truth about absence (§11)', () => {
  it('reports null and a reason when no stake exists — never $0.00', async () => {
    const m = (await buildServiceManifest(SERVICE_ID))!;
    expect(m.provider.stake_at_risk_usdc).toBeNull();
    expect(m.provider.stake_status).toBe('none_recorded');
    expect(m.provider.stake_note).toMatch(/nothing of the provider's is financially at risk/i);
    expect(m.caveats.join(' ')).toMatch(/No stake is recorded/);
  });

  it('reports the amount when stake actually exists', async () => {
    st.stakes = [{ stake_amount: 5_000_000, status: 'active' }];
    const m = (await buildServiceManifest(SERVICE_ID))!;
    expect(m.provider.stake_at_risk_usdc).toBe(5);
    expect(m.provider.stake_status).toBe('recorded');
    expect(m.caveats.join(' ')).not.toMatch(/No stake is recorded/);
  });
});

// ===========================================================================
describe('sample receipt is real or absent', () => {
  it('is null when the provider has never settled anything', async () => {
    const m = (await buildServiceManifest(SERVICE_ID))!;
    expect(m.sample_receipt).toBeNull();
    expect(m.caveats.join(' ')).toMatch(/never completed a job/);
  });

  it('links a real settled contract when one exists', async () => {
    st.settledCount = 12;
    st.sample = [{ id: 'contract-9', settled_at: '2026-08-02T18:52:59Z' }];
    const m = (await buildServiceManifest(SERVICE_ID))!;
    expect(m.sample_receipt!.contract_id).toBe('contract-9');
    expect(m.sample_receipt!.url).toContain('/api/v1/receipt/contract-9.json');
  });
});

// ===========================================================================
describe('one object, two renderers (§1.2)', () => {
  it('names both renderers on the object so neither can drift unnoticed', async () => {
    const m = (await buildServiceManifest(SERVICE_ID))!;
    expect(m.renderers.machine).toContain(`/api/v1/services/${SERVICE_ID}/manifest.json`);
    expect(m.renderers.human).toContain(`/service/${SERVICE_ID}`);
  });

  it('carries price in both raw and human units so renderers never re-derive it', async () => {
    const m = (await buildServiceManifest(SERVICE_ID))!;
    expect(m.price.amount_usdc_raw).toBe(100000);
    expect(m.price.amount_usdc).toBe('0.100000');
    expect(m.price.chain_id).toBe(84532);
  });
});

// ===========================================================================
describe('an inactive service is not served as live', () => {
  it('returns null rather than a manifest', async () => {
    st.service = { ...st.service, active: false };
    expect(await buildServiceManifest(SERVICE_ID)).toBeNull();
  });

  it('returns null for an unknown service', async () => {
    st.service = null;
    expect(await buildServiceManifest(SERVICE_ID)).toBeNull();
  });
});
