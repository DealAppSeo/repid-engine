import { attestationExtractorMiddleware } from '../../src/middleware/attestation-extractor';
import { repIdAttestationService } from '../../src/services/repid-attestation';
import { Request, Response } from 'express';

jest.mock('../../src/services/repid-attestation', () => ({
  repIdAttestationService: {
    verifyAttestation: jest.fn(),
  },
}));

describe('Attestation Extractor Middleware', () => {
  let mockRequest: Partial<Request>;
  let mockResponse: Partial<Response>;
  let nextFunction: jest.Mock;

  beforeEach(() => {
    jest.clearAllMocks();
    mockRequest = {
      headers: {},
    };
    mockResponse = {};
    nextFunction = jest.fn();
  });

  it('skips processing if the attestation header is missing', async () => {
    await attestationExtractorMiddleware(
      mockRequest as Request,
      mockResponse as Response,
      nextFunction
    );

    expect(mockRequest.repidAttestation).toBeUndefined();
    expect(nextFunction).toHaveBeenCalled();
  });

  it('decodes and attaches valid attestation to the request object', async () => {
    const rawAttestation = {
      agent_id: 'agent-123',
      tier: 'established',
      repid: 8000,
    };
    const headerValue = Buffer.from(JSON.stringify(rawAttestation)).toString('base64');
    mockRequest.headers = {
      'x-hyperdag-repid-attestation': headerValue,
    };

    (repIdAttestationService.verifyAttestation as jest.Mock).mockResolvedValue({ valid: true });

    await attestationExtractorMiddleware(
      mockRequest as Request,
      mockResponse as Response,
      nextFunction
    );

    expect(mockRequest.repidAttestation).toEqual({
      agent_id: 'agent-123',
      tier: 'established',
      repid: 8000,
    });
    expect(repIdAttestationService.verifyAttestation).toHaveBeenCalledWith(rawAttestation);
    expect(nextFunction).toHaveBeenCalled();
  });

  it('does not attach attestation if verification fails', async () => {
    const rawAttestation = {
      agent_id: 'agent-123',
      tier: 'established',
      repid: 8000,
    };
    const headerValue = Buffer.from(JSON.stringify(rawAttestation)).toString('base64');
    mockRequest.headers = {
      'x-hyperdag-repid-attestation': headerValue,
    };

    (repIdAttestationService.verifyAttestation as jest.Mock).mockResolvedValue({
      valid: false,
      reason: 'Signature verification failed',
    });

    await attestationExtractorMiddleware(
      mockRequest as Request,
      mockResponse as Response,
      nextFunction
    );

    expect(mockRequest.repidAttestation).toBeUndefined();
    expect(nextFunction).toHaveBeenCalled();
  });

  it('gracefully handles and logs json parsing failures without crashing', async () => {
    mockRequest.headers = {
      'x-hyperdag-repid-attestation': 'invalid-base64-json',
    };

    await attestationExtractorMiddleware(
      mockRequest as Request,
      mockResponse as Response,
      nextFunction
    );

    expect(mockRequest.repidAttestation).toBeUndefined();
    expect(nextFunction).toHaveBeenCalled();
  });
});
