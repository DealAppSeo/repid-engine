import { readFileSync } from 'node:fs';
import path from 'node:path';
import express from 'express';
import request from 'supertest';
import spendPreviewRouter from '../src/routes/human-spend-preview';
import { previewSpendFixture } from '../src/services/spend-preview';

describe('spend preview names the wallet and the agent', () => {
  function server() {
    const app = express();
    app.use('/api/v1', spendPreviewRouter);
    return app;
  }

  it('denies an unbound agent and still names both parties', async () => {
    const body = previewSpendFixture([], {
      wallet: '0xabc',
      agent: 'trinity-sophia',
      bound: false,
    });
    expect(body.wallet).toBe('0xabc');
    expect(body.agent).toBe('trinity-sophia');
    expect(body.spend).toBe('deny');
    expect(body.reason).toBe('unbound_agent');
    expect(body.applied).toBe(false);
    expect(body.sends_eth).toBe(false);
    expect(body.cap).toBe(100);

    const folded = previewSpendFixture([], {
      wallet: '0xabc',
      agent: 'trinity-sophia',
      bound: 'TRUE',
    });
    expect(folded.reason).toBe('unbound_agent');
    expect(folded.sends_eth).toBe(false);

    const missing = previewSpendFixture([], { wallet: '0xabc' });
    expect(missing.agent).toBe('NOT_CHECKED');
    expect(missing.reason).toBe('unbound_agent');
    expect(missing.agent).not.toBe(0);

    const res = await request(server()).get('/api/v1/human/spend/preview?wallet=0xabc&agent=trinity-sophia');
    expect(res.status).toBe(200);
    expect(res.body.wallet).toBe('0xabc');
    expect(res.body.agent).toBe('trinity-sophia');
    expect(res.body.spend).toBe('deny');
    expect(res.body.reason).toBe('unbound_agent');
    expect(res.body.applied).toBe(false);
    expect(res.body.sends_eth).toBe(false);
  });

  it('a visible cap is not a transfer', async () => {
    const body = previewSpendFixture([{ id: 'stake-row' }], {
      wallet: '0xabc',
      agent: 'trinity-sophia',
      bound: 'true',
    });
    expect(body.wallet).toBe('0xabc');
    expect(body.agent).toBe('trinity-sophia');
    expect(body.cap).toBe(100);
    expect(body.rates).toEqual([50, 100]);
    expect(body.spend).toBe('preview');
    expect(body.reason).toBe('cap_visible');
    expect(body.applied).toBe(false);
    expect(body.persisted).toBe(false);
    expect(body.sends_eth).toBe(false);

    const res = await request(server()).get(
      '/api/v1/human/spend/preview?wallet=0xabc&agent=trinity-sophia&bound=true',
    );
    expect(res.status).toBe(200);
    expect(res.body.cap).toBe(100);
    expect(res.body.applied).toBe(false);
    expect(res.body.sends_eth).toBe(false);
    expect(res.body.spend).toBe('preview');

    const root = path.join(__dirname, '..');
    const routeSrc = readFileSync(path.join(root, 'src', 'routes', 'human-spend-preview.ts'), 'utf8');
    const serviceSrc = readFileSync(path.join(root, 'src', 'services', 'spend-preview.ts'), 'utf8');
    for (const src of [routeSrc, serviceSrc]) {
      expect(src).not.toContain('fetch(');
      expect(src).not.toContain('sendTransaction');
      expect(src).not.toContain('ethers');
      expect(src).not.toContain('.insert(');
      expect(src).not.toContain('REAL_STAKING');
      expect(src).not.toContain('stake_deposits');
    }
  });
});
