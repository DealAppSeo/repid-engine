/**
 * security-audit.ts — pure, deterministic security/safety auditor for the A2A
 * "security audit" service (demo-trio use case #3). No I/O, no LLM, no deps →
 * free to run, deterministic, and unit-testable in isolation. The handler
 * (security-audit-service-handler.ts) wraps this; a provider agent sells it and
 * an INDEPENDENT peer-verifier can re-run it to catch a lazy auditor (the
 * enforcement path — a missed planted finding costs the first auditor RepID).
 *
 * Line-based static checks for the highest-signal, lowest-false-positive classes:
 * hardcoded secrets, injection sinks, unsafe deserialization, weak crypto,
 * disabled auth, insecure transport, and cleartext PII. Curated, not exhaustive
 * — extendable via RULES. Deterministic ⇒ two auditors agree ⇒ disputes are meaningful.
 */

export type Severity = 'critical' | 'high' | 'medium' | 'low';
const SEVERITY_RANK: Record<Severity, number> = { low: 1, medium: 2, high: 3, critical: 4 };

export interface Finding {
  rule: string;
  severity: Severity;
  line: number;      // 1-indexed
  snippet: string;   // the offending line, trimmed + length-capped
  description: string;
}

export interface AuditResult {
  findings: Finding[];
  finding_count: number;
  risk_level: Severity | 'none';
  checks_run: string[];
  lines_scanned: number;
  by_severity: Record<Severity, number>;
}

export interface AuditOptions {
  /** Restrict to a subset of rule ids (e.g. ['hardcoded-api-key','sql-injection']); empty/undefined = all. */
  focus?: string[];
}

interface Rule { id: string; severity: Severity; re: RegExp; description: string; }

/** The curated ruleset. Each regex is line-scoped to keep matches precise + explainable. */
export const RULES: readonly Rule[] = [
  { id: 'hardcoded-private-key', severity: 'critical', description: 'Hardcoded private key material',
    re: /-----BEGIN (?:RSA |EC |OPENSSH |PGP )?PRIVATE KEY-----/ },
  { id: 'hardcoded-api-key', severity: 'critical', description: 'Hardcoded API key / access token',
    re: /\b(?:sk-[A-Za-z0-9]{16,}|AKIA[0-9A-Z]{16}|ghp_[A-Za-z0-9]{20,}|xox[baprs]-[A-Za-z0-9-]{10,}|AIza[0-9A-Za-z_-]{20,})\b/ },
  { id: 'hardcoded-password', severity: 'high', description: 'Hardcoded password/secret literal',
    re: /(?:password|passwd|pwd|secret|api[_-]?key|token)\s*[:=]\s*['"][^'"]{4,}['"]/i },
  { id: 'sql-injection', severity: 'high', description: 'SQL built via string concatenation/interpolation (injection risk)',
    re: /\b(?:SELECT|INSERT\s+INTO|UPDATE|DELETE\s+FROM)\b[\s\S]{0,100}?(?:['"]\s*\+\s*\w|\$\{|%s|`[^`]*\$\{)/i },
  { id: 'code-exec-sink', severity: 'high', description: 'Dynamic code / shell execution sink',
    re: /\b(?:eval|new\s+Function|child_process|execSync|os\.system|subprocess\.\w+\([^)]*shell\s*=\s*True)\b/ },
  { id: 'unsafe-deserialization', severity: 'high', description: 'Unsafe deserialization of untrusted data',
    re: /\b(?:pickle\.loads|Marshal\.load|unserialize)\b|yaml\.load\s*\((?![^)]*Loader)/ },
  { id: 'weak-crypto', severity: 'medium', description: 'Weak hash used in a security context',
    re: /createHash\(\s*['"](?:md5|sha1)['"]|\b(?:hashlib\.)?(?:md5|sha1)\s*\(/i },
  { id: 'insecure-random', severity: 'medium', description: 'Non-cryptographic RNG (unsafe for tokens/keys/nonces)',
    re: /\bMath\.random\s*\(\s*\)/ },
  { id: 'auth-disabled', severity: 'high', description: 'Authentication explicitly disabled/skipped/deferred',
    re: /(?:\/\/|#)\s*(?:no auth\b|auth(?:entication)? (?:disabled|off|skipped)|skip auth|TODO:?\s*auth|FIXME:?\s*auth)/i },
  { id: 'insecure-transport', severity: 'medium', description: 'Insecure (http) transport to a non-local host',
    re: /http:\/\/(?!localhost|127\.0\.0\.1|0\.0\.0\.0)/ },
  { id: 'pii-ssn', severity: 'high', description: 'Possible US SSN in cleartext',
    re: /\b\d{3}-\d{2}-\d{4}\b/ },
  { id: 'pii-payment-card', severity: 'high', description: 'Possible payment-card number in cleartext',
    re: /\b(?:4[0-9]{12}(?:[0-9]{3})?|5[1-5][0-9]{14}|3[47][0-9]{13})\b/ },
];

const cap = (s: string, n = 160): string => (s.length > n ? s.slice(0, n) + '…' : s);

/**
 * Audit an artifact (source, config, or prose). Pure + deterministic.
 * @returns findings (ordered by line), the max severity as risk_level, and telemetry.
 */
export function auditArtifact(artifact: string, opts: AuditOptions = {}): AuditResult {
  const focus = opts.focus && opts.focus.length > 0 ? new Set(opts.focus) : null;
  const active = RULES.filter((r) => !focus || focus.has(r.id));
  const lines = (artifact ?? '').split(/\r?\n/);
  const findings: Finding[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    for (const rule of active) {
      // fresh test per line (regexes are non-global, so no lastIndex state to reset)
      if (rule.re.test(line)) {
        findings.push({ rule: rule.id, severity: rule.severity, line: i + 1, snippet: cap(line.trim()), description: rule.description });
      }
    }
  }

  const by_severity: Record<Severity, number> = { critical: 0, high: 0, medium: 0, low: 0 };
  for (const f of findings) by_severity[f.severity]++;

  let risk: Severity | 'none' = 'none';
  for (const f of findings) if (risk === 'none' || SEVERITY_RANK[f.severity] > SEVERITY_RANK[risk]) risk = f.severity;

  return {
    findings,
    finding_count: findings.length,
    risk_level: risk,
    checks_run: active.map((r) => r.id),
    lines_scanned: lines.length,
    by_severity,
  };
}
