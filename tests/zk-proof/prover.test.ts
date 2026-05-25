import { generateProof } from '../../src/zk-proof/prover';
import { generateProofReal } from '../../src/zkp/plonky3-real';

jest.mock('../../src/zkp/plonky3-real', () => ({
  generateProofReal: jest.fn(),
}));

describe('ZK Proof Generation Wrapper', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('correctly maps plonky3_real proof source to plonky3-real-v1 format', async () => {
    (generateProofReal as jest.Mock).mockResolvedValue({
      proof: 'real-proof-bytes',
      proof_source: 'plonky3_real',
    });

    const result = await generateProof({
      agent_id: 'agent-123',
      requester_pubkey: 'pubkey-abc',
      requested_tier: 'package',
      timestamp: '2026-05-25T12:00:00Z',
    });

    expect(result).toEqual({
      proof: 'real-proof-bytes',
      proof_source: 'plonky3_real',
      proofFormat: 'plonky3-real-v1',
      proofVersion: '1.0',
    });
    expect(generateProofReal).toHaveBeenCalledWith(
      'agent-123',
      'pubkey-abc',
      'package',
      '2026-05-25T12:00:00Z'
    );
  });

  it('correctly maps hmac_fallback proof source to plonky3-babybear-stub-v1 format', async () => {
    (generateProofReal as jest.Mock).mockResolvedValue({
      proof: 'hmac-proof-bytes',
      proof_source: 'hmac_fallback',
    });

    const result = await generateProof({
      agent_id: 'agent-123',
      requester_pubkey: 'pubkey-abc',
      requested_tier: 'package',
      timestamp: '2026-05-25T12:00:00Z',
    });

    expect(result).toEqual({
      proof: 'hmac-proof-bytes',
      proof_source: 'hmac_fallback',
      proofFormat: 'plonky3-babybear-stub-v1',
      proofVersion: '1.0',
    });
  });
});
