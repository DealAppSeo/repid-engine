/**
 * [S3-5, 2026-10-16] The HTTP kill switch fails CLOSED in production, and nothing mutating runs before it.
 *
 * Before: while the halt state had never been read, or the latest read had failed, the guard let
 * every write through. So the switch protected nothing exactly when the database was unreachable.
 * It was also mounted after the public classify and telegram-public routers, so those two POST
 * doors ran during a halt.
 */
import { readFileSync } from 'fs';
import { join } from 'path';
import { __resetEmergencyHaltState, __stopEmergencyHaltRefresher, checkEmergencyHalt } from '../src/services/emergency-halt';
import { __resetEmergencyHaltMiddlewareState, emergencyHaltMiddleware } from '../src/middleware/emergency-halt';

type Result = { data?: any; error?: any };
function client(result: Result | (() => Result)) {
  return {
    from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => (typeof result === 'function' ? result() : result) }) }) }),
  } as any;
}

function call(mw: ReturnType<typeof emergencyHaltMiddleware>, method = 'POST') {
  const res: any = { statusCode: 0, body: undefined, headers: {} as Record<string, string> };
  res.setHeader = (k: string, v: string) => { res.headers[k] = v; };
  res.status = (c: number) => { res.statusCode = c; return res; };
  res.json = (b: unknown) => { res.body = b; return res; };
  const next = jest.fn();
  mw({ method, path: '/api/v1/classify' } as any, res, next);
  return { res, next };
}

const SAVED_NODE_ENV = process.env.NODE_ENV;
beforeEach(() => {
  __resetEmergencyHaltState();
  __stopEmergencyHaltRefresher();
  __resetEmergencyHaltMiddlewareState();
  delete process.env.EMERGENCY_HALT_MODE;
  jest.spyOn(console, 'warn').mockImplementation(() => {});
  jest.spyOn(console, 'error').mockImplementation(() => {});
  jest.spyOn(console, 'log').mockImplementation(() => {});
});
afterEach(() => {
  jest.restoreAllMocks();
  process.env.NODE_ENV = SAVED_NODE_ENV;
});

describe('fail-closed guard', () => {
  const guard = () => emergencyHaltMiddleware(client({ data: null }), { autoStartRefresher: false, failClosed: true });

  it('never read → a write gets 503 emergency_halt_unknown; a read passes', () => {
    const mw = guard();
    const w = call(mw);
    expect(w.next).not.toHaveBeenCalled();
    expect(w.res.statusCode).toBe(503);
    expect(w.res.body.error).toBe('emergency_halt_unknown');
    expect(w.res.headers['Retry-After']).toBe('5');
    expect(call(mw, 'GET').next).toHaveBeenCalled();
  });

  it('a failed read after a good read of false → 503; the next good read → writes pass again', async () => {
    let fail = false;
    const c = client(() => (fail ? { error: { message: 'connection reset' } } : { data: { emergency_halt: false }, error: null }));
    await checkEmergencyHalt(c, { cacheMs: 0 });
    const mw = guard();
    expect(call(mw).next).toHaveBeenCalled();
    fail = true;
    await checkEmergencyHalt(c, { cacheMs: 0 });
    expect(call(mw).res.statusCode).toBe(503);
    fail = false;
    await checkEmergencyHalt(c, { cacheMs: 0, now: Date.now() + 60_000 });
    expect(call(mw).next).toHaveBeenCalled();
  });

  it('a pulled switch that then fails to read stays a halt (503 emergency_halt)', async () => {
    let fail = false;
    const c = client(() => (fail ? { error: { message: 'timeout' } } : { data: { emergency_halt: true }, error: null }));
    await checkEmergencyHalt(c, { cacheMs: 0 });
    fail = true;
    await checkEmergencyHalt(c, { cacheMs: 0 });
    expect(call(guard()).res.body.error).toBe('emergency_halt');
  });

  it('a missing column is a completed read (switch inert), not an unknown state: writes pass', async () => {
    await checkEmergencyHalt(client({ error: { code: '42703', message: 'column emergency_halt does not exist' } }), { cacheMs: 0 });
    expect(call(guard()).next).toHaveBeenCalled();
  });

  it('shadow mode never refuses, even when the state is unknown', () => {
    process.env.EMERGENCY_HALT_MODE = 'shadow';
    expect(call(guard()).next).toHaveBeenCalled();
  });

  it('off skips the guard', () => {
    process.env.EMERGENCY_HALT_MODE = 'off';
    expect(call(guard()).next).toHaveBeenCalled();
  });
});

describe('the default follows NODE_ENV', () => {
  const mk = () => emergencyHaltMiddleware(client({ data: null }), { autoStartRefresher: false });
  it('production → fail-closed', () => {
    process.env.NODE_ENV = 'production';
    expect(call(mk()).res.statusCode).toBe(503);
  });
  it('test / dev → fail-open (writes pass, said once)', () => {
    process.env.NODE_ENV = 'test';
    expect(call(mk()).next).toHaveBeenCalled();
  });
});

describe('index.ts mounts the guard before every router', () => {
  const src = readFileSync(join(__dirname, '../src/index.ts'), 'utf8');
  const at = (needle: string) => {
    const i = src.indexOf(needle);
    expect(i).toBeGreaterThan(-1);
    return i;
  };
  it.each([
    "app.use('/api/v1', classifyRouter)",
    "app.use('/api/v1/telegram-public', telegramPublicRouter)",
    "app.use('/api/v1', fullAccountRouter)",
  ])('before %s', (mount) => {
    expect(at('app.use(emergencyHaltMiddleware(db))')).toBeLessThan(at(mount));
  });
});
