/**
 * Claim honesty, second sweep (gap matrix 2026-10-31, "still open" items):
 *   · POST /api/v1/dag/verify-node answered valid:true and fired dag.node_verified without comparing
 *     anything. It now says NOT_CHECKED and fires no "verified" event.
 *   · /verify-proof fired proof.verified for every outcome. Only a verifier that ran and accepted is.
 *   · The badge rendered an unreadable track record as "no jobs yet".
 */
import request from 'supertest';
import express from 'express';

const mockInsert = jest.fn(async (_row: unknown) => ({ error: null }));
const mockFire = jest.fn();
jest.mock('../src/db', () => ({ db: { from: jest.fn(() => ({ insert: mockInsert })) } }));
jest.mock('../src/services/webhook', () => ({ fireWebhook: (...a: unknown[]) => mockFire(...a) }));

import v1Router, { proofWebhookEvent } from '../src/routes/v1';
import { renderBadgeSvg, type BadgeData } from '../src/services/trust-badge';

const app = express();
app.use(express.json());
app.use('/api/v1', v1Router);

afterEach(() => jest.clearAllMocks());

describe('POST /dag/verify-node does not claim a verification it never ran', () => {
  const body = { node_id: 'n1', parent_hash: 'p0', agent_id: 'a1', payload: { x: 1 } };

  it('returns the hash with verdict NOT_CHECKED, valid null and no depth', async () => {
    const res = await request(app).post('/api/v1/dag/verify-node').send(body);
    expect(res.status).toBe(200);
    expect(res.body.node_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(res.body.valid).not.toBe(true);
    expect(res.body.valid).toBeNull();
    expect(res.body.verdict).toBe('NOT_CHECKED');
    expect(res.body.dag_depth).toBeNull();
    expect(res.body).not.toHaveProperty('verified_at');
  });

  it('fires no "verified" webhook and logs the call as hashed, not verified', async () => {
    await request(app).post('/api/v1/dag/verify-node').send(body);
    expect(mockFire.mock.calls.map((c) => c[0])).not.toContain('dag.node_verified');
    const row = mockInsert.mock.calls[0]![0] as { action: string };
    expect(row.action).toBe('dag_node_hashed');
  });
});

describe('proof webhook event names the real outcome', () => {
  it('verified only when a verifier ran and accepted', () => {
    expect(proofWebhookEvent({ valid: true, cryptographically_verified: true })).toBe('proof.verified');
  });
  it('a verifier that ran and rejected is failed', () => {
    expect(proofWebhookEvent({ valid: false, cryptographically_verified: true })).toBe('proof.failed');
  });
  it('no verifier result is not_checked, including the attested stub that says valid:true', () => {
    expect(proofWebhookEvent({ valid: false, cryptographically_verified: false })).toBe('proof.not_checked');
    expect(proofWebhookEvent({ valid: true, cryptographically_verified: false })).toBe('proof.not_checked');
    expect(proofWebhookEvent({})).toBe('proof.not_checked');
  });
});

describe('the badge never turns an unreadable record into "no jobs"', () => {
  const base: BadgeData = {
    agent_id: 'a1', agent_name: 'agent', tier: null, repid: null,
    track_record: 'Track record NOT_CHECKED: it could not be read. This is not the same as no jobs.',
    settled_jobs: null, disputed_jobs: null, verified_rate: null, sample_size_warning: false,
    stake_at_risk_usdc: 5, stake_label: '$5.00 at risk', verify_url: 'https://x', receipt_url: null, caveats: [],
  };

  it('compact badge says "record not checked", amber, never "null jobs" or "no jobs yet"', () => {
    const svg = renderBadgeSvg(base, 'compact');
    expect(svg).toContain('record not checked');
    expect(svg).not.toContain('null jobs');
    expect(svg).not.toContain('no jobs yet');
    expect(svg).toContain('#d97706');
  });
});
