/**
 * Unit tests for the Supabase write-churn throttling logic (2026-07-02).
 *
 * Covers the two pure decision functions that gate DB writes:
 *   - shouldPersistVersion  (versioning middleware → api_key_versions)
 *   - shouldLogEvent        (logAgentEvent → trinity_agent_logs sampling/level gate)
 *
 * These are pure (clock + roll injected) so they run without a DB or network.
 */

// versioning.ts and agent-log.ts import ../db → config.ts, which throws without SUPABASE_URL.
// Mock db so the pure decision functions can be imported without real Supabase credentials.
jest.mock('../src/db', () => ({
  db: { from: () => ({ insert: () => Promise.resolve({ data: null, error: null }), upsert: () => Promise.resolve({ data: null, error: null }) }), rpc: () => Promise.resolve({ error: null }) },
}));

import { shouldPersistVersion } from '../src/middleware/versioning';
import { shouldLogEvent, type AgentLogLevel } from '../src/engine/agent-log';

describe('shouldPersistVersion (api_key_versions write-once cache)', () => {
  type Cache = Map<string, { version: string; writtenAt: number }>;
  const mk = (): Cache => new Map();

  it('writes on first sight of a key (cache miss)', () => {
    expect(shouldPersistVersion(mk(), 'k1', '2026-04-17', 1000, 0)).toBe(true);
  });

  it('SKIPS an unchanged key/version with no TTL (the churn fix)', () => {
    const c: Cache = mk();
    c.set('k1', { version: '2026-04-17', writtenAt: 1000 });
    // Same key, same version, later time, ttl=0 → must NOT write again.
    expect(shouldPersistVersion(c, 'k1', '2026-04-17', 999_999, 0)).toBe(false);
  });

  it('re-writes when the caller switches to a different version', () => {
    const c: Cache = mk();
    c.set('k1', { version: '2026-04-17', writtenAt: 1000 });
    expect(shouldPersistVersion(c, 'k1', '2026-09-01', 2000, 0)).toBe(true);
  });

  it('re-writes once the TTL has elapsed even if unchanged', () => {
    const c: Cache = mk();
    c.set('k1', { version: 'v', writtenAt: 1000 });
    // ttl = 5000ms; at t=5000 (>= ttl) it should refresh, at t=4000 it should not.
    expect(shouldPersistVersion(c, 'k1', 'v', 4000, 5000)).toBe(false);
    expect(shouldPersistVersion(c, 'k1', 'v', 6000, 5000)).toBe(true);
  });

  it('treats distinct keys independently', () => {
    const c: Cache = mk();
    c.set('k1', { version: 'v', writtenAt: 1000 });
    expect(shouldPersistVersion(c, 'k2', 'v', 1000, 0)).toBe(true); // k2 never seen
  });

  it('projected reduction: N requests for a stable key ⇒ exactly 1 write', () => {
    const c: Cache = mk();
    let writes = 0;
    for (let i = 0; i < 1000; i++) {
      if (shouldPersistVersion(c, 'stable-key', '2026-04-17', i, 0)) {
        writes++;
        c.set('stable-key', { version: '2026-04-17', writtenAt: i });
      }
    }
    expect(writes).toBe(1); // 1000 requests → 1 DB write (was 1000 upserts before the fix)
  });
});

describe('shouldLogEvent (trinity_agent_logs level + sampling gate)', () => {
  const lvl = (l: string) => l as AgentLogLevel;

  it('defaults (min=info, sample=1) keep every info/warn/error event', () => {
    expect(shouldLogEvent(lvl('info'), lvl('info'), 1, 0.999999)).toBe(true);
    expect(shouldLogEvent(lvl('warn'), lvl('info'), 1, 0.999999)).toBe(true);
    expect(shouldLogEvent(lvl('error'), lvl('info'), 1, 0.999999)).toBe(true);
  });

  it('drops events below the configured min-level', () => {
    expect(shouldLogEvent(lvl('debug'), lvl('info'), 1, 0)).toBe(false);
    expect(shouldLogEvent(lvl('info'), lvl('warn'), 1, 0)).toBe(false);
  });

  it('samples info events by the roll vs sampleRate', () => {
    // sampleRate 0.05 → keep only when roll < 0.05
    expect(shouldLogEvent(lvl('info'), lvl('info'), 0.05, 0.04)).toBe(true);
    expect(shouldLogEvent(lvl('info'), lvl('info'), 0.05, 0.06)).toBe(false);
  });

  it('NEVER sample-drops warn/error even at sampleRate 0', () => {
    expect(shouldLogEvent(lvl('warn'), lvl('info'), 0, 0.999999)).toBe(true);
    expect(shouldLogEvent(lvl('error'), lvl('info'), 0, 0.999999)).toBe(true);
  });

  it('sampleRate 0 with info level ⇒ all routine events dropped', () => {
    let kept = 0;
    for (let i = 0; i < 1000; i++) {
      if (shouldLogEvent(lvl('info'), lvl('info'), 0, i / 1000)) kept++;
    }
    expect(kept).toBe(0);
  });

  it('projected reduction: sampleRate 0.02 keeps ~2% of a large info stream', () => {
    let kept = 0;
    const N = 10000;
    for (let i = 0; i < N; i++) {
      // deterministic uniform roll in [0,1)
      if (shouldLogEvent(lvl('info'), lvl('info'), 0.02, i / N)) kept++;
    }
    // exactly floor(N * 0.02) with a uniform sweep
    expect(kept).toBe(200);
  });
});
