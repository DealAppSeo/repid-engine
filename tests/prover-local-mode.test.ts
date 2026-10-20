/**
 * LOCAL_MODE never sends a RepID proof request (an agent id and its score) off this machine.
 *
 * The production prover is REACHABLE here on purpose: the fetch stub answers any non-loopback
 * prover with 200 and a proof-shaped body, so a leak would succeed quietly instead of failing
 * loudly. Every fetch URL and every TCP connect is recorded, and the assertions are on what was
 * attempted. A loopback prover (a real local HTTP server) is the positive control.
 *
 * SYNTHETIC ids only. No keys, no hosted database, no chain, no payments.
 */
import express from 'express';
import request from 'supertest';
import { createServer, type Server } from 'http';
import net, { type AddressInfo } from 'net';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { PINNED_PROVER_URL, isLoopbackUrl, localProverGate, proverBaseUrl, proverRedirect } from '../src/config/prover';

const SYNTH = '00000000-0000-4000-8000-0000000000c1';
const LOCAL = { LOCAL_MODE: 'true' } as NodeJS.ProcessEnv;

beforeAll(() => jest.spyOn(console, 'warn').mockImplementation(() => undefined));
afterAll(() => jest.restoreAllMocks());

describe('the gate', () => {
  it('hosted is unchanged: the pin by default, ZKP_SERVICE_URL overrides', () => {
    expect(proverBaseUrl({} as NodeJS.ProcessEnv)).toBe(PINNED_PROVER_URL);
    expect(proverBaseUrl({ ZKP_SERVICE_URL: 'https://example.test' } as NodeJS.ProcessEnv)).toBe('https://example.test');
    expect(localProverGate('', {} as NodeJS.ProcessEnv)).toBe('');
  });

  it('LOCAL_MODE never defaults to the pin and refuses a remote override, loudly', () => {
    (console.warn as jest.Mock).mockClear();
    expect(proverBaseUrl(LOCAL)).toBeNull();
    expect(proverBaseUrl({ ...LOCAL, ZKP_SERVICE_URL: PINNED_PROVER_URL })).toBeNull();
    expect(proverBaseUrl({ ...LOCAL, ZKP_SERVICE_URL: 'https://example.test' })).toBeNull();
    expect((console.warn as jest.Mock).mock.calls.join('\n')).toMatch(/LOCAL_MODE: refusing prover/);
  });

  it('LOCAL_MODE keeps a loopback prover', () => {
    for (const u of ['http://127.0.0.1:9', 'http://localhost:9', 'http://[::1]:9', 'https://127.0.0.1:9/base']) {
      expect(proverBaseUrl({ ...LOCAL, ZKP_SERVICE_URL: u })).toBe(u);
    }
  });

  it('bypass shapes are refused: the parsed host decides, never a prefix', () => {
    for (const u of [
      'http://127.evil.example',
      'http://127.0.0.1.nip.io',
      'http://localhost.evil.example',
      'http://127.0.0.1@evil.example',
      'http://evil.example#@127.0.0.1',
      'http://[::ffff:127.0.0.1]',
      'http://0.0.0.0:9',
      'http://10.0.0.5:9',
      'http://192.168.1.2:9',
      'http://169.254.169.254',
      'ftp://127.0.0.1',
      'file:///etc/passwd',
      'not a url',
      '',
    ]) {
      expect([u, localProverGate(u, LOCAL)]).toEqual([u, null]);
      expect(isLoopbackUrl(u)).toBe(false);
    }
  });

  it('LOCAL_MODE is read trimmed and case-insensitive', () => {
    expect(proverBaseUrl({ LOCAL_MODE: ' TRUE ' } as NodeJS.ProcessEnv)).toBeNull();
  });

  it('latched at load: unsetting LOCAL_MODE after boot does not re-open egress', () => {
    const saved = process.env.LOCAL_MODE;
    process.env.LOCAL_MODE = 'true';
    let fresh!: typeof import('../src/config/prover');
    jest.isolateModules(() => { fresh = require('../src/config/prover'); });
    delete process.env.LOCAL_MODE;
    try {
      expect(fresh.proverBaseUrl({} as NodeJS.ProcessEnv)).toBeNull();
      expect(fresh.proverBaseUrl(process.env)).toBeNull();
    } finally {
      if (saved !== undefined) process.env.LOCAL_MODE = saved;
    }
  });

  it('a local store latches it whatever the load order: prover.ts first, LOCAL_MODE later, then deleted (XC1 F3)', () => {
    const saved = process.env.LOCAL_MODE;
    delete process.env.LOCAL_MODE;
    let fresh!: typeof import('../src/config/prover');
    jest.isolateModules(() => {
      fresh = require('../src/config/prover');
      expect(fresh.proverBaseUrl(process.env)).toBe(process.env.ZKP_SERVICE_URL || PINNED_PROVER_URL);
      process.env.LOCAL_MODE = 'true';
      require('../src/config'); // picks the local store and latches the gate
    });
    delete process.env.LOCAL_MODE;
    try {
      expect(fresh.proverBaseUrl(process.env)).toBeNull();
      expect(fresh.proverRedirect(process.env)).toBe('error');
    } finally {
      if (saved !== undefined) process.env.LOCAL_MODE = saved;
    }
  });

  it('redirects: refused in LOCAL_MODE, fetch default (follow) when hosted', () => {
    expect(proverRedirect({} as NodeJS.ProcessEnv)).toBe('follow');
    expect(proverRedirect(LOCAL)).toBe('error');
  });
});

