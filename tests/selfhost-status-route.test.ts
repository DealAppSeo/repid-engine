/**
 * Self-host core HTTP surface boots in LOCAL_MODE and reports the data-locality
 * boundary honestly. Uses supertest against the mounted app (NODE_ENV=test skips
 * .listen()). Offline — no DB, no network.
 */
process.env.LOCAL_MODE = 'true';
// Ensure no hosted Supabase leaks in from the ambient env for this suite.
delete process.env.SUPABASE_URL;

import request from 'supertest';

// Silence the LOCAL_MODE boot warning from config import.
const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { app } = require('../src/selfhost');
warn.mockRestore();

describe('self-host /health', () => {
  test('reports ok + self-host mode without a hosted DB', async () => {
    const res = await request(app).get('/health');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.mode).toBe('self-host');
    expect(res.body.local_mode).toBe(true);
    expect(res.body.hosted_db).toBe(false);
  });
});

describe('self-host /selfhost/status', () => {
  test('honestly separates what BOOTS from what is STILL a stub', async () => {
    const res = await request(app).get('/selfhost/status');
    expect(res.status).toBe(200);
    expect(res.body.local_mode).toBe(true);
    expect(res.body.data_store.hosted).toBe(false);
    expect(res.body.data_store.supabase_url).toBe('http://127.0.0.1:54321');
    // Boot list + stub list are both non-empty — the honesty contract.
    expect(Array.isArray(res.body.boots_today)).toBe(true);
    expect(res.body.boots_today.length).toBeGreaterThan(0);
    expect(Array.isArray(res.body.stub_for_selfhost)).toBe(true);
    expect(res.body.stub_for_selfhost.length).toBeGreaterThan(0);
    // Never leaks a key.
    expect(JSON.stringify(res.body)).not.toMatch(/service_role|secret/i);
  });

  test('with the boundary OFF, cloud prompt egress reports allowed (default hosted behavior)', async () => {
    const res = await request(app).get('/selfhost/status');
    expect(res.body.egress_boundary.only_attestations_leave).toBe(false);
    expect(res.body.egress_boundary.prompt_egress_to_cloud).toBe('allowed');
    expect(res.body.llm.quorum_target).toBe('cloud');
  });
});
