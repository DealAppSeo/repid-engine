/**
 * Missing peer-verify evidence is NOT_CHECKED. It is never a pass.
 * This reader does not score, fetch, or insert.
 */

export interface PeerVerifyEvidenceReading {
  status: 'NOT_CHECKED' | 'seen';
  pass: null;
}

function present(evidence: unknown): boolean {
  if (typeof evidence === 'string') return evidence.trim().length > 0;
  if (Array.isArray(evidence)) return evidence.length > 0;
  if (evidence !== null && typeof evidence === 'object') {
    return Object.keys(evidence as Record<string, unknown>).length > 0;
  }
  return false;
}

export function readPeerVerifyEvidence(evidence: unknown): PeerVerifyEvidenceReading {
  if (!present(evidence)) return { status: 'NOT_CHECKED', pass: null };
  return { status: 'seen', pass: null };
}
