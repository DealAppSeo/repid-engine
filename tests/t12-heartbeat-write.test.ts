import { readFileSync } from 'node:fs';
import path from 'node:path';
import { T12_HEARTBEAT_INSERT_SQL, writeT12Heartbeat } from '../src/orchestration/t12-heartbeat-write';

describe('T12 heartbeat write', () => {
  it('writes one SQL row only when the flag is the exact string true', () => {
    const calls: string[] = [];
    const exec = (sql: string) => {
      calls.push(sql);
    };
    for (const value of [undefined, 'TRUE', '1', 'on', '']) {
      const env = value === undefined ? {} : { T12_FREE_WAVE: value };
      expect(writeT12Heartbeat(env, exec)).toEqual({ written: 0, order: [] });
    }
    expect(calls).toEqual([]);
    const on = writeT12Heartbeat({ T12_FREE_WAVE: 'true' }, exec);
    expect(on.written).toBe(1);
    expect(calls).toEqual([T12_HEARTBEAT_INSERT_SQL]);
    expect(on.order).toEqual(['groq', 'cerebras']);
    expect(on.order.join(' ')).not.toMatch(/anthropic/i);
  });

  it('keeps the provider list off that host', () => {
    const src = readFileSync(
      path.join(__dirname, '..', 'src', 'orchestration', 't12-heartbeat-write.ts'),
      'utf8',
    );
    expect(src).not.toContain('api.anthropic.com');
    expect(src).not.toContain('anthropic');
    expect(src).not.toContain('fetch(');
    expect(T12_HEARTBEAT_INSERT_SQL.startsWith('insert into trinity_heartbeat')).toBe(true);
  });
});