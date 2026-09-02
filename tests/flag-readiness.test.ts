/**
 * A DEPLOYMENT THAT CAN ANSWER "IS THIS FLAG ACTUALLY ON" — AND CANNOT LIE ABOUT IT.
 *
 * The endpoint exists because on 2026-09-02 that question was answered three different ways
 * in one session by someone who could not reach the Railway dashboard, and the true answer
 * was only established by driving production and reading the status code. The reasoning is in
 * `src/config/flag-readiness.ts`.
 *
 * A reporter is worth exactly as much as the guarantee that it agrees with the thing it
 * reports on, so most of what follows tests the ways it could drift:
 *
 *   DRIFT FROM THE GATES   The gates are `=== 'true'`. If one is ever loosened to accept `'1'`
 *                          while this module still classifies `'1'` as `ignored_value`, the
 *                          endpoint reports a live feature as off. The source-scan test below
 *                          reads the REAL gate expressions out of `src/` and fails on that,
 *                          which no amount of testing this module against itself would catch.
 *
 *   DRIFT FROM THE PROCESS The gates latch at module scope, so a variable changed without a
 *                          restart leaves the process running the old value. Reading
 *                          `process.env` per request and comparing against the boot-time latch
 *                          is what turns that into `restart_required` instead of a silent
 *                          wrong answer.
 *
 *   LEAKING                A public endpoint reading configuration is one bad edit away from
 *                          being a public endpoint reading secrets. The allowlist is asserted
 *                          to be closed, and the response asserted to contain no value.
 *
 * The mount-order test is the counterpart of the one in account-connect-ratelimit.test.ts:
 * a route mounted after `authMiddleware` would 401 for exactly the keyless callers it exists
 * to serve, and would still read correctly to a reviewer.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

// src/config.ts throws without these, and importing the real app pulls it in. Defaults only —
// they never reach a network, because the db module is mocked below. Same idiom as
// tests/account-connect-ratelimit.test.ts, the closest neighbour on this surface.
process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://localhost:54321';
process.env.SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || 'dummy';

jest.mock('../src/db', () => {
  const chain: any = {
    select: () => chain,
    eq: () => chain,
    ilike: () => chain,
    limit: async () => ({ data: [], error: null }),
    maybeSingle: async () => ({ data: null, error: null }),
    single: async () => ({ data: null, error: null }),
  };
  return { db: { from: () => chain, rpc: async () => ({ data: null, error: null }) } };
});

import request from 'supertest';
import {
  classifyFlag,
  describeFlagReadiness,
  PUBLIC_FLAGS,
  TRUTHY,
} from '../src/config/flag-readiness';
// Importing the app is what latches the boot-time flag values inside routes/readiness.ts.
import app from '../src/index';

/**
 * The environment as it stood when the app was imported — i.e. what the route latched.
 * Captured immediately after that import so the two cannot disagree, and restored after every
 * test that mutates it.
 */
const AT_BOOT = Object.fromEntries(PUBLIC_FLAGS.map((f) => [f.name, process.env[f.name]]));

