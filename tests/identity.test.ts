import request from 'supertest';
import app from '../src/index';
import { pgQuery } from '../src/db/direct-pg';
import crypto from 'crypto';

jest.mock('../src/db/direct-pg');

describe('Identity Claims Router', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('POST /api/v1/identity/claim', () => {
    it('returns 400 if holder_did, handle_type, or handle is missing', async () => {
      const res = await request(app)
        .post('/api/v1/identity/claim')
        .send({ holder_did: 'did:ethr:0x123', handle_type: 'email' });
      expect(res.status).toBe(400);
      expect(res.body.error).toContain('required');
    });

    it('claims identity successfully, hashes the handle, and returns 200 (idempotent)', async () => {
      const mockClaim = {
        id: 'claim-uuid-123',
        holder_did: 'did:ethr:0xdf6b8215D193b11B4903d223729c3CF7A6de271d',
        handle_type: 'email',
        handle_hash: crypto.createHash('sha256').update('test@gmail.com').digest('hex'),
        status: 'claimable',
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
      };

      (pgQuery as jest.Mock).mockResolvedValue([mockClaim]);

      const res = await request(app)
        .post('/api/v1/identity/claim')
        .send({
          holder_did: 'did:ethr:0xdf6b8215D193b11B4903d223729c3CF7A6de271d',
          handle_type: 'email',
          handle: 'test@gmail.com'
        });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.claim_id).toBe('claim-uuid-123');
      expect(res.body.holder_did).toBe('did:ethr:0xdf6b8215D193b11B4903d223729c3CF7A6de271d');
      expect(res.body.handle_type).toBe('email');
      expect(res.body.handle_hash).toBe(mockClaim.handle_hash);
      expect(res.body.status).toBe('claimable');
      expect(res.body.handle).toBeUndefined(); // Verify raw handle is NOT returned
    });
  });
});
