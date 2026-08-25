/**
 * dispatch-sanitize-handoff.test.ts — pins the handoff sanitiser.
 *
 * On 2026-08-22 the daemon dispatched 8 XC phases, logged each COMPLETE, and persisted
 * none: grok's handoff_body carried a byte a Postgres `text` column rejects, the
 * `.update()` errored, and the error was unchecked. sanitizeHandoff() strips those
 * bytes so the write cannot fail on them; the daemon separately now checks the error so
 * any remaining failure is loud, not silent. This test guards the sanitiser half.
 *
 * require() the CommonJS lib so this runs on Windows too (importing the ESM daemon by
 * absolute path throws ERR_UNSUPPORTED_ESM_URL_SCHEME there).
 */
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { sanitizeHandoff } = require('../scripts/dispatch/sprint-lib');

const NUL = String.fromCharCode(0);
const BEL = String.fromCharCode(7);
const ESC = String.fromCharCode(27);

describe('sanitizeHandoff', () => {
  it('removes the NUL byte Postgres text cannot store', () => {
    const out = sanitizeHandoff(`before${NUL}after`);
    expect(out).toBe('beforeafter');
    expect(out.includes(NUL)).toBe(false);
  });

  it('removes C0 control bytes from CLI/ANSI capture (BEL, ESC, etc.)', () => {
    expect(sanitizeHandoff(`a${BEL}b${ESC}c`)).toBe('abc');
  });

  it('KEEPS tab, newline and carriage return — legitimate in a handoff block', () => {
    const s = 'STATUS: COMPLETE\n\tNEXT_PHASE_READY: 2\r\n';
    expect(sanitizeHandoff(s)).toBe(s);
  });

  it('leaves ordinary text and unicode untouched', () => {
    const s = 'REQUIREMENTS_ON_GA:\n- w_i source — VaR vs settlement · $990k swing ✓';
    expect(sanitizeHandoff(s)).toBe(s);
  });

  it('passes null/undefined through without throwing', () => {
    expect(sanitizeHandoff(null)).toBeNull();
    expect(sanitizeHandoff(undefined)).toBeUndefined();
  });

  it('is idempotent — sanitising a clean string changes nothing', () => {
    const once = sanitizeHandoff(`x${NUL}y${BEL}z`);
    expect(sanitizeHandoff(once)).toBe(once);
  });

  it('would have saved the real failure: a body with an embedded NUL now writes clean', () => {
    const grokish = `=== HANDOFF XC S2 ===${NUL}\nSTATUS: COMPLETE\nNEXT_PHASE_READY: 3\n=== END HANDOFF ===`;
    const clean = sanitizeHandoff(grokish);
    expect(clean.includes(NUL)).toBe(false);
    expect(clean).toContain('STATUS: COMPLETE');
    expect(clean).toContain('NEXT_PHASE_READY: 3');
  });
});
