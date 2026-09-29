/**
 * TrustShell shadow routes against a mock database.
 * The script exits 0 only when the GET contracts hold, and 2 when the base URL is missing.
 */
process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://localhost:54321';
process.env.SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || 'dummy';

let honestyCalls = 0;
let inserts = 0;

jest.mock('../src/db', () => {
  const chain: Record<string, unknown> = {};
  const self = () => chain;
  for (const name of ['select', 'eq', 'ilike', 'neq', 'in', 'gte', 'order', 'insert', 'upsert']) {
    chain[name] = self;
  }
  chain.limit = async () => {
    honestyCalls += 1;
    if (honestyCalls === 1) {
      return {
        data: [
          {
            family: 'llama',
            provider: 'groq',
            host: 'groq',
            verdict: 'TRUE',
            first_pass_verdict: 'TRUE',
            post_hal_verdict: 'FALSE',
          },
        ],
        error: null,
      };
    }
    if (honestyCalls === 2) return { data: [], error: null };
    return { data: null, error: { message: 'relation does not exist' } };
  };
  chain.maybeSingle = async () => ({ data: null, error: null });
  chain.single = async () => ({ data: null, error: null });
  chain.insert = () => {
    inserts += 1;
    return chain;
  };
  return { db: { from: () => chain, rpc: async () => ({ data: null, error: null }) } };
});

import { spawn } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import express from 'express';
import honestyARouter from '../src/routes/honesty-a';
import afterCreateRouter from '../src/routes/after-create';
import humanPathRouter from '../src/routes/human-path';
import spendPreviewRouter from '../src/routes/human-spend-preview';

function runScript(env: NodeJS.ProcessEnv): Promise<{ code: number | null; stderr: string; stdout: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['scripts/e2e-trustshell-shadow.mjs'], {
      cwd: path.join(__dirname, '..'),
      env,
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (buf) => {
      stdout += String(buf);
    });
    child.stderr.on('data', (buf) => {
      stderr += String(buf);
    });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stderr, stdout }));
  });
}

describe('trustshell shadow e2e', () => {
  let server: Server;
  let base = '';

  beforeAll((done) => {
    honestyCalls = 0;
    inserts = 0;
    const app = express();
    app.use(express.json());
    app.use('/api/v1/hal', honestyARouter);
    app.use('/api/v1', afterCreateRouter);
    app.use('/api/v1', humanPathRouter);
    app.use('/api/v1', spendPreviewRouter);
    server = createServer(app);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        done(new Error('no port'));
        return;
      }
      base = `http://127.0.0.1:${address.port}`;
      done();
    });
  });

  afterAll((done) => {
    server.close(() => done());
  });

  it('exits 2 when the base URL is missing', async () => {
    const env = { ...process.env };
    delete env.STAGING_BASE_URL;
    delete env.E2E_HONESTY_SEQUENCE;
    const result = await runScript(env);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain('NOT_CHECKED');
  });

  it('exits 0 when the GET routes hold, and inserts nothing', async () => {
    const env = { ...process.env };
    const previousBind = process.env.HUMAN_AGENT_BIND_ENABLED;
    delete process.env.HUMAN_AGENT_BIND_ENABLED;
    delete env.HUMAN_AGENT_BIND_ENABLED;
    env.STAGING_BASE_URL = base;
    env.E2E_HONESTY_SEQUENCE = '1';
    const before = inserts;
    try {
      const result = await runScript(env);
      expect(result.stdout).toContain('ok');
      if (result.code !== 0) {
        throw new Error(result.stderr || result.stdout);
      }
      expect(result.code).toBe(0);
      expect(inserts).toBe(before);
    } finally {
      if (previousBind === undefined) delete process.env.HUMAN_AGENT_BIND_ENABLED;
      else process.env.HUMAN_AGENT_BIND_ENABLED = previousBind;
    }
  });

  it('uses GET only and leaves applied false on the spend preview', () => {
    const root = path.join(__dirname, '..');
    const script = readFileSync(path.join(root, 'scripts', 'e2e-trustshell-shadow.mjs'), 'utf8');
    const routeSrc = readFileSync(path.join(root, 'src', 'routes', 'human-spend-preview.ts'), 'utf8');
    const serviceSrc = readFileSync(path.join(root, 'src', 'services', 'spend-preview.ts'), 'utf8');
    const indexSrc = readFileSync(path.join(root, 'src', 'index.ts'), 'utf8');
    expect(script.includes("'POST'")).toBe(false);
    expect(script.includes('"POST"')).toBe(false);
    expect(script).not.toContain('token-signup');
    expect(script).not.toContain('/agents/human');
    expect(serviceSrc).toContain('applied: false');
    expect(routeSrc).not.toContain('.insert(');
    expect(serviceSrc).not.toContain('.insert(');
    const mountAt = indexSrc.indexOf("app.use('/api/v1', spendPreviewRouter)");
    const authAt = indexSrc.indexOf('app.use(authMiddleware)');
    expect(mountAt).toBeGreaterThan(-1);
    expect(authAt).toBeGreaterThan(mountAt);
  });
});
