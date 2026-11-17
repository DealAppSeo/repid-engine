/**
 * GET /agents/:id/zkp/:proofType is public (auth bypass), and its ENVELOPE tier used to serve
 *   merkleRoot: '[ZKP commitment — verify on-chain via ERC-8004 ValidationRegistry]'
 * No ERC-8004 Validation Registry is deployed or written to, so that string told a stranger to go
 * verify something against a contract that does not exist. It is now `null` plus a note.
 *
 * Two things are pinned here:
 *  1. No tier of that route says a Validation Registry exists, and ENVELOPE keeps its `merkleRoot`
 *     KEY (trustrepid's lib/engine.ts declares it on its ZKPDisclosure type), with an honest value.
 *  2. The scan can find a presence (LESSONS 5). A "no match" is only evidence if the same scan
 *     matches the old value and a real response that carries the words, so the control runs the
 *     scan over the actual HTTP body, not just over a string literal.
 */

const AGENT_ID = '11111111-2222-4333-8444-555555555555';

(global as any)._api_key_versions_table_checked = true;
(global as any).__zkpTestAgentRow = null;

jest.mock('../src/db', () => {
  return {
    db: {
      from: (tableName: string) => {
        if (tableName === 'repid_score_events') {
          // ENVELOPE runs three head-only count queries; zero decisions is enough for the shape.
          const chain: any = {
            select: () => chain,
            eq: () => chain,
            then: (resolve: any) => resolve({ count: 0, data: null, error: null }),
          };
          return chain;
        }
        const chain: any = {
          select: () => chain,
          eq: () => chain,
          single: async () => {
            const row = (global as any).__zkpTestAgentRow ?? null;
            return { data: row, error: row ? null : { message: 'not found' } };
          },
          insert: () => ({ then: (resolve: any) => resolve({ data: null, error: null }) }),
          upsert: () => ({ then: (resolve: any) => resolve({ data: null, error: null }) }),
        };
        return chain;
      },
      rpc: async () => ({ data: null, error: null }),
    },
  };
});

import request from 'supertest';
import app from '../src/index';

/** Any spelling of the registry's name: ValidationRegistry, Validation Registry, validation_registry. */
const REGISTRY_CLAIM = /validation[\s_-]*registry/i;
const claimsRegistry = (body: unknown): boolean => REGISTRY_CLAIM.test(JSON.stringify(body));

function agentRow(overrides: Record<string, unknown> = {}) {
  return {
    id: AGENT_ID,
    agent_name: 'ZkpTestAgent',
    tier: 'ESTABLISHED',
    erc8004_address: '0x0000000000000000000000000000000000000001',
    constitution: { version: '1' },
    ...overrides,
  };
}

beforeEach(() => {
  (global as any).__zkpTestAgentRow = agentRow();
});

describe('GET /agents/:id/zkp/:proofType makes no Validation Registry claim', () => {
  it.each(['POSTCARD', 'ENVELOPE', 'PACKAGE'])('%s: the response names no registry', async (tier) => {
    const res = await request(app).get(`/agents/${AGENT_ID}/zkp/${tier}`);
    expect([200, 403]).toContain(res.status); // PACKAGE is a 403 by design
    expect(res.body.proofType).toBe(tier);
    expect(claimsRegistry(res.body)).toBe(false);
  });

  it('ENVELOPE keeps its merkleRoot key, with null and a note instead of a registry pointer', async () => {
    const res = await request(app).get(`/agents/${AGENT_ID}/zkp/ENVELOPE`);
    expect(res.status).toBe(200);
    expect(Object.keys(res.body)).toContain('merkleRoot');
    expect(res.body.merkleRoot).toBeNull();
    expect(typeof res.body.merkleRootNote).toBe('string');
    expect(res.body.merkleRootNote).toMatch(/not served/i);
  });
});

describe('the scan can find a presence (so the absence above means something)', () => {
  it('matches the value this route used to serve, and each spelling of the name', () => {
    expect(claimsRegistry({ merkleRoot: '[ZKP commitment — verify on-chain via ERC-8004 ValidationRegistry]' })).toBe(true);
    expect(claimsRegistry('ERC-8004 Validation Registry')).toBe(true);
    expect(claimsRegistry('validation_registry')).toBe(true);
    expect(claimsRegistry({ merkleRoot: null, merkleRootNote: 'Not served.' })).toBe(false);
  });

  it('finds the words in a real HTTP body: the same scan, run over a response that carries them', async () => {
    // agentName is echoed by the ENVELOPE tier, so a row named for the registry must trip the scan.
    (global as any).__zkpTestAgentRow = agentRow({ agent_name: 'ValidationRegistry-probe' });
    const res = await request(app).get(`/agents/${AGENT_ID}/zkp/ENVELOPE`);
    expect(res.status).toBe(200);
    expect(res.body.agentName).toBe('ValidationRegistry-probe');
    expect(claimsRegistry(res.body)).toBe(true);
  });
});