afterEach(() => {
  for (const [name, value] of Object.entries(AT_BOOT)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

describe('classifyFlag — off and ignored_value are not the same thing', () => {
  it('reports the exact string the gates require as on, and nothing else', () => {
    expect(classifyFlag('true')).toBe('on');
  });

  it('reports an unset or empty variable as off — the deliberate default', () => {
    expect(classifyFlag(undefined)).toBe('off');
    expect(classifyFlag('')).toBe('off');
    expect(classifyFlag('   ')).toBe('off');
  });

  it.each(['ON', 'On', 'TRUE', 'True', '1', 'yes', 'enabled'])(
    'reports %s as ignored_value, because the gate will not honour it',
    (value) => {
      // This is the whole reason the endpoint earns its place. Every one of these renders in
      // a dashboard as a populated variable and evaluates FALSE at `=== 'true'`. Folding them
      // into `off` would make this endpoint agree with the process and leave the operator's
      // actual mistake invisible.
      expect(classifyFlag(value)).toBe('ignored_value');
    }
  );

  it('does not trim before comparing, because the gates do not', () => {
    // ` true` is off to `=== 'true'`. Reporting it `on` would be the reporter drifting from
    // the thing reported — a false all-clear, the one failure this file cannot have.
    expect(classifyFlag(' true')).toBe('ignored_value');
    expect(classifyFlag('true ')).toBe('ignored_value');
  });
});

describe('describeFlagReadiness — the allowlist is closed', () => {
  it('reports every allowlisted flag and no others, whatever the environment holds', () => {
    const env: Record<string, string> = {
      SOME_OTHER_FLAG_ENABLED: 'true',
      SUPABASE_SERVICE_KEY: 'sb_secret_do_not_leak_me',
      PATH: '/usr/bin',
    };
    for (const f of PUBLIC_FLAGS) env[f.name] = 'true';

    const { flags } = describeFlagReadiness(env);

    // Not a subset check: the key set must be EXACTLY the allowlist. A version of this that
    // enumerated `process.env` would pass a subset assertion and leak the other three.
    expect(Object.keys(flags).sort()).toEqual(PUBLIC_FLAGS.map((f) => f.name).sort());
  });

  it('never puts a value anywhere in its output', () => {
    const env = Object.fromEntries(PUBLIC_FLAGS.map((f) => [f.name, 'sk-live-secret-value']));
    const out = JSON.stringify(describeFlagReadiness(env));
    expect(out).not.toContain('sk-live-secret-value');
  });

  it('flags only the misconfigured ones — off is a legitimate configuration', () => {
    const [first, ...rest] = PUBLIC_FLAGS;
    const env: Record<string, string | undefined> = { [first.name]: 'ON' };
    for (const f of rest) env[f.name] = undefined;

    const { misconfigured } = describeFlagReadiness(env);

    // `misconfigured` is a to-do list. Listing deliberately-off flags there would make the
    // healthy production state look broken, and a warning that is always on is ignored.
    expect(misconfigured).toEqual([first.name]);
  });

  it('every allowlisted flag carries the argument for why it is safe to publish', () => {
    // `why` exists to make that argument mandatory rather than optional — adding a flag here
    // is a disclosure decision, and this fails if someone treats it as a maintenance edit.
    for (const f of PUBLIC_FLAGS) {
      expect(f.why.length).toBeGreaterThan(40);
    }
  });
});

describe('the reporter agrees with the gates it reports on', () => {
  // Reads the real source rather than this module's own constant. Testing TRUTHY against
  // TRUTHY proves nothing; the hazard is a GATE changing while this module does not.
  function sourceFiles(dir: string, acc: string[] = []): string[] {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) sourceFiles(full, acc);
      else if (entry.endsWith('.ts')) acc.push(full);
    }
    return acc;
  }

  const FILES = sourceFiles(join(__dirname, '..', 'src'));

  it.each(PUBLIC_FLAGS.map((f) => f.name))(
    'every gate on %s compares against the exact string this module reports',
    (name) => {
      const uses: string[] = [];
      for (const file of FILES) {
        const text = readFileSync(file, 'utf8');
        // Capture what immediately follows each read of the variable.
        for (const m of text.matchAll(new RegExp(`process\\.env\\.${name}([^;\\n]*)`, 'g'))) {
          uses.push(m[1].trim());
        }
      }

      // If this is 0 the flag was renamed or deleted and the allowlist is now describing a
      // variable nothing reads — a readiness endpoint reporting on a gate that no longer
      // exists is worse than one that is missing.
      expect(uses.length).toBeGreaterThan(0);

      for (const rest of uses) {
        expect(rest).toBe(`=== '${TRUTHY}'`);
      }
    }
  );
});

describe('GET /readiness — reachable by the callers it exists for', () => {
  it('answers a request carrying no API key at all', async () => {
    // The point of the endpoint. Mounted after authMiddleware this would be 401 for exactly
    // the callers it serves — an agent session, a curl, a pg_net probe — and would still read
    // correctly to a reviewer.
    const res = await request(app).get('/readiness');
    expect(res.status).toBe(200);
    for (const f of PUBLIC_FLAGS) {
      expect(res.body.flags).toHaveProperty(f.name);
    }
  });

  it('refuses to be cached, so a restart is visible the moment it lands', async () => {
    // `www` was caught serving `x-vercel-cache: HIT` on exactly this kind of route. Someone
    // reading this endpoint is watching for a change to take effect; a stale 200 is the one
    // answer that wastes their time completely.
    const res = await request(app).get('/readiness');
    expect(res.headers['cache-control']).toBe('no-store');
  });

  it('names the build it is describing', async () => {
    // A flag report with no commit on it is ambiguous for as long as a deploy takes, which is
    // exactly when it gets read. Railway keeps the last SUCCESSFUL build serving when a new
    // one fails, so "I saved it and it still says off" has two causes and this separates them.
    const res = await request(app).get('/readiness');
    expect(res.body).toHaveProperty('deployed_commit');
    expect(res.body).toHaveProperty('checked_at');
  });

  it('reports nothing needing a restart when the environment is unchanged', async () => {
    // The anchor. Without it the test below passes just as well against an endpoint that
    // reports every flag as stale all the time.
    const res = await request(app).get('/readiness');
    expect(res.body.restart_required).toEqual([]);
  });

  it('reports a variable changed since boot as needing a restart, not as live', async () => {
    const name = PUBLIC_FLAGS[0].name;
    // The real scenario: someone edits the variable in Railway and re-reads this endpoint
    // before the service has restarted. The GATES still hold the boot-time value, so calling
    // the feature on here would be a confident wrong answer of exactly the kind that started
    // all this.
    process.env[name] = AT_BOOT[name] === 'true' ? 'false' : 'true';

    const res = await request(app).get('/readiness');
    expect(res.body.restart_required).toContain(name);
  });

  it('leaks no value even when the flags hold secret-shaped strings', async () => {
    for (const f of PUBLIC_FLAGS) process.env[f.name] = 'sb_secret_leaked';
    const res = await request(app).get('/readiness');
    expect(JSON.stringify(res.body)).not.toContain('sb_secret_leaked');
  });
});
