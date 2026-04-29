import { createHmac, randomBytes, timingSafeEqual } from 'crypto';

export type ShareIntent = 'referral' | 'challenge' | 'demo_share';

export interface ShareTokenPayload {
  builderId: string;
  intent: ShareIntent;
  expiresAt: number;
  nonce: string;
}

export interface GenerateOptions {
  builderId: string;
  intent: ShareIntent;
  expiresInHours?: number;
}

export interface GenerateResult {
  token: string;
  signedUrl: string;
  qrCodeData: string;
  expiresAt: number;
}

export type VerifyError =
  | 'expired'
  | 'malformed'
  | 'invalid_signature'
  | 'invalid_intent';

export interface VerifyResult {
  valid: boolean;
  payload?: ShareTokenPayload;
  error?: VerifyError;
}

const VALID_INTENTS: ReadonlyArray<ShareIntent> = [
  'referral',
  'challenge',
  'demo_share',
];

const TEST_FALLBACK_SECRET = 'test-only-share-token-secret-do-not-use-in-prod';

function getSecret(): string {
  const fromEnv = process.env.SHARE_TOKEN_SECRET;
  if (fromEnv && fromEnv.length > 0) return fromEnv;
  if (process.env.NODE_ENV === 'test') return TEST_FALLBACK_SECRET;
  // eslint-disable-next-line no-console
  console.warn(
    '[share-token] SHARE_TOKEN_SECRET not set; using test fallback. ' +
      'Set SHARE_TOKEN_SECRET in production environment.',
  );
  return TEST_FALLBACK_SECRET;
}

function getBaseUrl(): string {
  const fromEnv = process.env.TRUSTREPID_BASE_URL;
  if (fromEnv && fromEnv.length > 0) return fromEnv.replace(/\/$/, '');
  return 'https://trustrepid.dev';
}

function base64urlEncode(buf: Buffer | string): string {
  const b = typeof buf === 'string' ? Buffer.from(buf, 'utf8') : buf;
  return b
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

function base64urlDecode(s: string): Buffer {
  const pad = s.length % 4 === 0 ? '' : '='.repeat(4 - (s.length % 4));
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/') + pad;
  return Buffer.from(b64, 'base64');
}

function sign(payloadEncoded: string, secret: string): string {
  return base64urlEncode(
    createHmac('sha256', secret).update(payloadEncoded).digest(),
  );
}

export function generateShareToken(opts: GenerateOptions): GenerateResult {
  const expiresInHours = opts.expiresInHours ?? 168;
  const expiresAt = Date.now() + expiresInHours * 60 * 60 * 1000;
  const payload: ShareTokenPayload = {
    builderId: opts.builderId,
    intent: opts.intent,
    expiresAt,
    nonce: randomBytes(8).toString('hex'),
  };

  const payloadEncoded = base64urlEncode(JSON.stringify(payload));
  const signature = sign(payloadEncoded, getSecret());
  const token = `${payloadEncoded}.${signature}`;
  const signedUrl = `${getBaseUrl()}/?ts=${token}`;

  return {
    token,
    signedUrl,
    qrCodeData: signedUrl,
    expiresAt,
  };
}

function isShareIntent(v: unknown): v is ShareIntent {
  return typeof v === 'string' && (VALID_INTENTS as readonly string[]).includes(v);
}

function isValidPayloadShape(p: unknown): p is ShareTokenPayload {
  if (typeof p !== 'object' || p === null) return false;
  const obj = p as Record<string, unknown>;
  return (
    typeof obj.builderId === 'string' &&
    typeof obj.intent === 'string' &&
    typeof obj.expiresAt === 'number' &&
    Number.isFinite(obj.expiresAt) &&
    typeof obj.nonce === 'string'
  );
}

export function verifyShareToken(token: string): VerifyResult {
  if (typeof token !== 'string' || token.length === 0) {
    return { valid: false, error: 'malformed' };
  }
  const dotIndex = token.indexOf('.');
  if (dotIndex < 0 || dotIndex === token.length - 1) {
    return { valid: false, error: 'malformed' };
  }
  const payloadEncoded = token.slice(0, dotIndex);
  const providedSig = token.slice(dotIndex + 1);

  let payloadJson: string;
  try {
    payloadJson = base64urlDecode(payloadEncoded).toString('utf8');
  } catch {
    return { valid: false, error: 'malformed' };
  }
  if (payloadJson.length === 0) {
    return { valid: false, error: 'malformed' };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(payloadJson);
  } catch {
    return { valid: false, error: 'malformed' };
  }
  if (!isValidPayloadShape(parsed)) {
    return { valid: false, error: 'malformed' };
  }

  const expectedSig = sign(payloadEncoded, getSecret());
  const a = Buffer.from(expectedSig, 'utf8');
  const b = Buffer.from(providedSig, 'utf8');
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    return { valid: false, error: 'invalid_signature' };
  }

  if (!isShareIntent(parsed.intent)) {
    return { valid: false, error: 'invalid_intent' };
  }

  if (parsed.expiresAt <= Date.now()) {
    return { valid: false, error: 'expired' };
  }

  return { valid: true, payload: parsed };
}

export function parseShareTokenFromUrl(url: string): string | null {
  if (typeof url !== 'string' || url.length === 0) return null;
  // Try standard URL parsing first
  try {
    const u = new URL(url);
    const ts = u.searchParams.get('ts');
    if (ts && ts.length > 0) return ts;
    return null;
  } catch {
    // Fallback: regex extraction for non-URL-shaped strings
    const m = /[?&]ts=([^&#]+)/.exec(url);
    if (!m || !m[1]) return null;
    try {
      return decodeURIComponent(m[1]);
    } catch {
      return null;
    }
  }
}
