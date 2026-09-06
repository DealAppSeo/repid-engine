import request from 'supertest';
import express from 'express';
import { adminFlagsRouter } from '../admin-flags';
import { getHalConfig } from '../../hal/config';

const app = express();
app.use(express.json());
app.use('/api/v1/admin/flags', adminFlagsRouter);

jest.mock('../../hal/config', () => ({
  getHalConfig: jest.fn(),
}));

const mockGetHalConfig = getHalConfig as jest.Mock;

describe('Admin Flags', () => {
  beforeEach(() => {
    process.env.ADMIN_KEY = 'secret';
    delete process.env.REPID_PURPOSE_GATE_V3;
    delete process.env.ROUTER_STRICT_COST_ORDER;
    delete process.env.PEER_VERIFY_PANEL_ENABLED;
    delete process.env.HAL_CHRONIC_FLAG_ENABLED;
    delete process.env.PRODUCER_HALT_CLASSES;
    delete process.env.MOCK_FACILITATOR;
    delete process.env.OBSERVABILITY_REQUIRE_AUTH;
    delete process.env.RESILIENCE_REQUIRE_AUTH;
    delete process.env.WRITER_DIRECT_APPLY;
    delete process.env.STAKE_DEPOSIT_AUTH_ENFORCED;
    mockGetHalConfig.mockResolvedValue({
      providers: { HAL_S2_ENABLE_GROQ: true, HAL_S2_ENABLE_CEREBRAS: true },
      strictness: 2,
      decisionRequiresQuorum: true,
      penaltyRequiresQuorum: true,
      source: {
        HAL_S2_ENABLE_GROQ: 'default',
        HAL_S2_ENABLE_CEREBRAS: 'default',
        HAL_DECISION_REQUIRES_QUORUM: 'default',
        HAL_PENALTY_REQUIRES_QUORUM: 'default',
        HAL_STRICTNESS: 'default',
      },
    });
    jest.clearAllMocks();
  });

  it('GET without admin key -> 401', async () => {
    const res = await request(app).get('/api/v1/admin/flags');
    expect(res.status).toBe(401);
  });

  it('GET with wrong admin key -> 401', async () => {
    const res = await request(app).get('/api/v1/admin/flags').set('x-admin-key', 'wrong');
    expect(res.status).toBe(401);
  });

  it('unset ADMIN_KEY -> 503, not a silent open door', async () => {
    delete process.env.ADMIN_KEY;
    const res = await request(app).get('/api/v1/admin/flags');
    expect(res.status).toBe(503);
  });

  it('GET with valid key -> 200, ROUTER_STRICT_COST_ORDER defaults true (inverted default)', async () => {
    mockGetHalConfig.mockResolvedValue({
      providers: {},
      strictness: 2,
      decisionRequiresQuorum: true,
      penaltyRequiresQuorum: true,
      source: { HAL_DECISION_REQUIRES_QUORUM: 'default', HAL_PENALTY_REQUIRES_QUORUM: 'default', HAL_STRICTNESS: 'default' },
    });
    const res = await request(app).get('/api/v1/admin/flags').set('x-admin-key', 'secret');
    expect(res.status).toBe(200);
    expect(res.body.router_strict_cost_order).toEqual({ value: true, source: 'default' });
    expect(res.body.repid_purpose_gate_v3).toEqual({ value: false, source: 'default' });
  });

  it('ROUTER_STRICT_COST_ORDER=false -> reports false, source env', async () => {
    process.env.ROUTER_STRICT_COST_ORDER = 'false';
    const res = await request(app).get('/api/v1/admin/flags').set('x-admin-key', 'secret');
    expect(res.body.router_strict_cost_order).toEqual({ value: false, source: 'env' });
  });

  it('getHalConfig() throwing degrades to UNAVAILABLE, not a guess', async () => {
    mockGetHalConfig.mockRejectedValue(new Error('db down'));
    const res = await request(app).get('/api/v1/admin/flags').set('x-admin-key', 'secret');
    expect(res.status).toBe(200);
    expect(res.body.hal_s2).toEqual({ error: 'UNAVAILABLE', detail: expect.any(String) });
  });

  it('PRODUCER_HALT_CLASSES unset -> peer_verify not halted, empty list, source default', async () => {
    const res = await request(app).get('/api/v1/admin/flags').set('x-admin-key', 'secret');
    expect(res.body.producer_halt_classes).toEqual({ value: [], peer_verify_halted: false, source: 'default' });
  });

  it('PRODUCER_HALT_CLASSES="peer_verify,foo" -> parsed list, peer_verify_halted true', async () => {
    process.env.PRODUCER_HALT_CLASSES = 'peer_verify,foo';
    const res = await request(app).get('/api/v1/admin/flags').set('x-admin-key', 'secret');
    expect(res.body.producer_halt_classes).toEqual({
      value: ['peer_verify', 'foo'],
      peer_verify_halted: true,
      source: 'env',
    });
  });

  it('PRODUCER_HALT_CLASSES="all" -> peer_verify_halted true via wildcard', async () => {
    process.env.PRODUCER_HALT_CLASSES = 'all';
    const res = await request(app).get('/api/v1/admin/flags').set('x-admin-key', 'secret');
    expect(res.body.producer_halt_classes.peer_verify_halted).toBe(true);
  });

  it('MOCK_FACILITATOR three states are distinguishable', async () => {
    const unset = await request(app).get('/api/v1/admin/flags').set('x-admin-key', 'secret');
    expect(unset.body.mock_facilitator).toEqual({ value: 'unset (real on-chain settlement path)', source: 'default' });

    process.env.MOCK_FACILITATOR = 'true';
    const simulated = await request(app).get('/api/v1/admin/flags').set('x-admin-key', 'secret');
    expect(simulated.body.mock_facilitator).toEqual({ value: 'true (simulated settlement)', source: 'env' });

    process.env.MOCK_FACILITATOR = 'false';
    const disabled = await request(app).get('/api/v1/admin/flags').set('x-admin-key', 'secret');
    expect(disabled.body.mock_facilitator).toEqual({ value: 'false (settlement disabled, pending_funding)', source: 'env' });
  });

  it('PEER_VERIFY_PANEL_ENABLED and HAL_CHRONIC_FLAG_ENABLED default false', async () => {
    const res = await request(app).get('/api/v1/admin/flags').set('x-admin-key', 'secret');
    expect(res.body.peer_verify_panel_enabled).toEqual({ value: false, source: 'default' });
    expect(res.body.hal_chronic_flag_enabled).toEqual({ value: false, source: 'default' });
  });

  it('OBSERVABILITY_REQUIRE_AUTH and RESILIENCE_REQUIRE_AUTH default false', async () => {
    const res = await request(app).get('/api/v1/admin/flags').set('x-admin-key', 'secret');
    expect(res.body.observability_require_auth).toEqual({ value: false, source: 'default' });
    expect(res.body.resilience_require_auth).toEqual({ value: false, source: 'default' });
  });

  it('OBSERVABILITY_REQUIRE_AUTH=true and RESILIENCE_REQUIRE_AUTH=true -> reports true, source env', async () => {
    process.env.OBSERVABILITY_REQUIRE_AUTH = 'true';
    process.env.RESILIENCE_REQUIRE_AUTH = 'true';
    const res = await request(app).get('/api/v1/admin/flags').set('x-admin-key', 'secret');
    expect(res.body.observability_require_auth).toEqual({ value: true, source: 'env' });
    expect(res.body.resilience_require_auth).toEqual({ value: true, source: 'env' });
  });

  it('WRITER_DIRECT_APPLY and STAKE_DEPOSIT_AUTH_ENFORCED both default true (inverted defaults)', async () => {
    const res = await request(app).get('/api/v1/admin/flags').set('x-admin-key', 'secret');
    expect(res.body.writer_direct_apply).toEqual({
      value: true,
      source: 'default',
      note: expect.stringContaining('startRepidSyncWorker'),
    });
    expect(res.body.stake_deposit_auth_enforced).toEqual({ value: true, source: 'default' });
  });

  it('WRITER_DIRECT_APPLY=false and STAKE_DEPOSIT_AUTH_ENFORCED=false -> reports false, source env', async () => {
    process.env.WRITER_DIRECT_APPLY = 'false';
    process.env.STAKE_DEPOSIT_AUTH_ENFORCED = 'false';
    const res = await request(app).get('/api/v1/admin/flags').set('x-admin-key', 'secret');
    expect(res.body.writer_direct_apply.value).toBe(false);
    expect(res.body.writer_direct_apply.source).toBe('env');
    expect(res.body.stake_deposit_auth_enforced).toEqual({ value: false, source: 'env' });
  });
});
