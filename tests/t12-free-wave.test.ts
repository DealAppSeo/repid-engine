import { readFileSync } from 'node:fs';
import path from 'node:path';
import { t12TaskClaimed } from '../src/orchestration/t12-run-gate';
import {
  t12FreeWaveEnabled,
  t12FreeWaveOrder,
  t12LocalBase,
  t12OneTask,
  t12Wave,
  t12ResultFromCheck,
} from '../src/orchestration/t12-free-wave';

describe('T12 free wave', () => {
  it('is off unless the variable is the exact string true, and never selects anthropic', () => {
    expect(t12FreeWaveEnabled({})).toBe(false);
    expect(t12FreeWaveOrder({})).toEqual([]);
    expect(t12FreeWaveEnabled({ T12_FREE_WAVE: 'TRUE' })).toBe(false);
    expect(t12FreeWaveEnabled({ T12_FREE_WAVE: '1' })).toBe(false);
    expect(t12FreeWaveEnabled({ T12_FREE_WAVE: 'on' })).toBe(false);
    expect(t12FreeWaveOrder({ T12_FREE_WAVE: 'true' })).toEqual(['groq', 'cerebras']);
    expect(t12FreeWaveOrder({ T12_FREE_WAVE: 'true' }).join(' ')).not.toMatch(/anthropic/i);
  });

  it('keeps heartbeat on SQL and points the belt at trustshell status', () => {
    const doc = readFileSync(path.join(__dirname, '..', 'docs', 'T12_BELT.md'), 'utf8');
    const src = readFileSync(path.join(__dirname, '..', 'src', 'orchestration', 't12-free-wave.ts'), 'utf8');
    expect(doc).toContain('trustshell status');
    expect(doc.toLowerCase()).toContain('sql');
    expect(doc.toLowerCase()).not.toContain('api.anthropic.com');
    expect(src).not.toContain('fetch(');
    expect(src).not.toContain('api.anthropic.com');
    expect(src).toContain("raw === 'true'");
    expect(src).toContain('trustshell status');
    expect(src).toContain('scripts/sim-hal-traps.mjs');
    expect(src).not.toContain('REAL_STAKING_ENABLED');
    expect(src).not.toMatch(/process\.env\.T12_FREE_WAVE\s*=/);
    expect(src).not.toContain('insert into trinity_heartbeat');
  });

  it('maps a miss and the number 0 to NOT_CHECKED', () => {
    expect(t12ResultFromCheck(0)).toBe('NOT_CHECKED');
    expect(t12ResultFromCheck('0')).toBe('NOT_CHECKED');
    expect(t12ResultFromCheck(undefined)).toBe('NOT_CHECKED');
    expect(t12ResultFromCheck('pass')).toBe('pass');
    expect(t12ResultFromCheck('fail')).toBe('fail');
    expect(t12ResultFromCheck('NOT_CHECKED')).toBe('NOT_CHECKED');
    expect(t12ResultFromCheck(0)).not.toBe(0);
  });

  it('claims one local fixture when the queue is empty, runs, and writes pass', () => {
    const out = t12OneTask({
      env: { T12_FREE_WAVE: 'true' },
      queue: [],
      now: '2026-10-02T00:00:00.000Z',
    });
    expect(out.claimed).toBe(true);
    expect(out.ran).toBe(true);
    expect(out.order).toEqual(['groq', 'cerebras']);
    expect(out.order.join(' ')).not.toMatch(/anthropic/i);
    expect(out.row?.id).toBe('t12-local-fixture');
    expect(out.row?.claimed_at).toBe('2026-10-02T00:00:00.000Z');
    expect(out.row?.claimed_by).toBe('t12-free-wave');
    expect(t12TaskClaimed(out.row)).toBe(true);
    expect(out.row?.result).toBe('pass');
    expect(out.row?.result).not.toBe(0);
  });

  it('claims the first queue row only and writes the check result', () => {
    const queue = [{ id: 'row-a' }, { id: 'row-b' }];
    const out = t12OneTask({
      env: { T12_FREE_WAVE: 'true' },
      queue,
      now: 'claimed-at',
      check: () => 'fail',
    });
    expect(out.row).toBe(queue[0]);
    expect(queue[0].result).toBe('fail');
    expect(queue[0].claimed_by).toBe('t12-free-wave');
    expect(queue[1].claimed_by).toBeUndefined();
    expect(queue[1].result).toBeUndefined();
  });

  it('writes NOT_CHECKED when the check misses, including 0', () => {
    const missed = t12OneTask({
      env: { T12_FREE_WAVE: 'true' },
      queue: [{ id: 'miss' }],
      now: 't',
      check: () => 0,
    });
    expect(missed.row?.result).toBe('NOT_CHECKED');
    expect(missed.row?.result).not.toBe(0);
    const thrown = t12OneTask({
      env: { T12_FREE_WAVE: 'true' },
      queue: [{ id: 'boom' }],
      now: 't',
      check: () => {
        throw new Error('miss');
      },
    });
    expect(thrown.row?.result).toBe('NOT_CHECKED');
    expect(thrown.row?.result).not.toBe('0');
  });

  it('does not claim or run unless the flag is the exact string true', () => {
    let calls = 0;
    const check = () => {
      calls += 1;
      return 'pass' as const;
    };
    const row = { id: 'untouched' };
    for (const raw of [undefined, 'TRUE', '1', 'on', 'false']) {
      const out = t12OneTask({ env: { T12_FREE_WAVE: raw }, queue: [row], check });
      expect(out.claimed).toBe(false);
      expect(out.ran).toBe(false);
      expect(out.order).toEqual([]);
      expect(out.row).toBeNull();
    }
    expect(calls).toBe(0);
    expect(row).toEqual({ id: 'untouched' });
  });
});

