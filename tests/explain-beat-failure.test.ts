/**
 * explain-beat-failure.test.ts — the disclosure gate cannot open by accident.
 *
 * The script under test (`scripts/ci/explain-beat-failure.cjs`) runs ONLY on a
 * failure path, in a workflow that fires six times a day unattended. If it were
 * wrong, nobody would find out until the next outage — which is exactly when it
 * is needed. So its branches are exercised here rather than in production.
 *
 * Two of these assertions are security assertions, not correctness ones: that a
 * beat which reached turn 2+ prints nothing of its transcript, and that a
 * credential-shaped token never survives into the emitted lines. This repo is
 * PUBLIC and a GitHub Actions log is world-readable and permanent.
 */

const mod = require('../scripts/ci/explain-beat-failure.cjs') as {
  explain: (raw: string) => { verdict: string; lines: string[] };
  redact: (value: string) => string;
  parseMessages: (raw: string) => Record<string, unknown>[];
  findResult: (messages: Record<string, unknown>[]) => Record<string, unknown> | null;
  findInitModel: (messages: Record<string, unknown>[]) => string | null;
  flatten: (value: unknown, prefix: string, depth: number, out: string[]) => string[];
  GATE_MAX_TURNS: number;
  MAX_STRING: number;
};

const INIT = '{"type":"system","subtype":"init","message":"Claude Code initialized","model":"claude-sonnet-4-6"}';

/** The real result object from run 35625411648 (2026-09-21T16:25:05Z). */
const DEAD_RESULT =
  '{"type":"result","subtype":"success","is_error":true,"duration_ms":239,' +
  '"num_turns":1,"total_cost_usd":0,"permission_denials_count":0,"modelUsage":{}}';

/** The real result object from run 35599984032 (2026-09-21T12:34:57Z) — turn cap. */
const CAPPED_RESULT =
  '{"type":"result","subtype":"success","is_error":true,"duration_ms":213056,' +
  '"num_turns":36,"total_cost_usd":1.1403486499999997,"modelUsage":' +
  '{"claude-haiku-4-5-20251001":{"contextWindow":200000}}}';

describe('the num_turns disclosure gate', () => {
  it('emits for the measured 1-turn death (run 35625411648)', () => {
    const { verdict, lines } = mod.explain(`${INIT}\n${DEAD_RESULT}`);
    expect(verdict).toBe('DIAGNOSTIC EMITTED');
    const text = lines.join('\n');
    expect(text).toContain('BEAT DIED BEFORE TURN 2');
    expect(text).toContain('claude-sonnet-4-6');
    expect(text).toContain('num_turns');
  });

  it('WITHHOLDS for the measured 36-turn death (run 35599984032)', () => {
    const { verdict, lines } = mod.explain(`[${INIT},${CAPPED_RESULT}]`);
    expect(verdict).toBe('WITHHELD');
    expect(lines.join('\n')).toContain('reached turn 36');
  });

  it('the withheld notice does not claim the job failed — it also runs on green beats', () => {
    const green = '{"type":"result","subtype":"success","is_error":false,"num_turns":22}';
    const text = mod.explain(`${INIT}\n${green}`).lines.join('\n');
    expect(text).not.toContain('This job failed');
    expect(text).toContain('green or red');
  });

  it('SECURITY: above the gate, no transcript content is printed', () => {
    const secretish =
      '{"type":"assistant","message":{"content":"the DB row said CONFIDENTIAL_PAYLOAD_XYZ"}}';
    const { verdict, lines } = mod.explain(`${INIT}\n${secretish}\n${CAPPED_RESULT}`);
    expect(verdict).toBe('WITHHELD');
    expect(lines.join('\n')).not.toContain('CONFIDENTIAL_PAYLOAD_XYZ');
  });

  it('the gate is exactly 1 — raising it is a disclosure decision, so pin it', () => {
    expect(mod.GATE_MAX_TURNS).toBe(1);
  });

  it('withholds at the first turn above the gate, not merely at large values', () => {
    const twoTurns = '{"type":"result","subtype":"success","is_error":true,"num_turns":2}';
    expect(mod.explain(`${INIT}\n${twoTurns}`).verdict).toBe('WITHHELD');
  });
});

describe('surfacing the cause', () => {
  it('prints a non-result error message, which is where the refusal is named', () => {
    const err =
      '{"type":"error","subtype":"api_error","error":{"status":400,' +
      '"message":"Your credit balance is too low to access the Anthropic API."}}';
    const { verdict, lines } = mod.explain(`${INIT}\n${err}\n${DEAD_RESULT}`);
    expect(verdict).toBe('DIAGNOSTIC EMITTED');
    const text = lines.join('\n');
    expect(text).toContain('credit balance is too low');
    expect(text).toContain('400');
  });

  it('says plainly that a 1-turn $0 result is not a turn-budget death', () => {
    const text = mod.explain(`${INIT}\n${DEAD_RESULT}`).lines.join('\n');
    expect(text).toContain('NOT a turn-budget death');
  });
});

