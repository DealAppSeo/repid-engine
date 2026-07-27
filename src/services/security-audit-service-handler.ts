import { ServiceHandlerBase } from './service-handler-base';
import { auditArtifact, type AuditResult } from './security-audit';
import type { ServiceContractRow } from '../types';

/**
 * Security / Safety Audit Service Handler — A2A demo-trio use case #3.
 *
 * A provider agent sells a security audit: a buyer supplies an artifact (source,
 * config, or prose); this returns findings + a risk level. Deliberately verdict-LESS
 * (like reputation_audit): the audit REPORT is the deliverable, so it takes the
 * fulfilled path (never routes the auditor's own work to dispute). Audit QUALITY —
 * did the auditor miss a real risk? — is policed by INDEPENDENT peer-verification
 * (re-run the deterministic audit; a miss costs the first auditor RepID, asymmetric).
 *
 * The analysis is pure + deterministic (security-audit.ts) → free, and two auditors
 * agree, which is exactly what makes a peer-verify disagreement a meaningful signal.
 */
interface SecurityAuditPayload {
  artifact: string;          // the code/config/text to audit
  artifact_type?: string;    // optional hint: 'code' | 'config' | 'contract' | 'text'
  focus?: string[];          // optional subset of rule ids
  title?: string;
}

export class SecurityAuditServiceHandler extends ServiceHandlerBase {
  protected readonly serviceType = 'security_audit';

  protected async fulfill(contract: ServiceContractRow): Promise<Record<string, unknown>> {
    const payload = contract.payload as SecurityAuditPayload;
    if (!payload || typeof payload.artifact !== 'string' || payload.artifact.length === 0) {
      throw new Error('security_audit: payload.artifact (non-empty string) is required');
    }

    const audit: AuditResult = auditArtifact(payload.artifact, { focus: payload.focus });

    return {
      // no `verdict` field → base takes the fulfilled path (report delivered)
      artifact_type: payload.artifact_type ?? 'unknown',
      risk_level: audit.risk_level,
      finding_count: audit.finding_count,
      by_severity: audit.by_severity,
      findings: audit.findings,
      checks_run: audit.checks_run,
      lines_scanned: audit.lines_scanned,
      contract_id: contract.id,
      audited_at: new Date().toISOString(),
      patent_marker: 'P-001',
    };
  }
}
