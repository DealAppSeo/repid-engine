import { readFileSync } from 'node:fs';
import path from 'node:path';
import { probeT12Heartbeat, T12_HEARTBEAT_SQL } from '../src/orchestration/t12-heartbeat-probe';
import { t12FreeWaveEnabled } from '../src/orchestration/t12-free-wave';

describe('T12 heartbeat probe', () => {
  it('returns a timestamp when one is injected and NOT_CHECKED otherwise', () => {
    expect(probeT12Heartbeat([{ last_heartbeat_at: '2099-01-01T00:00:00.000Z' }])).toEqual({
      status: 'counted',
      last_heartbeat_at: '2099-01-01T00:00:00.000Z',
    });
    expect(probeT12Heartbeat(null)).toEqual({ status: 'NOT_CHECKED', last_heartbeat_at: null });
    expect(probeT12Heartbeat(undefined)).toEqual({ status: 'NOT_CHECKED', last_heartbeat_at: null });
    expect(probeT12Heartbeat([])).toEqual({ status: 'NOT_CHECKED', last_heartbeat_at: null });
    expect(probeT12Heartbeat([{ last_heartbeat_at: null }])).toEqual({
      status: 'NOT_CHECKED',
      last_heartbeat_at: null,
    });
    expect(probeT12Heartbeat([{ last_heartbeat_at: '' }])).toEqual({
      status: 'NOT_CHECKED',
      last_heartbeat_at: null,
    });
    expect(probeT12Heartbeat([{ last_heartbeat_at: 0 as unknown as string }])).toEqual({
      status: 'NOT_CHECKED',
      last_heartbeat_at: null,
    });
  });

  it('keeps the probe as SQL text and does not call a host', () => {
    const src = readFileSync(
      path.join(__dirname, '..', 'src', 'orchestration', 't12-heartbeat-probe.ts'),
      'utf8',
    );
    expect(T12_HEARTBEAT_SQL).toBe(
      'select max(last_seen) as last_heartbeat_at from trinity_heartbeat',
    );
    expect(src).toContain('trinity_heartbeat');
    expect(src).not.toContain('fetch(');
    expect(src).not.toContain('api.anthropic.com');
    expect(src).not.toContain('anthropic');
    expect(src).not.toContain('process.env');
  });

  it('treats the free-wave flag as on only for the exact string true passed in', () => {
    expect(t12FreeWaveEnabled({ T12_FREE_WAVE: 'true' })).toBe(true);
    expect(t12FreeWaveEnabled({ T12_FREE_WAVE: 'TRUE' })).toBe(false);
    expect(t12FreeWaveEnabled({ T12_FREE_WAVE: '1' })).toBe(false);
    expect(t12FreeWaveEnabled({ T12_FREE_WAVE: 'on' })).toBe(false);
  });
});
