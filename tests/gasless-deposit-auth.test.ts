/**
 * R3: POST /api/v1/stake/deposit/gasless is keyless, because a newcomer has no API key and the
 * owner's EIP-3009 signature is the authorization (checked in services/gasless-deposit.ts). The
 * bypass is method-gated and exact-path; this pins both, and a control proves the guard can fail.
 */
import { authMiddleware } from '../src/middleware/auth';

jest.mock('../src/db', () => ({ db: { from: () => ({}) } }));
jest.mock('../src/auth/api-keys', () => ({ validateAgentApiKey: jest.fn() }));
jest.mock('../src/engine/agent-log', () => ({ logAgentEvent: jest.fn() }));

async function passesKeyless(method: string, path: string): Promise<boolean> {
  const req: any = { method, path, headers: {}, query: {}, body: {} };
  const res: any = { statusCode: 0, status(c: number) { this.statusCode = c; return this; }, json() { return this; } };
  const next = jest.fn();
  await authMiddleware(req, res, next);
  return next.mock.calls.length === 1 && res.statusCode === 0;
}

test('POST /api/v1/stake/deposit/gasless reaches the route without a key', async () => {
  expect(await passesKeyless('POST', '/api/v1/stake/deposit/gasless')).toBe(true);
});

test('only that method and that exact path', async () => {
  expect(await passesKeyless('GET', '/api/v1/stake/deposit/gasless')).toBe(false);
  expect(await passesKeyless('POST', '/api/v1/stake/deposit/gasless/x')).toBe(false);
  expect(await passesKeyless('POST', '/api/v1/stake/withdraw')).toBe(false);
});
