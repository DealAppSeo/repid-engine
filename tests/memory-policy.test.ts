import { readFileSync } from 'node:fs';
import path from 'node:path';
import express from 'express';
import request from 'supertest';
import memoryPolicyRouter from '../src/routes/memory-policy';
import { memoryPolicy } from '../src/services/memory-policy';

describe('GET /api/v1/memory/policy', () => {
  const app = express();
  app.use('/api/v1', memoryPolicyRouter);

  it('returns the policy body and does not write', async () => {
    const res = await request(app).get('/api/v1/memory/policy');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      stores_prompts: false,
      vendors_see: 'redacted_only',
      local_canonical: true,
    });
    expect(memoryPolicy()).toEqual(res.body);

    const route = readFileSync(path.join(__dirname, '..', 'src', 'routes', 'memory-policy.ts'), 'utf8');
    const service = readFileSync(path.join(__dirname, '..', 'src', 'services', 'memory-policy.ts'), 'utf8');
    expect(route).not.toContain('.insert(');
    expect(route).not.toContain('supabase');
    expect(route).not.toContain("from('");
    expect(service).not.toContain('.insert(');
    expect(service).not.toContain('supabase');
    expect(service).not.toContain("from('");
  });
});
