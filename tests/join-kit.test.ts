import express from 'express';
import request from 'supertest';
import { exactTrueFlags, TRUTHY } from '../src/config/flag-readiness';
import { joinKit } from '../src/services/join-kit';
import joinKitRouter from '../src/routes/join-kit';

describe('join kit', () => {
  const savedBind = process.env.HUMAN_AGENT_BIND_ENABLED;
  const savedStake = process.env.REAL_STAKING_ENABLED;

  afterEach(() => {
    if (savedBind === undefined) delete process.env.HUMAN_AGENT_BIND_ENABLED;
    else process.env.HUMAN_AGENT_BIND_ENABLED = savedBind;
    if (savedStake === undefined) delete process.env.REAL_STAKING_ENABLED;
    else process.env.REAL_STAKING_ENABLED = savedStake;
  });

  it('can_verify is true and can_stake stays false even when staking is exact true', () => {
    delete process.env.HUMAN_AGENT_BIND_ENABLED;
    process.env.REAL_STAKING_ENABLED = 'true';
    const card = joinKit(process.env);
    expect(card).toEqual({ can_verify: true, can_bind: false, can_stake: false });
    expect(exactTrueFlags({ REAL_STAKING_ENABLED: 'true' }).REAL_STAKING_ENABLED).toBe(true);
    expect(card.can_stake).toBe(false);
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

  it('GET /api/v1/join-kit returns the card', async () => {
    delete process.env.HUMAN_AGENT_BIND_ENABLED;
    const app = express();
    app.use('/api/v1', joinKitRouter);
    const res = await request(app).get('/api/v1/join-kit');
    expect(res.status).toBe(200);
    expect(res.body.can_verify).toBe(true);
    expect(res.body.can_bind).toBe(false);
    expect(res.body.can_stake).toBe(false);
  });
});
