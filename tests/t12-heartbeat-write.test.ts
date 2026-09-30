import { readFileSync } from 'node:fs';
import path from 'node:path';
import { T12_HEARTBEAT_INSERT_SQL, writeT12Heartbeat } from '../src/orchestration/t12-heartbeat-write';

describe('writeT12Heartbeat', () => {
  it('writes one SQL row only when the free-wave flag is the exact string true', () => {
    for (const raw of [undefined, '', 'TRUE', '1', 'on'] as const) {
      const calls: string[] = [];
      const env = raw === undefined ? {} : { T12_FREE_WAVE: raw };
      expect(writeT12Heartbeat(env, (sql) => calls.push(sql))).toEqual({ written: 0, order: [] });
      expect(calls).toEqual([]);
    }

    const calls: string[] = [];
    expect(writeT12Heartbeat({ T12_FREE_WAVE: 'true' }, (sql) => calls.push(sql))).toEqual({
      written: 1,
      order: ['groq', 'cerebras'],
    });
    expect(calls).toEqual([T12_HEARTBEAT_INSERT_SQL]);

    const src = readFileSync(
      path.join(__dirname, '..', 'src', 'orchestration', 't12-heartbeat-write.ts'),
      'utf8',
    );
    expect(src).not.toContain('fetch(');
    expect(src).not.toContain('api.anthropic.com');
    expect(src).not.toContain('anthropic');
    expect(src).not.toContain('process.env');
  });
});
