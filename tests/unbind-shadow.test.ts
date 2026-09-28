import { readFileSync } from 'node:fs';
import path from 'node:path';
import express from 'express';
import request from 'supertest';
import unbindPreviewRouter from '../src/routes/human-unbind-preview';

describe('unbind shadow', () => {
  function app() {
    const server = express();
    server.use(express.json());
    server.use('/api/v1', unbindPreviewRouter);
    return server;
  }

  it('returns 401 for an empty unbind and names wallet plus agent without applying', async () => {
    const empty = await request(app()).post('/api/v1/human/unbind/preview').send({});
    expect(empty.status).toBe(401);
    expect(empty.body.applied).toBe(false);
    expect(empty.body.persisted).toBe(false);
    expect(empty.body.message).toBeNull();

    const named = await request(app()).post('/api/v1/human/unbind/preview').send({
      wallet: '0xABC',
      agent_id: 'agent-1',
      signature: 'present',
    });
    expect(named.status).toBe(200);
    expect(named.body.applied).toBe(false);
    expect(named.body.persisted).toBe(false);
    expect(named.body.wallet).toBe('0xabc');
    expect(named.body.agent).toBe('agent-1');
    expect(named.body.message).toContain('wallet: 0xabc');
    expect(named.body.message).toContain('agent:  agent-1');
    expect(named.body.message).toContain('does not remove a row');
  });

  it('is mounted before auth and does not insert', () => {
    const root = path.join(__dirname, '..');
    const indexSrc = readFileSync(path.join(root, 'src', 'index.ts'), 'utf8');
    const routeSrc = readFileSync(path.join(root, 'src', 'routes', 'human-unbind-preview.ts'), 'utf8');
    const serviceSrc = readFileSync(path.join(root, 'src', 'services', 'unbind-shadow.ts'), 'utf8');
    const mountAt = indexSrc.indexOf("app.use('/api/v1', unbindPreviewRouter)");
    const authAt = indexSrc.indexOf('app.use(authMiddleware)');
    expect(mountAt).toBeGreaterThan(-1);
    expect(authAt).toBeGreaterThan(mountAt);
    expect(routeSrc).not.toContain('.insert(');
    expect(serviceSrc).not.toContain('.insert(');
    expect(serviceSrc).not.toContain('supabase');
    expect(serviceSrc).not.toContain('from(');
    expect(routeSrc).not.toContain('supabase');
    expect(routeSrc).not.toContain('from(');
  });
});