describe('redact', () => {
  // Every value here is a fabricated shape, never a real credential.
  const cases: [string, string][] = [
    ['sk-ant-api03-FAKEfake1234567890abcdefGHIJ', 'anthropic-key'],
    ['sb_secret_FAKEfake1234567890abcdef', 'supabase-key'],
    ['ghp_FAKEfake1234567890abcdefghijklmnop', 'github-token'],
    ['github_pat_FAKEfake1234567890abcdefghij', 'github-pat'],
    ['xai-FAKEfake1234567890abcdef', 'xai-key'],
    ['gsk_FAKEfake1234567890abcdef', 'groq-key'],
    ['AKIAFAKEFAKEFAKEFAKE', 'aws-akid'],
    [`0x${'a'.repeat(64)}`, 'hex-64'],
  ];

  it.each(cases)('redacts %s', (value) => {
    const out = mod.redact(`prefix ${value} suffix`);
    expect(out).not.toContain(value);
    expect(out).toContain('[REDACTED:');
    expect(out).toContain('prefix');
  });

  it('redacts a JWT-shaped token', () => {
    // ASSEMBLED AT RUNTIME, and that is the point: a JWT-shaped LITERAL in source
    // trips gitleaks (this one measured entropy 4.85) and, through it, the
    // resident-secrets ratchet. Both documented escape hatches are worse than the
    // problem: a .gitleaksignore fingerprint embeds a commit SHA and a line number,
    // which scripts/ci/resident-secret-gate.js's own header rejects because such
    // baselines "decay into noise that gets bulk-regenerated — which silently
    // re-admits real findings"; and a BASELINE row would grow a list the same header
    // says may only shrink. Neither is worth spending on a FABRICATED value.
    //
    // tests/public-error-disclosure.test.ts does keep a literal JWT and passes, but
    // only because its signature segment ('abcdefghij') falls under gitleaks' entropy
    // threshold. That is a number nobody here controls, so it is not a convention to
    // copy. Keeping the shape out of the file entirely costs nothing and cannot rot.
    const seg = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
    const jwt = `${seg({ alg: 'HS256' })}.${seg({ sub: 'FABRICATED-NOT-A-CREDENTIAL' })}.notASignature`;
    expect(mod.redact(jwt)).not.toContain(jwt);
    expect(mod.redact(jwt)).toContain('[REDACTED:jwt]');
  });

  it('catches an unknown vendor format by entropy, not by name', () => {
    const unknown = `zz-newvendor-${'A1b2C3d4'.repeat(6)}`;
    expect(mod.redact(unknown)).toContain('[REDACTED:');
  });

  it('leaves ordinary prose and short identifiers alone', () => {
    const prose = 'API Error: 401 authentication_error invalid x-api-key';
    expect(mod.redact(prose)).toBe(prose);
    expect(mod.redact('claude-sonnet-4-6')).toBe('claude-sonnet-4-6');
    expect(mod.redact('d80a76cd-ef50-49c8-b35d-484494d597bf')).toBe(
      'd80a76cd-ef50-49c8-b35d-484494d597bf',
    );
  });

  it('caps a long string rather than flooding the log', () => {
    const out = mod.redact('x '.repeat(4000));
    expect(out.length).toBeLessThan(mod.MAX_STRING + 120);
    expect(out).toContain('truncated');
  });

  it('SECURITY: a planted credential never survives into emitted lines', () => {
    const planted =
      '{"type":"result","subtype":"error","is_error":true,"num_turns":1,' +
      '"result":"auth failed for sk-ant-api03-FAKEfake1234567890abcdefGHIJ"}';
    const text = mod.explain(`${INIT}\n${planted}`).lines.join('\n');
    expect(text).not.toContain('sk-ant-api03-FAKEfake1234567890abcdefGHIJ');
    expect(text).toContain('[REDACTED:anthropic-key]');
  });
});

describe('parseMessages accepts both shapes the action has used', () => {
  it('parses JSON-lines', () => {
    expect(mod.parseMessages(`${INIT}\n${DEAD_RESULT}`)).toHaveLength(2);
  });

  it('parses a JSON array', () => {
    expect(mod.parseMessages(`[${INIT},${DEAD_RESULT}]`)).toHaveLength(2);
  });

  it('parses concatenated objects with no separator', () => {
    expect(mod.parseMessages(`${INIT}${DEAD_RESULT}`)).toHaveLength(2);
  });

  it('is not fooled by braces inside strings', () => {
    const tricky = '{"type":"result","num_turns":1,"result":"a } brace { in prose"}';
    const parsed = mod.parseMessages(tricky);
    expect(parsed).toHaveLength(1);
    expect(parsed[0]?.['result']).toBe('a } brace { in prose');
  });
});

describe('NOT CHECKED is never silently a pass', () => {
  it('empty input', () => {
    expect(mod.explain('').verdict).toBe('NOT CHECKED');
  });

  it('no result message', () => {
    const { verdict, lines } = mod.explain(INIT);
    expect(verdict).toBe('NOT CHECKED');
    expect(lines.join('\n')).toContain('none had type "result"');
  });

  it('a result with no numeric num_turns withholds rather than guessing', () => {
    const noTurns = '{"type":"result","subtype":"success","is_error":true}';
    const { verdict, lines } = mod.explain(`${INIT}\n${noTurns}`);
    expect(verdict).toBe('NOT CHECKED');
    expect(lines.join('\n')).toContain('gate cannot be evaluated');
  });

  it('garbage input does not throw', () => {
    expect(() => mod.explain('not json at all')).not.toThrow();
    expect(mod.explain('not json at all').verdict).toBe('NOT CHECKED');
  });
});

describe('flatten bounds its own output', () => {
  it('stops at the depth limit instead of recursing forever', () => {
    const deep = { a: { b: { c: { d: { e: 'too far' } } } } };
    expect(mod.flatten(deep, '', 0, []).join('\n')).toContain('[depth limit]');
  });

  it('survives a self-referential object', () => {
    const cyclic: Record<string, unknown> = { name: 'loop' };
    cyclic['self'] = cyclic;
    expect(() => mod.flatten(cyclic, '', 0, [])).not.toThrow();
  });

  it('caps array breadth', () => {
    const out = mod.flatten({ items: Array.from({ length: 50 }, (_, i) => `v${i}`) }, '', 0, []);
    expect(out.join('\n')).toContain('more element(s)');
    expect(out.length).toBeLessThan(20);
  });
});
