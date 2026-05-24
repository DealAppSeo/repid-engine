import request from 'supertest';
import app from '../src/index';
import { signRepIDAttestation, _testHelpers } from '../src/repid/repid-attestation';
import * as crypto from 'crypto';

describe('Security Fixes — Phase 0.5', () => {
  beforeEach(() => {
    _testHelpers().resetCache();
  });

  describe('Forged Attestation Validation', () => {
    it('POST /api/v1/repid/verify — should reject forged attestation with wrong pubkey', async () => {
      const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
      
      const der = publicKey.export({ format: 'der', type: 'spki' });
      const rawPub = der.subarray(der.length - 32);
      const pubKeyB64 = rawPub.toString('base64');

      const fakePayload = {
        agent_id: 'attacker-controlled-agent',
        repid_score: 999999,
        timestamp_iso: new Date().toISOString(),
        version: 'repid-attestation/1'
      };

      const sorted: any = {};
      for (const k of Object.keys(fakePayload).sort()) {
        sorted[k] = (fakePayload as any)[k];
      }
      const message = Buffer.from(JSON.stringify(sorted), 'utf-8');
      const signature = crypto.sign(null, message, privateKey).toString('base64url');

      const body = {
        payload: fakePayload,
        signing_pubkey: pubKeyB64,
        signature: signature
      };

      const res = await request(app)
        .post('/api/v1/repid/verify')
        .send(body);

      expect(res.status).toBe(400);
      expect(res.body.valid).toBe(false);
      expect(res.body.reason).toContain('signing_pubkey does not match authoritative signing key');
    });

    it('POST /api/v1/repid/verify — should accept valid attestation signed by authoritative key', async () => {
      const att = await signRepIDAttestation({
        agent_id: 'agent-valid-1',
        repid_score: 3500,
        timestamp_iso: new Date().toISOString(),
      });

      const res = await request(app)
        .post('/api/v1/repid/verify')
        .send(att);

      expect(res.status).toBe(200);
      expect(res.body.valid).toBe(true);
      expect(res.body.payload.agent_id).toBe('agent-valid-1');
    });

    it('POST /api/v1/repid/verify — should reject attestation with modified payload', async () => {
      const att = await signRepIDAttestation({
        agent_id: 'agent-valid-2',
        repid_score: 3500,
        timestamp_iso: new Date().toISOString(),
      });

      const tampered = {
        ...att,
        payload: {
          ...att.payload,
          repid_score: 9999
        }
      };

      const res = await request(app)
        .post('/api/v1/repid/verify')
        .send(tampered);

      expect(res.status).toBe(400);
      expect(res.body.valid).toBe(false);
    });
  });

  describe('prove-repid Route Authentication', () => {
    it('POST /api/v1/prove-repid — should reject request without API key', async () => {
      const res = await request(app)
        .post('/api/v1/prove-repid')
        .send({
          agent_id: '32e0e809-c1c4-4405-913f-135c8a2d6626',
          requester_pubkey: 'some-pubkey',
          requested_tier: 'probationary'
        });

      expect(res.status).toBe(401);
    });

    it('POST /api/v1/prove-repid — should accept request with valid API key', async () => {
      // Mock db response for agent check
      // repidPublicRouter uses db.from('repid_agents').select('*').eq('id', agent_id).single()
      // Let's check if the route returns 404/200/etc.
      // If it has valid API key, it passes authMiddleware and rateLimitMiddleware, 
      // then tries to access the DB and might fail with 404 or pass depending on mock.
      // Either way, if it is NOT 401/403, the authentication is working!
      const res = await request(app)
        .post('/api/v1/prove-repid')
        .set('Authorization', 'Bearer test-key-123')
        .send({
          agent_id: '32e0e809-c1c4-4405-913f-135c8a2d6626',
          requester_pubkey: 'some-pubkey',
          requested_tier: 'probationary'
        });

      // The mock db inside tests will return 404 or 500 or success, but it should not be 401/403
      expect(res.status).not.toBe(401);
      expect(res.status).not.toBe(403);
    });
  });
});
