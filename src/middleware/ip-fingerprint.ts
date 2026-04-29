import { createHash } from 'crypto';
import type { Request, Response, NextFunction, RequestHandler } from 'express';

declare module 'express-serve-static-core' {
  interface Request {
    fingerprint?: string;
  }
}

export interface IpFingerprintOptions {
  headerName?: string;
}

function extractIp(req: Request, headerName: string): string {
  const fwd = req.headers[headerName.toLowerCase()];
  if (typeof fwd === 'string' && fwd.length > 0) {
    // x-forwarded-for may be a comma-separated list — first entry is the original client
    const first = fwd.split(',')[0];
    if (first && first.trim().length > 0) return first.trim();
  } else if (Array.isArray(fwd) && fwd.length > 0) {
    const first = fwd[0];
    if (typeof first === 'string' && first.trim().length > 0) return first.trim();
  }
  if (typeof req.ip === 'string' && req.ip.length > 0) return req.ip;
  const sockAddr = req.socket && req.socket.remoteAddress;
  if (typeof sockAddr === 'string' && sockAddr.length > 0) return sockAddr;
  return 'unknown';
}

function extractUserAgent(req: Request): string {
  const ua = req.headers['user-agent'];
  return typeof ua === 'string' ? ua : '';
}

export function ipFingerprint(opts: IpFingerprintOptions = {}): RequestHandler {
  const headerName = opts.headerName ?? 'x-forwarded-for';
  return (req: Request, _res: Response, next: NextFunction) => {
    const ip = extractIp(req, headerName);
    const ua = extractUserAgent(req).slice(0, 64); // prefix only
    const fp = createHash('sha256').update(`${ip}|${ua}`).digest('hex').slice(0, 32);
    req.fingerprint = fp;
    next();
  };
}
