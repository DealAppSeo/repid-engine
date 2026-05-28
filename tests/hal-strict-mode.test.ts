/**
 * Smoke + regression tests for HAL_STRICT_MODE (CC sprint 2026-05-28).
 *
 * Covers:
 *   - strictModeOrFallback: graceful (warn + fallback) vs strict (throw).
 *   - SITE 4 end-to-end: classifier.classify() with a forced provider failure
 *     (unreachable endpoint) — graceful defaults to 'factual'; strict throws
 *     "STRICT MODE FAIL: classifier.layer0: ...".
 *
 * SITE 3 (cross-llm-client Promise.allSettled) is intentionally NOT covered —
 * deferred this sprint (another agent had uncommitted WIP in that file).
 */
import { strictModeOrFallback, isStrictMode } from '../src/hal/lib/strict-mode';
import { classify } from '../src/hal/classifier';

describe('strictModeOrFallback', () => {
  const original = process.env.HAL_STRICT_MODE;
  let warnSpy: jest.SpyInstance;
  beforeEach(() => {
    warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => {
    warnSpy.mockRestore();
    if (original === undefined) delete process.env.HAL_STRICT_MODE;
    else process.env.HAL_STRICT_MODE = original;
  });

  it('graceful (flag unset): warns and returns the fallback value', () => {
    delete process.env.HAL_STRICT_MODE;
    expect(isStrictMode()).toBe(false);
    const out = strictModeOrFallback('test.ctx', new Error('boom'), () => 42);
    expect(out).toBe(42);
    expect(warnSpy).toHaveBeenCalledWith('[graceful degradation] test.ctx: boom');
  });

  it('graceful: only "true" enables strict — other values stay graceful', () => {
    process.env.HAL_STRICT_MODE = 'false';
    expect(strictModeOrFallback('c', new Error('x'), () => 'fb')).toBe('fb');
    process.env.HAL_STRICT_MODE = '1';
    expect(strictModeOrFallback('c', new Error('x'), () => 'fb')).toBe('fb');
  });

  it('strict (flag=true): throws STRICT MODE FAIL with context + message', () => {
    process.env.HAL_STRICT_MODE = 'true';
    expect(isStrictMode()).toBe(true);
    expect(() => strictModeOrFallback('test.ctx', new Error('boom'), () => 42)).toThrow(
      'STRICT MODE FAIL: test.ctx: boom',
    );
  });

  it('strict: non-Error reasons are stringified', () => {
    process.env.HAL_STRICT_MODE = 'true';
    expect(() => strictModeOrFallback('c', 'plain-string', () => 0)).toThrow(
      'STRICT MODE FAIL: c: plain-string',
    );
  });
});

describe('SITE 4 — classifier.classify() degradation', () => {
  const original = process.env.HAL_STRICT_MODE;
  const UNREACHABLE = 'http://127.0.0.1:1/v1/chat/completions';
  let errSpy: jest.SpyInstance;
  beforeEach(() => {
    errSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    jest.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => {
    jest.restoreAllMocks();
    if (original === undefined) delete process.env.HAL_STRICT_MODE;
    else process.env.HAL_STRICT_MODE = original;
  });

  it('graceful: provider failure → defaults to factual/parse-error', async () => {
    delete process.env.HAL_STRICT_MODE;
    const r = await classify('Who wrote Hamlet?', {
      apiKey: 'dummy-key',
      endpoint: UNREACHABLE,
      timeoutMs: 300,
      persist: false,
    });
    expect(r.category).toBe('factual');
    expect(r.provider).toBe('fallback');
    expect(r.model).toBe('parse-error');
  }, 15000);

  it('strict: provider failure → throws STRICT MODE FAIL: classifier.layer0', async () => {
    process.env.HAL_STRICT_MODE = 'true';
    await expect(
      classify('Who wrote Hamlet?', {
        apiKey: 'dummy-key',
        endpoint: UNREACHABLE,
        timeoutMs: 300,
        persist: false,
      }),
    ).rejects.toThrow(/^STRICT MODE FAIL: classifier\.layer0:/);
  }, 15000);
});