describe('T12 local first, then groq, then cerebras, stop on 429', () => {
  const ON = { T12_FREE_WAVE: 'true', LOCAL_LLM_BASE_URL: 'http://127.0.0.1:11434/v1' };
  const statuses = (map: Record<string, number | 'throw'>) => {
    const calls: string[] = [];
    const attempt = async (host: string) => {
      calls.push(host);
      const s = map[host];
      if (s === 'throw' || s === undefined) throw new Error('down');
      return { status: s };
    };
    return { calls, attempt };
  };

  it('local joins first only for a loopback base; a remote base is never local', () => {
    expect(t12FreeWaveOrder(ON)).toEqual(['local', 'groq', 'cerebras']);
    for (const base of ['https://api.groq.com/openai/v1', 'http://10.0.0.5:8080', 'http://user:pw@127.0.0.1:1', 'ftp://127.0.0.1', 'nonsense']) {
      expect(t12LocalBase({ LOCAL_LLM_BASE_URL: base })).toBeNull();
      expect(t12FreeWaveOrder({ T12_FREE_WAVE: 'true', LOCAL_LLM_BASE_URL: base })).toEqual(['groq', 'cerebras']);
    }
    expect(t12FreeWaveOrder({ LOCAL_LLM_BASE_URL: 'http://localhost:1' })).toEqual([]);
  });

  it('off is NOT_CHECKED and calls nothing', async () => {
    const { calls, attempt } = statuses({ local: 200 });
    expect(await t12Wave({ env: { LOCAL_LLM_BASE_URL: 'http://localhost:1' }, attempt })).toEqual({ outcome: 'NOT_CHECKED', host: null, tried: [] });
    expect(calls).toEqual([]);
  });

  it('local answers first, and the cloud is never called', async () => {
    const { calls, attempt } = statuses({ local: 200, groq: 200 });
    expect(await t12Wave({ env: ON, attempt })).toEqual({ outcome: 'answered', host: 'local', tried: ['local'] });
    expect(calls).toEqual(['local']);
  });

  it('local down falls through to groq', async () => {
    const { calls, attempt } = statuses({ local: 'throw', groq: 200 });
    expect((await t12Wave({ env: ON, attempt })).host).toBe('groq');
    expect(calls).toEqual(['local', 'groq']);
  });

  it('a 429 stops the wave: cerebras is not tried after groq is rate-limited', async () => {
    const { calls, attempt } = statuses({ local: 'throw', groq: 429, cerebras: 200 });
    expect(await t12Wave({ env: ON, attempt })).toEqual({ outcome: 'rate_limited', host: 'groq', tried: ['local', 'groq'] });
    expect(calls).toEqual(['local', 'groq']);
  });

  it('a 429 on local stops before any cloud host', async () => {
    const { calls, attempt } = statuses({ local: 429, groq: 200 });
    expect((await t12Wave({ env: ON, attempt })).outcome).toBe('rate_limited');
    expect(calls).toEqual(['local']);
  });

  it('a non-429 failure moves on; every host failing is NOT_CHECKED, never a pass', async () => {
    const { calls, attempt } = statuses({ local: 500, groq: 503, cerebras: 'throw' });
    expect(await t12Wave({ env: ON, attempt })).toEqual({ outcome: 'NOT_CHECKED', host: null, tried: ['local', 'groq', 'cerebras'] });
    expect(calls).toEqual(['local', 'groq', 'cerebras']);
  });
});
