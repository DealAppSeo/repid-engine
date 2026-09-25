import { readFileSync } from 'fs';
import { join, resolve } from 'path';
import express from 'express';
import request from 'supertest';
import { exactTrueFlags, TRUTHY } from '../src/config/flag-readiness';
import { afterCreateCard } from '../src/services/after-create';
import afterCreateRouter from '../src/routes/after-create';

const SRC = resolve(__dirname, '..', 'src');

describe('after-create card', () => {
  const savedBind = process.env.HUMAN_AGENT_BIND_ENABLED;
  const savedStake = process.env.REAL_STAKING_ENABLED;

  afterEach(() => {
    if (savedBind === undefined) delete process.env.HUMAN_AGENT_BIND_ENABLED;
    else process.env.HUMAN_AGENT_BIND_ENABLED = savedBind;
    if (savedStake === undefined) delete process.env.REAL_STAKING_ENABLED;
    else process.env.REAL_STAKING_ENABLED = savedStake;
  });

  it('can_verify is true, can_stake stays false, and can_rate_models is false', () => {
    delete process.env.HUMAN_AGENT_BIND_ENABLED;
    process.env.REAL_STAKING_ENABLED = 'true';
    const card = afterCreateCard(process.env);
    expect(card).toEqual({
      has_agent: false,
      can_verify: true,
      can_bind: false,
      can_stake: false,
      can_rate_models: false,
    });
    expect(exactTrueFlags({ REAL_STAKING_ENABLED: 'true' }).REAL_STAKING_ENABLED).toBe(true);
    expect(card.can_stake).toBe(false);
  });

  it('can_bind matches the readiness exact-true rule', () => {
    expect(afterCreateCard({ HUMAN_AGENT_BIND_ENABLED: TRUTHY }).can_bind).toBe(
      exactTrueFlags({ OWNER_CEILING_SHADOW_ENABLED: TRUTHY }).OWNER_CEILING_SHADOW_ENABLED,
    );
    expect(afterCreateCard({ HUMAN_AGENT_BIND_ENABLED: 'TRUE' }).can_bind).toBe(
      exactTrueFlags({ OWNER_CEILING_SHADOW_ENABLED: 'TRUE' }).OWNER_CEILING_SHADOW_ENABLED,
    );
    expect(afterCreateCard({}).can_bind).toBe(false);
  });

  it('GET does not call token signup', async () => {
    const app = express();
    app.use('/api/v1', afterCreateRouter);
    const res = await request(app).get('/api/v1/after-create');
    expect(res.status).toBe(200);
    expect(res.body.can_stake).toBe(false);
    expect(res.body.can_verify).toBe(true);
    const route = readFileSync(join(SRC, 'routes', 'after-create.ts'), 'utf8');
    expect(route).not.toContain('token-signup');
    expect(route).not.toContain('tokenSignup');
  });
});
