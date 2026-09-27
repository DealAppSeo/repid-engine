/**
 * POST /api/v1/human/bind/preview. Empty is 401. A named wallet and agent
 * return 200 with applied false. The route inserts nothing.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import express from 'express';
import request from 'supertest';
import bindPreviewRouter from '../src/routes/human-bind-preview';
import { previewBind } from '../src/services/bind-preview';

describe('e2e human bind', () => {
  function app() {
    const server = express();
    server.use(express.json());
    server.use('/api/v1', bindPreviewRouter);
    return server;
  }

  it('returns 401 for an empty bind and 200 applied false when wallet and agent are named', async () => {
    const empty = await request(app()).post('/api/v1/human/bind/preview').send({});
    expect(empty.status).toBe(401);
    expect(empty.body.applied).toBe(false);
    expect(empty.body.persisted).toBe(false);
    expect(empty.body.message).toBeNull();

    const payload = { wallet: '0xABC', agent_id: 'agent-1', signature: 'present' };
    const named = await request(app()).post('/api/v1/human/bind/preview').send(payload);
    expect(named.status).toBe(200);
    expect(named.body).toEqual(previewBind(payload));
    expect(named.body.applied).toBe(false);
    expect(named.body.persisted).toBe(false);
    expect(named.body.wallet).toBe('0xabc');
    expect(named.body.agent).toBe('agent-1');
    expect(named.body.message).toContain('wallet: 0xabc');
    expect(named.body.message).toContain('agent:  agent-1');
  });

  it('does not insert', () => {
    const root = path.join(__dirname, '..');
    const routeSrc = readFileSync(path.join(root, 'src', 'routes', 'human-bind-preview.ts'), 'utf8');
    const serviceSrc = readFileSync(path.join(root, 'src', 'services', 'bind-preview.ts'), 'utf8');
    expect(routeSrc).toContain("router.post('/human/bind/preview'");
    expect(routeSrc).not.toContain('.insert(');
    expect(serviceSrc).not.toContain('.insert(');
    expect(serviceSrc).not.toContain('from(');
  });
});
