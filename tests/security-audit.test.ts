/**
 * Unit coverage for the deterministic security auditor (A2A demo-trio use case #3).
 * Tests the pure analyzer in isolation (no db/LLM) — the handler just wraps it.
 */
import { auditArtifact, RULES } from '../src/services/security-audit';

describe('auditArtifact — deterministic security/safety checks', () => {
  it('clean code produces zero findings and risk_level none', () => {
    const r = auditArtifact("const x = 2 + 2;\nfunction add(a, b) { return a + b; }\n");
    expect(r.finding_count).toBe(0);
    expect(r.risk_level).toBe('none');
    expect(r.lines_scanned).toBeGreaterThan(0);
  });

  it('flags a hardcoded private key as critical (with the right line)', () => {
    const src = "const ok = 1;\nconst key = `-----BEGIN RSA PRIVATE KEY-----`;\n";
    const r = auditArtifact(src);
    const f = r.findings.find((x) => x.rule === 'hardcoded-private-key');
    expect(f).toBeDefined();
    expect(f!.severity).toBe('critical');
    expect(f!.line).toBe(2);
    expect(r.risk_level).toBe('critical');
  });

  it('flags a hardcoded API key (sk-…) as critical', () => {
    const r = auditArtifact('const c = "sk-abcdef0123456789ABCDEF";'); // gitleaks:allow — fake fixture for the auditor
    expect(r.findings.some((x) => x.rule === 'hardcoded-api-key' && x.severity === 'critical')).toBe(true);
  });

  it('flags string-interpolated SQL as a high injection risk', () => {
    const r = auditArtifact('const q = `SELECT * FROM users WHERE id = ${userId}`;');
    expect(r.findings.some((x) => x.rule === 'sql-injection' && x.severity === 'high')).toBe(true);
  });

  it('flags exec/eval sinks, insecure RNG, weak crypto, disabled auth, and SSN', () => {
    const src = [
      'child_process.execSync(cmd);',
      'const t = Math.random();',
      "crypto.createHash('md5').update(pw);",
      '// TODO: auth — skip for now',
      'const ssn = "123-45-6789";',
    ].join('\n');
    const r = auditArtifact(src);
    const ids = new Set(r.findings.map((f) => f.rule));
    expect(ids.has('code-exec-sink')).toBe(true);
    expect(ids.has('insecure-random')).toBe(true);
    expect(ids.has('weak-crypto')).toBe(true);
    expect(ids.has('auth-disabled')).toBe(true);
    expect(ids.has('pii-ssn')).toBe(true);
    expect(r.risk_level).toBe('high'); // max severity across these
  });

  it('risk_level is the MAX severity present', () => {
    const r = auditArtifact('const t = Math.random();\nconst key = "sk-abcdefghij0123456789";'); // gitleaks:allow — fake fixture
    expect(r.risk_level).toBe('critical'); // api-key(critical) beats insecure-random(medium)
  });

  it('focus restricts to the named rules only', () => {
    const src = 'const t = Math.random();\nconst ssn = "123-45-6789";';
    const r = auditArtifact(src, { focus: ['pii-ssn'] });
    expect(r.checks_run).toEqual(['pii-ssn']);
    expect(r.findings.every((f) => f.rule === 'pii-ssn')).toBe(true);
    expect(r.findings.some((f) => f.rule === 'insecure-random')).toBe(false);
  });

  it('every rule id is unique (registry hygiene)', () => {
    const ids = RULES.map((r) => r.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
