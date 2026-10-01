import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readFileSync } from 'node:fs';
import { getT12HeartbeatLast, T12_HEARTBEAT_SQL } from '../src/orchestration/t12-heartbeat-last';
import { T12_HEARTBEAT_SQL as PROBE_SQL } from '../src/orchestration/t12-heartbeat-probe';

const ISO = '2099-01-01T00:00:00.000Z';

describe('T12 heartbeat last-seen helper', () => {
  it('returns NOT_CHECKED when T12_FREE_WAVE is not the exact string true', () => {
    const rows = [{ last_heartbeat_at: ISO }];
    expect(getT12HeartbeatLast({}, () => rows)).toEqual({
      status: 'NOT_CHECKED',
      last_heartbeat_at: null,
    });
    expect(getT12HeartbeatLast({ T12_FREE_WAVE: 'TRUE' }, () => rows)).toEqual({
      status: 'NOT_CHECKED',
      last_heartbeat_at: null,
    });
    expect(getT12HeartbeatLast({ T12_FREE_WAVE: '1' }, () => rows)).toEqual({
      status: 'NOT_CHECKED',
      last_heartbeat_at: null,
    });
    expect(getT12HeartbeatLast({ T12_FREE_WAVE: 'on' }, () => rows)).toEqual({
      status: 'NOT_CHECKED',
      last_heartbeat_at: null,
    });
    expect(getT12HeartbeatLast({ T12_FREE_WAVE: '' }, () => rows)).toEqual({
      status: 'NOT_CHECKED',
      last_heartbeat_at: null,
    });
  });

  it('passes the canonical SQL to the callback and returns a counted timestamp', () => {
    const sqls: string[] = [];
    const result = getT12HeartbeatLast({ T12_FREE_WAVE: 'true' }, (sql) => {
      sqls.push(sql);
      return [{ last_heartbeat_at: ISO }];
    });
    expect(sqls).toEqual([PROBE_SQL]);
    expect(T12_HEARTBEAT_SQL).toBe(PROBE_SQL);
    expect(result).toEqual({ status: 'counted', last_heartbeat_at: ISO });
  });

  it('returns NOT_CHECKED for missing, empty, or malformed rows even when flag is on', () => {
    const cases = [
      null,
      undefined,
      [],
      [{ last_heartbeat_at: null }],
      [{ last_heartbeat_at: '' }],
      [{ last_heartbeat_at: 0 as unknown as string }],
    ];
    for (const rows of cases) {
      expect(
        getT12HeartbeatLast({ T12_FREE_WAVE: 'true' }, () => rows as any),
      ).toEqual({ status: 'NOT_CHECKED', last_heartbeat_at: null });
    }
  });

  it('returns NOT_CHECKED when the query callback throws', () => {
    expect(
      getT12HeartbeatLast({ T12_FREE_WAVE: 'true' }, () => {
        throw new Error('read failed');
      }),
    ).toEqual({ status: 'NOT_CHECKED', last_heartbeat_at: null });
  });

  it('does not fetch or call vendors', () => {
    const src = readFileSync(
      path.join(__dirname, '..', 'src', 'orchestration', 't12-heartbeat-last.ts'),
      'utf8',
    );
    expect(src).toContain('T12_HEARTBEAT_SQL');
    expect(src).toContain('t12-heartbeat-probe');
    expect(src).not.toContain('fetch(');
    expect(src).not.toContain('api.anthropic.com');
    expect(src).not.toContain('anthropic');
    expect(src).not.toContain('process.env');
  });
});

describe('scripts/t12-heartbeat-last.mjs', () => {
  const scriptPath = path.join(__dirname, '..', 'scripts', 't12-heartbeat-last.mjs');
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), 't12-heartbeat-last-'));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function run(extraEnv: Record<string, string | undefined>, fixturePath?: string) {
    const env: NodeJS.ProcessEnv = { ...process.env, ...extraEnv };
    if (fixturePath !== undefined) {
      env.T12_HEARTBEAT_LAST_FIXTURE = fixturePath;
    }
    return spawnSync('node', [scriptPath], { env, encoding: 'utf8' });
  }

  function fixture(name: string, content: unknown) {
    const p = path.join(tmpDir, name);
    writeFileSync(p, JSON.stringify(content), 'utf8');
    return p;
  }

  it('prints NOT_CHECKED and exits 2 when the flag is off or missing', () => {
    const off = run({ T12_FREE_WAVE: 'TRUE' });
    expect(off.status).toBe(2);
    expect(off.stdout.trim()).toBe('NOT_CHECKED');

    const missing = run({});
    expect(missing.status).toBe(2);
    expect(missing.stdout.trim()).toBe('NOT_CHECKED');
  });

  it('prints the timestamp and exits 0 when a fixture row is present', () => {
    const p = fixture('ok.json', { rows: [{ last_heartbeat_at: ISO }] });
    const res = run({ T12_FREE_WAVE: 'true' }, p);
    expect(res.status).toBe(0);
    expect(res.stdout.trim()).toBe(ISO);
  });

  it('prints the timestamp from a bare-array fixture', () => {
    const p = fixture('array.json', [{ last_heartbeat_at: ISO }]);
    const res = run({ T12_FREE_WAVE: 'true' }, p);
    expect(res.status).toBe(0);
    expect(res.stdout.trim()).toBe(ISO);
  });

  it('prints NOT_CHECKED when the fixture is missing', () => {
    const res = run({ T12_FREE_WAVE: 'true' }, path.join(tmpDir, 'does-not-exist.json'));
    expect(res.status).toBe(2);
    expect(res.stdout.trim()).toBe('NOT_CHECKED');
  });

  it('prints NOT_CHECKED when the fixture has no usable timestamp', () => {
    const p = fixture('empty.json', { rows: [{ last_heartbeat_at: '' }] });
    const res = run({ T12_FREE_WAVE: 'true' }, p);
    expect(res.status).toBe(2);
    expect(res.stdout.trim()).toBe('NOT_CHECKED');
  });

  it('prints NOT_CHECKED when the fixture is malformed JSON', () => {
    const p = path.join(tmpDir, 'bad.json');
    writeFileSync(p, '{not json', 'utf8');
    const res = run({ T12_FREE_WAVE: 'true' }, p);
    expect(res.status).toBe(2);
    expect(res.stdout.trim()).toBe('NOT_CHECKED');
  });

  it('does not fetch or call vendors', () => {
    const src = readFileSync(scriptPath, 'utf8');
    expect(src).not.toContain('fetch(');
    expect(src).not.toContain('api.anthropic.com');
    expect(src).not.toContain('anthropic');
  });
});
