import request from 'supertest';
import app from '../../src/index';
import { repIdAttestationService } from '../../src/services/repid-attestation';
import { bucketStore } from '../../src/middleware/rate-limit';

jest.mock('../../src/services/repid-attestation', () => ({
  repIdAttestationService: {
    verifyAttestation: jest.fn(),
  },
}));

describe('Rate Limiter + Attestation Extractor Integration', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    bucketStore.__reset();
  });

  it('uses default IP rate limit when attestation header is missing', async () => {
    const res = await request(app)
      .get('/api/v1/health');

    expect(res.status).toBeLessThan(500); // 200 health or 404/etc, just not server crash
    expect(res.headers['x-ratelimit-bucket']).toBe('ip');
    expect(res.headers['x-ratelimit-limit']).toBe('60'); // IP_DEFAULT
  });

  it('uses agent-specific rate limit tier when valid attestation header is provided', async () => {
    const rawAttestation = {
      agent_id: 'agent-12345',
      tier: 'ESTABLISHED',
      repid: 6500,
    };
    const headerValue = Buffer.from(JSON.stringify(rawAttestation)).toString('base64');

    (repIdAttestationService.verifyAttestation as jest.Mock).mockResolvedValue({ valid: true });

    const res = await request(app)
      .get('/api/v1/health')
      .set('X-HYPERDAG-REPID-ATTESTATION', headerValue);

    expect(res.status).toBeLessThan(500);
    expect(res.headers['x-ratelimit-bucket']).toBe('agent');
    expect(res.headers['x-ratelimit-limit']).toBe('600'); // ESTABLISHED limit
  });

  it('falls back to IP rate limit if attestation header is invalid/forged', async () => {
    const rawAttestation = {
      agent_id: 'agent-12345',
      tier: 'ESTABLISHED',
      repid: 6500,
    };
    const headerValue = Buffer.from(JSON.stringify(rawAttestation)).toString('base64');

    (repIdAttestationService.verifyAttestation as jest.Mock).mockResolvedValue({
      valid: false,
      reason: 'Signature verification failed',
    });

    const res = await request(app)
      .get('/api/v1/health')
      .set('X-HYPERDAG-REPID-ATTESTATION', headerValue);

    expect(res.status).toBeLessThan(500);
    expect(res.headers['x-ratelimit-bucket']).toBe('ip');
    expect(res.headers['x-ratelimit-limit']).toBe('60'); // fallback to IP_DEFAULT
  });
});
