import request from 'supertest';
import express from 'express';
import v1Router from '../src/routes/v1';
import { db } from '../src/db';
import { computeAuthority } from '../src/services/authority-math';

const app = express();
app.use(express.json());
app.use('/api/v1', v1Router);

describe('Round-Numbers Demo Progression', () => {
  beforeAll(async () => {
    // Seed APM and VERITAS
    await request(app).post('/api/v1/demo/two-builder/bootstrap').send();

    // Ensure APM and VERITAS have a valid builder assigned in the test DB
    // The test DB might not have the seed SQL applied, leaving their builder_id null
    // or pointing to a deleted builder.
    let mId = 'd8e47f71-61b6-45ef-af16-bc5de20b1234';
    const { data: existing } = await db.from('builders').select('id').eq('id', mId).maybeSingle();
    if (!existing) {
      await db.from('builders').insert({
        id: mId,
        address: '0x000000000000000000000000000000000000M01T',
        auth_method: 'wallet',
        current_repid: 5100,
      });
    }
    const { error: e1 } = await db.from('repid_agents').update({ builder_id: mId }).is('builder_id', null);
    if (e1) console.error('Failed to update agents:', e1);
  });

  it('Authority math matches round-numbers progression for demo builders', () => {
    // Fresh builder (RepID 100)
    const r100 = computeAuthority({
      stakeAmount: 100_000_000n,
      agentRepId: 0,
      agentWisdom: 0,
      agentCharacter: 0,
      builderRepId: 100,
      isDemoBuilder: true,
    });
    expect(r100.authority.toString()).toBe('50000000'); // $50

    // Builder growing (RepID 500)
    const r500 = computeAuthority({
      stakeAmount: 100_000_000n,
      agentRepId: 0,
      agentWisdom: 0,
      agentCharacter: 0,
      builderRepId: 500,
      isDemoBuilder: true,
    });
    expect(r500.authority.toString()).toBe('75000000'); // $75

    // Tier 2 unlock (RepID 1000)
    const r1000 = computeAuthority({
      stakeAmount: 100_000_000n,
      agentRepId: 0,
      agentWisdom: 0,
      agentCharacter: 0,
      builderRepId: 1000,
      isDemoBuilder: true,
    });
    expect(r1000.authority.toString()).toBe('106250000'); // ~$106
  });

  it('Fresh token-only builder has current_repid = 100', async () => {
    const res = await request(app).post('/api/v1/builder/token-signup').send();
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    
    // Check DB
    const { data } = await db.from('builders').select('current_repid').eq('id', res.body.builder_id).single();
    expect(data?.current_repid).toBe(100);
  });

  // Since we rely on the live database in this integration test suite, we'll test the actual DB mutations
  // by calling the function
  it('runRoundAnonymous applies +50 or -25 delta', async () => {
    // 1. Create token builder
    const signRes = await request(app).post('/api/v1/builder/token-signup').send();
    const token = signRes.body.token;
    const builderId = signRes.body.builder_id;

    // Verify start at 100
    const { data: b1 } = await db.from('builders').select('current_repid').eq('id', builderId).single();
    expect(b1?.current_repid).toBe(100);

    // 2. Mock fetchAgent to force APM to win
    const { fetchAgent } = require('../src/services/anonymous-round-runner');
    // We cannot easily mock the internal fetchAgent inside the same module without jest.mock on the whole module,
    // but the actual runRoundAnonymous runs a simulated Plonky3 proof which deterministic based on HMAC.
    // If we just run it, it might be +50 or -25. Let's run it 5 times and see it moved.
    
    // Deposit $100
    const depRes = await request(app).post('/api/v1/stake/deposit').send({
      builder_address: signRes.body.builder_address,
      amount: '100000000'
    });
    if (depRes.status !== 200) {
      console.log('Deposit failed:', depRes.body);
    }
    expect(depRes.status).toBe(200);

    // Run round
    const roundRes = await request(app).post('/api/v1/demo/run-round-anonymous').send({
      token,
      wait_ms: 0,
      bet_amount: '25000000'
    });
    
    if (roundRes.status !== 200) {
      throw new Error('roundRes failed with 400: ' + JSON.stringify(roundRes.body));
    }
    expect(roundRes.status).toBe(200);
    
    // Check DB
    const { data: b2 } = await db.from('builders').select('current_repid').eq('id', builderId).single();
    const newRep = b2?.current_repid;
    // Should be either 150 (win) or 75 (loss)
    expect(newRep === 150 || newRep === 75).toBe(true);

    // Bet of $100 deliberate-fail triggers (limit is at most $53.12)
    const failRes = await request(app).post('/api/v1/demo/run-round-anonymous').send({
      token,
      wait_ms: 0,
      bet_amount: '100000000'
    });
    expect(failRes.status).toBe(400);
    expect(failRes.body.error).toBe('BET_EXCEEDS_AUTHORITY');

    // Bet of $25 succeeds (limit is at least $50.00)
    const succRes = await request(app).post('/api/v1/demo/run-round-anonymous').send({
      token,
      wait_ms: 0,
      bet_amount: '25000000'
    });
    expect(succRes.status).toBe(200);
  });
});
