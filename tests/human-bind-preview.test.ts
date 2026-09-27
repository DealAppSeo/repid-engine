import { readFileSync } from 'node:fs';
import path from 'node:path';
import express from 'express';
import request from 'supertest';
import bindPreviewRouter from '../src/routes/human-bind-preview';
import { previewBind } from '../src/services/bind-preview';

describe('bind preview', () => {
  const saved = process.env.HUMAN_AGENT_BIND_ENABLED;

  afterEach(() => {
    if (saved === undefined) delete process.env.HUMAN_AGENT_BIND_ENABLED;
    else process.env.HUMAN_AGENT_BIND_ENABLED = saved;
  });

  function app() {
    const server = express();
    server.use(express.json());
    server.use('/api/v1', bindPreviewRouter);
    return server;
  }

  it('returns 401 for an empty bind and names wallet plus agent when both are present', async () => {
    process.env.HUMAN_AGENT_BIND_ENABLED = 'true';
    const empty = await request(app()).post('/api/v1/human/bind/preview').send({});
    expect(empty.status).toBe(401);
    expect(empty.body.applied).toBe(false);
    expect(empty.body.persisted).toBe(false);
    expect(empty.body.message).toBeNull();

    const named = await request(app()).post('/api/v1/human/bind/preview').send({
      wallet: '0xABC',
      agent_id: 'agent-1',
      signature: 'present',
    });
    expect(named.status).toBe(200);
    expect(named.body.applied).toBe(false);
    expect(named.body.persisted).toBe(false);
    expect(named.body.message).toContain('wallet: 0xabc');
    expect(named.body.message).toContain('agent:  agent-1');
    expect(previewBind({ wallet: '0xABC', agent_id: 'agent-1' }).status).toBe(401);
  });

  it('is mounted before auth and does not insert', () => {
    const root = path.join(__dirname, '..');
    const indexSrc = readFileSync(path.join(root, 'src', 'index.ts'), 'utf8');
    const routeSrc = readFileSync(path.join(root, 'src', 'routes', 'human-bind-preview.ts'), 'utf8');
    const serviceSrc = readFileSync(path.join(root, 'src', 'services', 'bind-preview.ts'), 'utf8');
    const mountAt = indexSrc.indexOf("app.use('/api/v1', bindPreviewRouter)");
    const authAt = indexSrc.indexOf('app.use(authMiddleware)');
    expect(mountAt).toBeGreaterThan(-1);
    expect(authAt).toBeGreaterThan(mountAt);
    expect(routeSrc).not.toContain('.insert(');
    expect(serviceSrc).not.toContain('.insert(');
    expect(serviceSrc).not.toContain('from(');
    expect(routeSrc).not.toContain('HUMAN_AGENT_BIND_ENABLED');
  });
});
