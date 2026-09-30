import { readFileSync } from 'node:fs';
import path from 'node:path';
import { T12_HEARTBEAT_INSERT_SQL, writeT12Heartbeat } from '../src/orchestration/t12-heartbeat-write';

describe('T12 heartbeat one SQL row', () => {
  it('calls exec once only when the flag is the exact string true', () => {
    for (const value of [undefined, '', 'TRUE', '1'] as const) {
      const calls: string[] = [];
      const env = value === undefined ? {} : { T12_FREE_WAVE: value };
      expect(writeT12Heartbeat(env, (sql) => calls.push(sql))).toEqual({ written: 0, order: [] });
      expect(calls).toHaveLength(0);
    }

    const calls: string[] = [];
    const on = writeT12Heartbeat({ T12_FREE_WAVE: 'true' }, (sql) => calls.push(sql));
    expect(on.written).toBe(1);
    expect(calls).toEqual([T12_HEARTBEAT_INSERT_SQL]);
    expect(calls).toHaveLength(1);
    expect(T12_HEARTBEAT_INSERT_SQL.match(/insert into/gi)).toHaveLength(1);
    expect(on.order).toEqual(['groq', 'cerebras']);

    const src = readFileSync(
      path.join(__dirname, '..', 'src', 'orchestration', 't12-heartbeat-write.ts'),
      'utf8',
    );
    expect(src).not.toContain('anthropic');
    expect(src).not.toContain('api.anthropic.com');
    expect(src).not.toContain('fetch(');
  });
});
