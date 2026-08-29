/**
 * The password signup path is retired, and the door that replaced it is visible.
 *
 * THE FINDING THIS CLOSES, measured against production 2026-08-29:
 * `POST /api/v1/builder/full-signup` answered 400 (a validation error) to an
 * empty body rather than 401 — establishing it was reachable with no credential
 * at all. It then created a builder starting at the AUTONOMOUS tier floor from
 * an email address nobody had verified. One keyless request, one high-authority
 * account, ownership of the address asserted rather than proven.
 *
 * The starting score is deliberately unchanged. What a signup is worth is an
 * economic decision; this is a change to which doors exist.
 *
 * The second half of the suite is the part that is easy to skip and shouldn't
 * be: closing one door leaves email-OTP as the ONLY way in, and that path shuts
 * silently when its configuration is missing. `signupPosture()` reports each
 * precondition separately, so "signup is broken" can never stand in for three
 * unrelated fixes.
 */

process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://localhost:54321';
process.env.SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || 'dummy';

import { readFileSync, readdirSync, statSync } from 'fs';
import { join, resolve } from 'path';
import express from 'express';
import request from 'supertest';
import fullAccountRouter from '../src/routes/full-account';
import { signupPosture, __resetSignupPostureLogForTests } from '../src/services/signup-posture';

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/v1', fullAccountRouter);
  return app;
}

describe('the password path is closed', () => {
  it('refuses signup with 410, not 400 — the shape that proved it was open', async () => {
    const res = await request(makeApp())
      .post('/api/v1/builder/full-signup')
      .send({ email: 'someone@example.com', password: 'longenoughpassword' });
    expect(res.status).toBe(410);
    expect(res.body.error).toBe('password_signup_retired');
  });

  it('refuses login with 410', async () => {
    const res = await request(makeApp())
      .post('/api/v1/builder/login')
      .send({ email: 'someone@example.com', password: 'longenoughpassword' });
    expect(res.status).toBe(410);
    expect(res.body.error).toBe('password_signup_retired');
  });

  it('names a replacement path that actually exists in the router', () => {
    // An error message inventing an endpoint is worse than no message. These are
    // read off agent-gate.ts, so a rename there fails this test rather than
    // leaving a dead pointer in a 410 body.
    const gate = readFileSync(resolve(__dirname, '..', 'src', 'routes', 'agent-gate.ts'), 'utf8');
    const route = readFileSync(resolve(__dirname, '..', 'src', 'routes', 'full-account.ts'), 'utf8');
    const named = route.match(/use_instead:\s*'([^']+)'/)?.[1] ?? '';
    expect(named).toContain('/api/v1/agent-gate/request-otp');
    expect(named).toContain('/api/v1/agent-gate/verify-otp');
    expect(gate).toContain(`'/v1/agent-gate/request-otp'`);
    expect(gate).toContain(`'/v1/agent-gate/verify-otp'`);
  });

  it('answers without touching the database — the refusals are synchronous', async () => {
    // No db mock is installed in this suite. A handler that did a lookup would
    // reach the real client against an unreachable host and hang or throw.
    const res = await request(makeApp()).post('/api/v1/builder/login').send({});
    expect(res.status).toBe(410);
  });

  it('gives the same answer to a known-shaped and a garbage address — no oracle', async () => {
    const a = await request(makeApp()).post('/api/v1/builder/login').send({ email: 'a@b.co', password: 'x' });
    const b = await request(makeApp()).post('/api/v1/builder/login').send({ email: 'nonsense', password: '' });
    expect(a.status).toBe(b.status);
    expect(a.body).toEqual(b.body);
  });
});

describe('no route can reach the account-minting helpers any more', () => {
  // Structural, because a future route could re-open the hole without touching
  // any file this suite otherwise reads. Anchored below so a broken walker
  // cannot pass by finding nothing anywhere.
  function routeFiles(): string[] {
    const dir = resolve(__dirname, '..', 'src', 'routes');
    const out: string[] = [];
    const walk = (d: string) => {
      for (const name of readdirSync(d)) {
        const full = join(d, name);
        if (statSync(full).isDirectory()) {
          if (name !== '__tests__') walk(full);
        } else if (name.endsWith('.ts')) {
          out.push(full);
        }
      }
    };
    walk(dir);
    return out;
  }

  it('ANCHOR: the walker reads real route files and finds a symbol known to be there', () => {
    const files = routeFiles();
    expect(files.length).toBeGreaterThan(20);
    const anyMentionsRouter = files.some((f) => readFileSync(f, 'utf8').includes('Router'));
    expect(anyMentionsRouter).toBe(true);
  });

  it('createFullBuilder and verifyPassword are referenced by no route', () => {
    const offenders = routeFiles().filter((f) => {
      const src = readFileSync(f, 'utf8');
      return src.includes('createFullBuilder') || src.includes('verifyPassword');
    });
    expect(offenders).toEqual([]);
  });
});

describe('signupPosture — the remaining door is reported, not assumed', () => {
  const saved = { ...process.env };
  afterEach(() => {
    process.env = { ...saved };
    __resetSignupPostureLogForTests();
  });

  function setEnv(provisioning: boolean, email: boolean, signing: boolean) {
    if (provisioning) process.env.GATE_PROVISIONS_ACCOUNT = 'true';
    else delete process.env.GATE_PROVISIONS_ACCOUNT;
    if (email) process.env.RESEND_API_KEY = 'x';
    else delete process.env.RESEND_API_KEY;
    if (signing) process.env.FULL_ACCOUNT_JWT_SECRET = 'x';
    else delete process.env.FULL_ACCOUNT_JWT_SECRET;
  }

  it('reports the password path as RETIRED, never as merely shut', () => {
    expect(signupPosture().password.state).toBe('RETIRED');
  });

  it('OPEN only when all three preconditions are met', () => {
    setEnv(true, true, true);
    const p = signupPosture();
    expect(p.email_otp.state).toBe('OPEN');
    expect(p.email_otp.blocked_by).toEqual([]);
    expect(p.any_path_open).toBe(true);
  });

  it('each missing precondition shuts the door ON ITS OWN', () => {
    for (const [prov, mail, sign] of [[false, true, true], [true, false, true], [true, true, false]] as const) {
      setEnv(prov, mail, sign);
      const p = signupPosture();
      expect(p.email_otp.state).toBe('SHUT');
      expect(p.any_path_open).toBe(false);
      expect(p.email_otp.blocked_by).toHaveLength(1);
    }
  });

  it('reports EVERY unmet precondition, not just the first', () => {
    setEnv(false, false, false);
    const p = signupPosture();
    expect(p.email_otp.blocked_by).toHaveLength(3);
    expect(p.note).toMatch(/NO ACCOUNT CREATION PATH IS OPEN/);
  });

  it('treats a non-"true" provisioning value as disabled — enablement is never incidental', () => {
    setEnv(true, true, true);
    process.env.GATE_PROVISIONS_ACCOUNT = '1';
    expect(signupPosture().email_otp.account_provisioning).toBe('DISABLED');
    process.env.GATE_PROVISIONS_ACCOUNT = 'TRUE';
    expect(signupPosture().email_otp.account_provisioning).toBe('DISABLED');
  });

  it('leaks no credential name or value', () => {
    setEnv(false, false, false);
    const blob = JSON.stringify(signupPosture());
    for (const name of ['RESEND_API_KEY', 'FULL_ACCOUNT_JWT_SECRET', 'GATE_PROVISIONS_ACCOUNT']) {
      expect(blob).not.toContain(name);
    }
  });
});