describe('LOCAL_MODE end to end: the production prover is reachable and never contacted', () => {
  const fetched: string[] = [];
  const connects: string[] = [];
  const localHits: string[] = [];
  let realFetch: typeof global.fetch;
  let realConnect: typeof net.Socket.prototype.connect;
  let localProver: Server;
  let localUrl: string;
  let closedUrl: string;
  let tmp: string;
  let store: any;
  let pipeline: typeof import('../src/scoring/pipeline');
  let plonky3: typeof import('../src/zkp/plonky3-real');
  let drain: typeof import('../src/services/proof-drain-service');
  let app: express.Express;
  let savedEnv: NodeJS.ProcessEnv;

  // The harness judges "loopback" on its own, not with the function under test (XC1 review).
  const loop = (u: string) => { try { return ['localhost', '127.0.0.1', '[::1]'].includes(new URL(u).hostname); } catch { return false; } };
  const loopHost = (h: string) => /^(127\.0\.0\.1|::1|localhost):/.test(h);
  const remote = () => fetched.filter((u) => !loop(u));
  const remoteSockets = () => connects.filter((h) => !loopHost(h));
  const proverEnv = (u?: string) => {
    if (u) process.env.ZKP_SERVICE_URL = u; else delete process.env.ZKP_SERVICE_URL;
    delete process.env.PLONKY3_PROVER_URL;
  };

  beforeAll(async () => {
    savedEnv = { ...process.env };
    localProver = createServer((req, res) => {
      localHits.push(req.url ?? '');
      req.resume();
      req.on('end', () => {
        if (req.url?.endsWith('/fail/prove/trade_auth')) { res.statusCode = 500; res.end('{}'); return; }
        // A loopback "prover" that bounces the POST to the production host (XC1 F1).
        if (req.url?.startsWith('/redirect/')) {
          res.statusCode = req.url.includes('trade_auth') ? 308 : 307;
          res.setHeader('Location', PINNED_PROVER_URL + req.url.slice('/redirect'.length));
          res.end();
          return;
        }
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ proof_bytes: 'bG9jYWw=' }));
      });
    });
    await new Promise<void>((r) => localProver.listen(0, '127.0.0.1', () => r()));
    localUrl = `http://127.0.0.1:${(localProver.address() as AddressInfo).port}`;
    const probe = createServer();
    await new Promise<void>((r) => probe.listen(0, '127.0.0.1', () => r()));
    closedUrl = `http://127.0.0.1:${(probe.address() as AddressInfo).port}`;
    await new Promise<void>((r) => probe.close(() => r()));

    // Env BEFORE module load: src/config.ts and src/db.ts choose the local store at import.
    for (const k of Object.keys(process.env)) {
      if (/^SUPABASE_|^DATABASE_URL$|^REDIS_URL$|^ZKP_SERVICE_|^PLONKY3_PROVER_URL$|PRIVATE_KEY/.test(k)) delete process.env[k];
    }
    process.env.LOCAL_MODE = 'true';
    tmp = mkdtempSync(join(tmpdir(), 'repid-prover-local-'));
    process.env.LOCAL_STORE_PATH = join(tmp, 'repid.db');

    realConnect = net.Socket.prototype.connect;
    net.Socket.prototype.connect = function (this: net.Socket, ...args: any[]) {
      const o = Array.isArray(args[0]) ? args[0][0] : args[0]; // net.connect passes [options, cb]
      // Anything not plainly host+port is recorded as UNKNOWN, which counts as remote below.
      const hostPort = o && typeof o === 'object' && o.port !== undefined ? `${o.host ?? 'localhost'}:${o.port}` : `UNKNOWN:${JSON.stringify(o)}`;
      connects.push(hostPort);
      // BLOCK, not just record: a non-loopback socket never opens from this test.
      if (!loopHost(hostPort)) throw new Error(`EGRESS BLOCKED by test: ${hostPort}`);
      return (realConnect as any).apply(this, args);
    } as any;

    realFetch = global.fetch;
    (global as any).fetch = async (input: any, init?: any) => {
      const url = typeof input === 'string' ? input : input?.url ?? String(input);
      fetched.push(url);
      if (loop(url)) return (realFetch as any)(input, init);
      // REACHABLE: answer the way the production prover would. A leak would succeed here.
      const body = { proof_bytes: 'cmVhY2hhYmxl', proof_type: 'plonky3' };
      return { ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) };
    };

    jest.resetModules();
    ({ db: store } = require('../src/db'));
    pipeline = require('../src/scoring/pipeline');
    plonky3 = require('../src/zkp/plonky3-real');
    drain = require('../src/services/proof-drain-service');
    app = express();
    app.use(express.json());
    app.use('/api/v1', require('../src/routes/repid').repidAdminRouter);
    app.use('/api/v1', require('../src/routes/v1').default);

    await store.from('repid_agents').insert({
      id: SYNTH, agent_name: 'SYNTHETIC-PROVER-LOCAL', current_repid: 300, tier: 'PROBATIONARY', activity_30d: 0, constitution: {},
    });
  });

  afterAll(async () => {
    (global as any).fetch = realFetch;
    net.Socket.prototype.connect = realConnect;
    process.env = savedEnv;
    try { store?.close?.(); } catch { /* ignore */ }
    await new Promise<void>((r) => localProver.close(() => r()));
    try { rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it('runs against the local store, not a hosted database', () => {
    expect(store.__localStore).toBe(true);
  });

  it('applyValidationEvent with |delta| >= 5 (the receipt-loop path): no proof id, no queue row, no request', async () => {
    proverEnv();
    await pipeline.applyValidationEvent(SYNTH, 'VALIDATION_PASSED', 25, {}, { hal_score: 0.9, hal_decision: 'clean' });
    const events = (await store.from('repid_score_events').select('*').eq('agent_id', SYNTH)).data;
    expect(events.length).toBeGreaterThan(0);
    for (const e of events) {
      expect(e.zk_proof_id ?? null).toBeNull();
      expect(Boolean(e.zk_proof_triggered)).toBe(false);
    }
    expect((await store.from('repid_proof_queue').select('*').eq('agent_id', SYNTH)).data).toEqual([]);
    expect(remote()).toEqual([]);
  });

  it('a remote ZKP_SERVICE_URL override is refused the same way', async () => {
    proverEnv('https://example.test');
    await pipeline.applyValidationEvent(SYNTH, 'VALIDATION_PASSED', 25, {}, { hal_score: 0.9, hal_decision: 'clean' });
    expect((await store.from('repid_proof_queue').select('*').eq('agent_id', SYNTH)).data).toEqual([]);
    expect(remote()).toEqual([]);
  });

  it('positive control: a loopback prover gets the request, and only it does', async () => {
    proverEnv(localUrl);
    const before = localHits.length;
    await pipeline.applyValidationEvent(SYNTH, 'VALIDATION_PASSED', 25, {}, { hal_score: 0.9, hal_decision: 'clean' });
    for (let i = 0; i < 100 && localHits.length === before; i++) await new Promise((r) => setTimeout(r, 20));
    expect(localHits.slice(before)).toEqual(['/zkp/repid-proof']);
    const queued = (await store.from('repid_proof_queue').select('*').eq('agent_id', SYNTH)).data;
    expect(queued.map((q: any) => q.zkp_service_url)).toEqual([localUrl]);
    expect(connects.some((h) => h.startsWith('127.0.0.1:'))).toBe(true); // the socket hook sees real traffic
    expect(remote()).toEqual([]);
  });

  it('generateProofReal: a reachable remote prover is not called and no HMAC stand-in comes back', async () => {
    process.env.PLONKY3_PROVER_URL = PINNED_PROVER_URL;
    const n = fetched.length;
    await expect(plonky3.generateProofReal(SYNTH, 'pub', 'postcard', 't')).rejects.toBeInstanceOf(plonky3.ProverUnavailableError);
    proverEnv();
    await expect(plonky3.generateProofReal(SYNTH, 'pub', 'postcard', 't')).rejects.toThrow(/PROVER_UNAVAILABLE/);
    expect(fetched.length).toBe(n);
  });

  it('a missing or failing local prover fails safely: PROVER_UNAVAILABLE, never an HMAC', async () => {
    proverEnv(closedUrl);
    await expect(plonky3.generateProofReal(SYNTH, 'pub', 'postcard', 't')).rejects.toBeInstanceOf(plonky3.ProverUnavailableError);
    proverEnv(`${localUrl}/fail`);
    await expect(plonky3.generateProofReal(SYNTH, 'pub', 'postcard', 't')).rejects.toThrow(/HTTP 500/);
    proverEnv(localUrl);
    await expect(plonky3.generateProofReal(SYNTH, 'pub', 'postcard', 't')).resolves.toMatchObject({ proof_source: 'plonky3_real' });
  });

  it('a missing local prover does not block scoring: the score lands, nothing leaves', async () => {
    proverEnv(closedUrl);
    const out = await pipeline.applyValidationEvent(SYNTH, 'VALIDATION_PASSED', 25, {}, { hal_score: 0.9, hal_decision: 'clean' });
    expect(out.new_repid).toBeGreaterThan(out.old_repid);
    await new Promise((r) => setTimeout(r, 200));
    expect(remote()).toEqual([]);
  });

  it('POST /prove-repid and /batch/prove answer 503 PROVER_UNAVAILABLE, with no proof in the body', async () => {
    proverEnv();
    const one = await request(app).post('/api/v1/prove-repid').send({ agent_id: SYNTH, requester_pubkey: 'pub', requested_tier: 'postcard' });
    expect(one.status).toBe(503);
    expect(one.body).toMatchObject({ status: 'PROVER_UNAVAILABLE' });
    expect(one.body.proof).toBeUndefined();
    const batch = await request(app).post('/api/v1/batch/prove').send({ requests: [{ agent_id: SYNTH, requester_pubkey: 'pub', tier: 'postcard' }] });
    expect(batch.status).toBe(503);
    expect(batch.body.proofs).toBeUndefined();
  });

  it('the proof drain refuses a remote prover at construction, before any job is read', () => {
    expect(() => drain.createProofDrainService({ supabase: {} as any, zkpServiceUrl: PINNED_PROVER_URL })).toThrow(/loopback/);
    expect(() => drain.createProofDrainService({ supabase: {} as any, zkpServiceUrl: localUrl })).not.toThrow();
  });

  describe('a loopback prover that redirects to the production host (XC1 F1)', () => {
    const before = () => connects.length;
    const newRemoteSockets = (n: number) => connects.slice(n).filter((h) => !loopHost(h));

    it('applyValidationEvent: the 307 is not followed; the body stays on this machine', async () => {
      proverEnv(`${localUrl}/redirect`);
      const n = before();
      const hits = localHits.length;
      await pipeline.applyValidationEvent(SYNTH, 'VALIDATION_PASSED', 25, {}, { hal_score: 0.9, hal_decision: 'clean' });
      for (let i = 0; i < 100 && localHits.length === hits; i++) await new Promise((r) => setTimeout(r, 20));
      await new Promise((r) => setTimeout(r, 200));
      expect(localHits.slice(hits)).toEqual(['/redirect/zkp/repid-proof']); // it did reach the loopback prover
      expect(newRemoteSockets(n)).toEqual([]);
    });

    it('generateProofReal: the 308 is not followed and nothing comes back labelled real', async () => {
      process.env.PLONKY3_PROVER_URL = `${localUrl}/redirect`;
      const n = before();
      await expect(plonky3.generateProofReal(SYNTH, 'pub', 'postcard', 't')).rejects.toBeInstanceOf(plonky3.ProverUnavailableError);
      delete process.env.PLONKY3_PROVER_URL;
      expect(newRemoteSockets(n)).toEqual([]);
    });

    it('proof-refresh-worker on the real fetch: the 307 is not followed', async () => {
      const { runOnce } = require('../src/workers/proof-refresh-worker');
      process.env.PROOF_REFRESH_ENABLED = 'true';
      const n = before();
      const summary = await runOnce({ maxAgeDays: 6, maxAgents: 25, intervalMs: 3_600_000 }, {
        query: async () => [{ agent_id: SYNTH, agent_name: 'SYNTH', current_repid: 300, last_proof_at: new Date(Date.now() - 10 * 86_400_000).toISOString(), event_id: 'ev-1', repid_after: 300 }],
        enqueue: async () => ({ error: null }),
        fetchImpl: (...a: any[]) => (global.fetch as any)(...a),
        proverUrl: `${localUrl}/redirect`,
        isHalted: async () => false,
        log: () => undefined,
        warn: () => undefined,
      });
      delete process.env.PROOF_REFRESH_ENABLED;
      expect(summary.proverFailed).toBe(1);
      expect(newRemoteSockets(n)).toEqual([]);
    });
  });

  it('across every case above: zero non-loopback fetches and zero non-loopback sockets', () => {
    expect(remote()).toEqual([]);
    expect(remoteSockets()).toEqual([]);
  });
});
