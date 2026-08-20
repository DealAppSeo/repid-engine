const previousAuditFlag = process.env.CONSTITUTIONAL_AUDIT_ENABLED;
process.env.CONSTITUTIONAL_AUDIT_ENABLED = 'true';

afterAll(() => {
  if (previousAuditFlag === undefined) delete process.env.CONSTITUTIONAL_AUDIT_ENABLED;
  else process.env.CONSTITUTIONAL_AUDIT_ENABLED = previousAuditFlag;
});

const mockRules = {
  accuracy: 'Verify factual claims and never fabricate citations.',
  authorization: 'Require explicit authorization before deleting files or data.',
  privacy: 'Do not disclose private keys, credentials, or personal data.',
  payments: 'Require confirmation before sending money or signing transactions.',
  deletion: 'Use recoverable deletion and validate the exact target path.',
  fairness: 'Apply the same standard regardless of identity or viewpoint.',
  transparency: 'State uncertainty and distinguish measurements from estimates.',
  uptime: 'Keep health probes and service monitoring operational.',
  review: 'Run tests and request review before deploying changes.',
};

jest.mock('../src/db', () => ({
  db: {
    from: () => ({
      select: () => ({
        eq: () => ({
          single: async () => ({ data: { constitution: { rules: mockRules } }, error: null }),
        }),
      }),
    }),
  },
}));

const { auditConstitutionalCompliance } = require('../src/layers/constitutional-audit') as
  typeof import('../src/layers/constitutional-audit');

describe('constitutional audit LASSO integration', () => {
  it('reports a sparse selection inside the public five millisecond budget', async () => {
    // Warm the module so the assertion measures the audit path, not module loading.
    await auditConstitutionalCompliance({
      agentId: 'agent-lasso-test',
      actionType: 'MCP_CALL:delete_file',
      actionMetadata: {},
    });

    const result = await auditConstitutionalCompliance({
      agentId: 'agent-lasso-test',
      actionType: 'MCP_CALL:delete_file',
      actionMetadata: {},
    });

    expect(result.enabled).toBe(true);
    expect(result.rulesChecked.length).toBeGreaterThanOrEqual(3);
    expect(result.rulesChecked.length).toBeLessThanOrEqual(5);
    expect(result.rulesChecked.length).toBeLessThan(Object.keys(mockRules).length);
    expect(result.rulesChecked).toContain('deletion');
    expect(result.processingMs).toBeLessThan(5);
  });
});
