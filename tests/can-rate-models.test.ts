/**
 * can_rate_models follows the last Honesty A route call.
 * A counted fixture that never went through the route does not count.
 */

process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://localhost:54321';
process.env.SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || 'dummy';

jest.mock('../src/db', () => {
  let mode: 'error' | 'rows' = 'error';
  const chain = {
    select: () => chain,
    gte: () => chain,
    limit: async () =>
      mode === 'rows'
        ? { data: [{ family: 'llama', provider: 'groq', verdict: 'TRUE' }], error: null }
        : { data: null, error: { message: 'vote table unavailable' } },
  };
  return {
    db: { from: () => chain },
    __setHonestyMode: (next: 'error' | 'rows') => {
      mode = next;
    },
  };
});

import express from 'express';
import request from 'supertest';
import { aggregateHonestyA } from '../src/services/honesty-a';
import { resetHonestyACall } from '../src/services/honesty-a-last';
import { afterCreateCard } from '../src/services/after-create';
import honestyARouter from '../src/routes/honesty-a';

function app() {
  const server = express();
  server.use('/api/v1/hal', honestyARouter);
  return server;
}

describe('can_rate_models', () => {
  beforeEach(() => {
    resetHonestyACall();
    (require('../src/db') as { __setHonestyMode: (m: 'error' | 'rows') => void }).__setHonestyMode('error');
  });

  it('a counted fixture that was not the route stays false, and can_stake stays false', () => {
    aggregateHonestyA([{ family: 'llama', provider: 'groq', verdict: 'TRUE' }]);
    const card = afterCreateCard({});
    expect(card.can_rate_models).toBe(false);
    expect(card.can_stake).toBe(false);
  });

  it('NOT_CHECKED from the route stays false', async () => {
    const res = await request(app()).get('/api/v1/hal/honesty-a');
    expect(res.body.status).toBe('NOT_CHECKED');
    const card = afterCreateCard({});
    expect(card.can_rate_models).toBe(false);
    expect(card.can_stake).toBe(false);
  });

  it('counted from the route is true', async () => {
    (require('../src/db') as { __setHonestyMode: (m: 'error' | 'rows') => void }).__setHonestyMode('rows');
    const res = await request(app()).get('/api/v1/hal/honesty-a');
    expect(res.body.status).toBe('counted');
    const card = afterCreateCard({ REAL_STAKING_ENABLED: 'true' });
    expect(card.can_rate_models).toBe(true);
    expect(card.can_stake).toBe(false);
  });
});
