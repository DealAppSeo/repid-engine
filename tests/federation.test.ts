/**
 * Federated developer-node onboarding — unit tests (PR-3, V2 substrate).
 * - validateFederationRegister: pure, no IO (happy/sad paths).
 * - POST /event-stream: rejects (403) when the node is not opted-in OR not verified; accepts
 *   only when federated_optin=true AND status='verified'. db is mocked via a call-time global
 *   handle to avoid jest hoist/TDZ issues.
 *
 * The live register/heartbeat write paths need the developer_nodes / federation_events tables
 * (migration 20260526120000) and are exercised end-to-end after the orchestrator applies it.
 */

// Call-time global mock: the factory reads (global as any).__fedDb at invocation, so each test
// can swap the db behavior without re-importing (avoids TDZ on module-scope consts in the factory).
jest.mock('../src/db', () => ({
  get db() {
    return (global as any).__fedDb;
  },
}));

import request from 'supertest';
import express from 'express';
import federationRouter, { validateFederationRegister } from '../src/routes/v1/federation';

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/v1/federation', federationRouter);
  return app;
}

describe('validateFederationRegister', () => {
  test('accepts a valid request + normalizes email, defaults tier/optin', () => {
    const r = validateFederationRegister({ owner_email: '  Dev@Example.COM ', node_url: 'https://node.example.com' });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.owner_email).toBe('dev@example.com');
      expect(r.node_url).toBe('https://node.example.com');
      expect(r.license_tier).toBe('free_federated');
      expect(r.federated_optin).toBe(false);
    }
  });

  test('accepts explicit licensed_silo + opt-in', () => {
    const r = validateFederationRegister({
      owner_email: 'a@b.co',
      node_url: 'http://localhost:8080',
      license_tier: 'licensed_silo',
      federated_optin: true,
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.license_tier).toBe('licensed_silo');
      expect(r.federated_optin).toBe(true);
    }
  });

  test('rejects bad email', () => {
    expect(validateFederationRegister({ owner_email: 'nope', node_url: 'https://n.io' }).ok).toBe(false);
  });

  test('rejects bad node_url', () => {
    expect(validateFederationRegister({ owner_email: 'a@b.co', node_url: 'ftp://nope' }).ok).toBe(false);
  });

  test('rejects unknown license_tier', () => {
    const r = validateFederationRegister({ owner_email: 'a@b.co', node_url: 'https://n.io', license_tier: 'enterprise' });
    expect(r.ok).toBe(false);
  });
});

describe('POST /event-stream — gating', () => {
  const makeFromForNode = (node: any) => ({
    from: (table: string) => {
      if (table === 'developer_nodes') {
        return {
          select: () => ({
            eq: () => ({
              maybeSingle: async () => ({ data: node, error: null }),
            }),
          }),
        };
      }
      if (table === 'federation_events') {
        return {
          insert: () => ({
            select: () => ({
              single: async () => ({ data: { id: 42 }, error: null }),
            }),
          }),
        };
      }
      return {} as any;
    },
  });

  afterEach(() => {
    delete (global as any).__fedDb;
  });

  test('403 when node not opted-in', async () => {
    (global as any).__fedDb = makeFromForNode({ id: 1, federated_optin: false, status: 'verified' });
    const res = await request(makeApp())
      .post('/api/v1/federation/event-stream')
      .send({ node_id: 1, event_type: 'gradient_update', payload: { layer: 1 } });
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('federation opt-in + verification required');
  });

  test('403 when node opted-in but not verified', async () => {
    (global as any).__fedDb = makeFromForNode({ id: 1, federated_optin: true, status: 'pending' });
    const res = await request(makeApp())
      .post('/api/v1/federation/event-stream')
      .send({ node_id: 1, event_type: 'gradient_update', payload: {} });
    expect(res.status).toBe(403);
  });

  test('404 when node missing', async () => {
    (global as any).__fedDb = makeFromForNode(null);
    const res = await request(makeApp())
      .post('/api/v1/federation/event-stream')
      .send({ node_id: 999, event_type: 'gradient_update', payload: {} });
    expect(res.status).toBe(404);
  });

  test('201 when opted-in AND verified', async () => {
    (global as any).__fedDb = makeFromForNode({ id: 1, federated_optin: true, status: 'verified' });
    const res = await request(makeApp())
      .post('/api/v1/federation/event-stream')
      .send({ node_id: 1, event_type: 'gradient_update', payload: { layer: 1 } });
    expect(res.status).toBe(201);
    expect(res.body.ok).toBe(true);
    expect(res.body.event_id).toBe(42);
  });

  test('400 when event_type missing', async () => {
    (global as any).__fedDb = makeFromForNode({ id: 1, federated_optin: true, status: 'verified' });
    const res = await request(makeApp())
      .post('/api/v1/federation/event-stream')
      .send({ node_id: 1 });
    expect(res.status).toBe(400);
  });
});

describe('POST /register', () => {
  afterEach(() => {
    delete (global as any).__fedDb;
  });

  test('201 returns node_id + challenge_nonce', async () => {
    (global as any).__fedDb = {
      from: () => ({
        insert: () => ({
          select: () => ({
            single: async () => ({ data: { id: 7 }, error: null }),
          }),
        }),
      }),
    };
    const res = await request(makeApp())
      .post('/api/v1/federation/register')
      .send({ owner_email: 'dev@example.com', node_url: 'https://node.example.com' });
    expect(res.status).toBe(201);
    expect(res.body.node_id).toBe(7);
    expect(typeof res.body.challenge_nonce).toBe('string');
    expect(res.body.challenge_nonce.length).toBeGreaterThan(0);
  });

  test('400 on invalid body', async () => {
    const res = await request(makeApp())
      .post('/api/v1/federation/register')
      .send({ owner_email: 'bad', node_url: 'nope' });
    expect(res.status).toBe(400);
  });
});
