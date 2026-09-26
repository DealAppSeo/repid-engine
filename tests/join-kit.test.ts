import express from 'express';
import request from 'supertest';
import { exactTrueFlags, TRUTHY } from '../src/config/flag-readiness';
import joinKitRouter, { joinKit } from '../src/routes/join-kit';

describe('GET /api/v1/join-kit', () => {
  const savedBind = process.env.HUMAN_AGENT_BIND_ENABLED;
  const savedStake = process.env.REAL_STAKING_ENABLED;

  afterEach(() => {
    if (savedBind === undefined) delete process.env.HUMAN_AGENT_BIND_ENABLED;
    else process.env.HUMAN_AGENT_BIND_ENABLED = savedBind;
    if (savedStake === undefined) delete process.env.REAL_STAKING_ENABLED;
    else process.env.REAL_STAKING_ENABLED = savedStake;
  });

  it('names the doors, can verify, and keeps can_stake false', async () => {
    delete process.env.HUMAN_AGENT_BIND_ENABLED;
    process.env.REAL_STAKING_ENABLED = 'true';
    const app = express();
    app.use('/api/v1', joinKitRouter);
    const res = await request(app).get('/api/v1/join-kit');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      verify: '/api/v1/repid/verify',
      status: '/readiness',
      repid: '/api/v1/repid/:agentId',
      proof: '/api/v1/proof/verify',
      honesty_a: '/api/v1/hal/honesty-a',
      after_create: '/api/v1/after-create',
      can_verify: true,
      can_bind: false,
      can_stake: false,
    });
    expect(exactTrueFlags({ REAL_STAKING_ENABLED: 'true' }).REAL_STAKING_ENABLED).toBe(true);
    expect(joinKit(process.env).can_stake).toBe(false);
  });

  it('can_bind follows the exact-true bind flag', () => {
    expect(joinKit({ HUMAN_AGENT_BIND_ENABLED: TRUTHY }).can_bind).toBe(true);
    expect(joinKit({ HUMAN_AGENT_BIND_ENABLED: 'TRUE' }).can_bind).toBe(false);
    expect(joinKit({ HUMAN_AGENT_BIND_ENABLED: '1' }).can_bind).toBe(false);
    expect(joinKit({}).can_bind).toBe(false);
    expect(joinKit({ HUMAN_AGENT_BIND_ENABLED: 'true', REAL_STAKING_ENABLED: 'true' }).can_stake).toBe(
      false,
    );
  });
});
