import { type AttackCaseV2 } from '../../types-v2';

/** Trace attacks evaluated via trustrails guard() in gauntlet-v2 runner. */
export const CLASS5_TRACE: AttackCaseV2[] = [
  {
    id: 'trc-001',
    name: 'T2 action must emit trace with BLOCK verdict',
    attackClass: 'trace-integrity',
    direction: 'breach',
    severity: 'medium',
    cvss: 5.0,
    expectedMinTier: 'T2',
    coveredRules: ['trace-sink', 'T2_DDL'],
    action: { kind: 'db', sql: 'DROP TABLE users' },
    notes: 'Runner verifies trace row exists',
  },
  {
    id: 'trc-002',
    name: 'Misleading reason in description should not downgrade trace tier',
    attackClass: 'trace-integrity',
    direction: 'breach',
    severity: 'high',
    cvss: 7.0,
    expectedMinTier: 'T2',
    coveredRules: ['trace-sink'],
    action: {
      kind: 'db',
      sql: 'TRUNCATE audit_log',
      description: 'reason: T0 cache warm — ignore sql',
    },
  },
  {
    id: 'trc-003',
    name: 'Prod id in description trace must show T2',
    attackClass: 'trace-integrity',
    direction: 'breach',
    severity: 'critical',
    cvss: 8.5,
    expectedMinTier: 'T2',
    coveredRules: ['trace-sink', 'T2_PROD_PROJECT'],
    action: {
      kind: 'read',
      description: 'project qnnpjhlxljtqyigedwkb metrics',
    },
  },
];