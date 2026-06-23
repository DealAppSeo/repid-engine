import request from 'supertest';
import app from '../src/index';
import { pgQuery } from '../src/db/direct-pg';

jest.mock('../src/db/direct-pg');

describe('ZKP Credentials Router', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('POST /api/v1/credentials/issue', () => {
    it('returns 400 if agent_id or conservator_address is missing', async () => {
      const res = await request(app)
        .post('/api/v1/credentials/issue')
        .send({ agent_id: 'mock-agent' });
      expect(res.status).toBe(400);
      expect(res.body.error).toContain('required');
    });

    it('returns 404 if agent does not exist', async () => {
      (pgQuery as jest.Mock).mockResolvedValue([]);

      const res = await request(app)
        .post('/api/v1/credentials/issue')
        .send({ agent_id: 'non-existent', conservator_address: '0xdf6b8215D193b11B4903d223729c3CF7A6de271d' });
      expect(res.status).toBe(404);
      expect(res.body.error).toBe('Agent not found');
    });

    it('creates new credentials successfully when none exist', async () => {
      (pgQuery as jest.Mock).mockImplementation((query: string, params?: any[]) => {
        if (query.includes('repid_agents')) {
          return Promise.resolve([{
            id: 'trinity-mel',
            agent_name: 'trinity-mel',
            current_repid: 85.5,
            domain_accuracy: { medical: { pct: 90.0, count: 5 } },
            canonical_agent_id: '624'
          }]);
        }
        if (query.includes('repid_zkp_proofs')) {
          return Promise.resolve([{
            id: 'proof-123',
            zk_commitment: '0xzkcommit',
            proof_bytes: '0xproofbytes'
          }]);
        }
        if (query.includes('identity_binding_ledger')) {
          return Promise.resolve([]); // No existing binding
        }
        if (query.includes('sandbox_repid_credentials')) {
          // Mock retrieve after insert
          return Promise.resolve([{
            id: 'new-cred-uuid',
            holder_did: 'did:ethr:0xdf6b8215d193b11b4903d223729c3cf7a6de271d',
            credential_type: 'self_sovereign_repid',
            zkp_proof: JSON.stringify({ repid_score: 85.5 }),
            verified: false
          }]);
        }
        return Promise.resolve([]);
      });

      const res = await request(app)
        .post('/api/v1/credentials/issue')
        .send({ agent_id: 'trinity-mel', conservator_address: '0xdf6b8215D193b11B4903d223729c3CF7A6de271d' });

      expect(res.status).toBe(201);
      expect(res.body.success).toBe(true);
      expect(res.body.holder_did).toBe('did:ethr:0xdf6b8215d193b11b4903d223729c3cf7a6de271d');
      expect(res.body.nullifier).toBeDefined();
      expect(res.body.binding_hash).toBeDefined();
      expect(res.body.credential).toBeDefined();
    });

    it('returns existing credential if binding already exists (idempotency)', async () => {
      (pgQuery as jest.Mock).mockImplementation((query: string, params?: any[]) => {
        if (query.includes('repid_agents')) {
          return Promise.resolve([{
            id: 'trinity-mel',
            agent_name: 'trinity-mel',
            current_repid: 85.5,
            domain_accuracy: { medical: { pct: 90.0, count: 5 } },
            canonical_agent_id: '624'
          }]);
        }
        if (query.includes('repid_zkp_proofs')) {
          return Promise.resolve([]);
        }
        if (query.includes('identity_binding_ledger')) {
          return Promise.resolve([{ id: 'binding-1', data_ref: 'existing-cred-uuid' }]);
        }
        if (query.includes('sandbox_repid_credentials')) {
          return Promise.resolve([{
            id: 'existing-cred-uuid',
            holder_did: 'did:ethr:0xdf6b8215d193b11b4903d223729c3cf7a6de271d',
            credential_type: 'self_sovereign_repid',
            zkp_proof: JSON.stringify({ repid_score: 85.5 }),
            verified: false
          }]);
        }
        return Promise.resolve([]);
      });

      const res = await request(app)
        .post('/api/v1/credentials/issue')
        .send({ agent_id: 'trinity-mel', conservator_address: '0xdf6b8215D193b11B4903d223729c3CF7A6de271d' });

      expect(res.status).toBe(201);
      expect(res.body.success).toBe(true);
      expect(res.body.credential_id).toBe('existing-cred-uuid');
    });
  });

  describe('POST /api/v1/credentials/verify', () => {
    it('returns 400 if credential_id is missing', async () => {
      const res = await request(app)
        .post('/api/v1/credentials/verify')
        .send({});
      expect(res.status).toBe(400);
      expect(res.body.error).toContain('required');
    });

    it('returns 404 if credential does not exist', async () => {
      (pgQuery as jest.Mock).mockResolvedValue([]);

      const res = await request(app)
        .post('/api/v1/credentials/verify')
        .send({ credential_id: 'non-existent-id' });
      expect(res.status).toBe(404);
      expect(res.body.error).toBe('Credential not found');
    });

    it('verifies credential successfully', async () => {
      (pgQuery as jest.Mock).mockImplementation((query: string, params?: any[]) => {
        if (query.includes('SELECT * FROM sandbox_repid_credentials')) {
          return Promise.resolve([{
            id: 'cred-123',
            holder_did: 'did:ethr:0xdf6b8215d193b11b4903d223729c3cf7a6de271d',
            credential_type: 'self_sovereign_repid',
            zkp_proof: JSON.stringify({ repid_score: 85.5, domain_accuracy: { medical: { pct: 90.0, count: 5 } } }),
            verified: false
          }]);
        }
        if (query.includes('UPDATE sandbox_repid_credentials')) {
          return Promise.resolve([]);
        }
        if (query.includes('identity_binding_ledger')) {
          return Promise.resolve([{ nullifier: 'mock-nullifier' }]);
        }
        return Promise.resolve([]);
      });

      const res = await request(app)
        .post('/api/v1/credentials/verify')
        .send({ credential_id: 'cred-123' });

      expect(res.status).toBe(200);
      expect(res.body.verified).toBe(true);
      expect(res.body.holder_did).toBe('did:ethr:0xdf6b8215d193b11b4903d223729c3cf7a6de271d');
      expect(res.body.nullifier).toBe('mock-nullifier');
      expect(res.body.zkp_payload.repid_score).toBe(85.5);
    });
  });
});
