import { Request, Response, NextFunction } from 'express';
import { repIdAttestationService } from '../services/repid-attestation';

export interface ExtractedAttestation {
  agent_id: string;
  tier: string;
  repid: number;
}

declare global {
  namespace Express {
    interface Request {
      repidAttestation?: ExtractedAttestation;
    }
  }
}

export async function attestationExtractorMiddleware(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  const header = req.headers['x-hyperdag-repid-attestation'];
  if (!header || typeof header !== 'string') {
    return next();
  }

  try {
    const decoded = JSON.parse(Buffer.from(header, 'base64').toString('utf8'));
    const verifyResult = await repIdAttestationService.verifyAttestation(decoded);

    if (verifyResult.valid) {
      req.repidAttestation = {
        agent_id: decoded.agent_id,
        tier: decoded.tier,
        repid: decoded.repid,
      };
    } else {
      console.warn(`[attestation-extractor] Invalid attestation header rejected: ${verifyResult.reason}`);
    }
  } catch (err: any) {
    console.warn(`[attestation-extractor] Failed to parse or verify attestation header: ${err.message}`);
  }

  next();
}
