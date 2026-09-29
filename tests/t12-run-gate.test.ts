import { readFileSync } from 'node:fs';
import path from 'node:path';
import {
  T12_HEARTBEAT_SQL,
  t12RunAllowed,
} from '../src/orchestration/t12-run-gate';

const ON = { T12_FREE_WAVE: 'true' };
const CLAIMED = { claimed_at: '2099-01-01T00:00:00.000Z', claimed_by: 'trinity-veritas' };

describe('T12 run gate', () => {
  it('allows the wave only when the flag, the sql heartbeat, and a claimed task agree', () => {
    expect(
      t12RunAllowed({ env: ON, heartbeatSql: T12_HEARTBEAT_SQL, task: CLAIMED }),
    ).toEqual({
      allowed: true,
      reason: 'allowed',
      order: ['groq', 'cerebras'],
    });
    expect(t12RunAllowed({ env: { T12_FREE_WAVE: 'TRUE' }, heartbeatSql: T12_HEARTBEAT_SQL, task: CLAIMED }).reason).toBe('flag_off');
    expect(t12RunAllowed({ env: { T12_FREE_WAVE: '1' }, heartbeatSql: T12_HEARTBEAT_SQL, task: CLAIMED }).reason).toBe('flag_off');
    expect(t12RunAllowed({ env: { T12_FREE_WAVE: 'on' }, heartbeatSql: T12_HEARTBEAT_SQL, task: CLAIMED }).reason).toBe('flag_off');
    expect(t12RunAllowed({ env: {}, heartbeatSql: T12_HEARTBEAT_SQL, task: CLAIMED }).reason).toBe('flag_off');
    expect(t12RunAllowed({ env: ON, heartbeatSql: null, task: CLAIMED }).reason).toBe('heartbeat_not_sql');
    expect(
      t12RunAllowed({
        env: ON,
        heartbeatSql: 'https://api.anthropic.com/v1/messages',
        task: CLAIMED,
      }).reason,
    ).toBe('heartbeat_not_sql');
    expect(t12RunAllowed({ env: ON, heartbeatSql: T12_HEARTBEAT_SQL, task: null }).reason).toBe('task_not_claimed');
    expect(
      t12RunAllowed({
        env: ON,
        heartbeatSql: T12_HEARTBEAT_SQL,
        task: { claimed_at: null, claimed_by: '' },
      }).reason,
    ).toBe('task_not_claimed');
    expect(
      t12RunAllowed({
        env: ON,
        heartbeatSql: T12_HEARTBEAT_SQL,
        task: { claimed_by: 'trinity-veritas' },
      }).allowed,
    ).toBe(true);
  });

  it('keeps the gate local', () => {
    const src = readFileSync(
      path.join(__dirname, '..', 'src', 'orchestration', 't12-run-gate.ts'),
      'utf8',
    );
    expect(T12_HEARTBEAT_SQL).toBe(
      'select max(last_seen) as last_heartbeat_at from trinity_heartbeat',
    );
    expect(src).toContain('trinity_heartbeat');
    expect(src).toContain('claimed_at');
    expect(src).not.toContain('fetch(');
    expect(src).not.toContain('process.env');
    expect(src).not.toContain('api.anthropic.com');
    expect(src).not.toContain('anthropic');
    expect(src).not.toContain('supabase');
    expect(src).not.toContain('.insert(');
    expect(t12RunAllowed({ env: ON, heartbeatSql: T12_HEARTBEAT_SQL, task: CLAIMED }).order.join(' ')).not.toMatch(/anthropic/i);
  });
});
