/**
 * T0.5 agent gate — email OTP + run metering (src/services/email-otp.ts).
 *
 * Email sending is not exercised here (Resend is network); we test the
 * validation, token, and metering logic that guards the hosted-run spend.
 */

process.env.FULL_ACCOUNT_JWT_SECRET = 'test-secret-for-agent-gate';
process.env.AGENT_GATE_ANON_RUNS = '3';
process.env.AGENT_GATE_VERIFIED_RUNS = '10';

import {
  validGateEmail,
  issueAgentGateToken,
  verifyAgentGateToken,
  meterRun,
  peekRuns,
  gateEnabled,
} from '../src/services/email-otp';

describe('agent gate — email validation', () => {
  test('accepts a normal email', () => {
    expect(validGateEmail('dev@example.com')).toBe(true);
  });
  test('rejects junk', () => {
    expect(validGateEmail('not-an-email')).toBe(false);
    expect(validGateEmail('')).toBe(false);
    expect(validGateEmail(undefined)).toBe(false);
    expect(validGateEmail('a@b')).toBe(false);
  });
});

describe('agent gate — token', () => {
  test('round-trips and carries the agent_gate scope', () => {
    const token = issueAgentGateToken('Dev@Example.com');
    expect(token).toBeTruthy();
    const payload = verifyAgentGateToken(token!);
    expect(payload).not.toBeNull();
    expect(payload!.email).toBe('dev@example.com');
    expect(payload!.scope).toBe('agent_gate');
  });

  test('rejects tampered and foreign tokens', () => {
    const token = issueAgentGateToken('dev@example.com')!;
    expect(verifyAgentGateToken(token.slice(0, -2) + 'xx')).toBeNull();
    expect(verifyAgentGateToken('garbage')).toBeNull();
    expect(verifyAgentGateToken(undefined)).toBeNull();
  });

  test('a full-account-shaped token without agent_gate scope is rejected', () => {
    const jwt = require('jsonwebtoken');
    const foreign = jwt.sign(
      { builder_id: 'b1', email: 'dev@example.com' },
      process.env.FULL_ACCOUNT_JWT_SECRET,
      { algorithm: 'HS256', expiresIn: '1h' }
    );
    expect(verifyAgentGateToken(foreign)).toBeNull();
  });
});

describe('agent gate — metering', () => {
  test('gate is enabled by default', () => {
    expect(gateEnabled()).toBe(true);
  });

  test('anonymous callers get the taste then a block; header count decrements', () => {
    const ip = `10.0.0.${Math.floor(Math.random() * 250)}`;
    const first = meterRun(ip, undefined);
    expect(first.allowed).toBe(true);
    expect(first.verified).toBe(false);
    expect(first.limit).toBe(3);
    meterRun(ip, undefined);
    const third = meterRun(ip, undefined);
    expect(third.allowed).toBe(true);
    expect(third.remaining).toBe(0);
    const fourth = meterRun(ip, undefined);
    expect(fourth.allowed).toBe(false);
  });

  test('a verified token switches to the email-keyed higher cap', () => {
    const ip = '10.1.1.1';
    for (let i = 0; i < 5; i++) meterRun(ip, undefined); // exhaust anon for this ip
    const token = issueAgentGateToken(`v${Math.random().toString(36).slice(2, 8)}@example.com`)!;
    const metered = meterRun(ip, token);
    expect(metered.allowed).toBe(true);
    expect(metered.verified).toBe(true);
    expect(metered.limit).toBe(10);
  });

  test('peek does not consume', () => {
    const ip = `10.2.2.${Math.floor(Math.random() * 250)}`;
    const before = peekRuns(ip, undefined);
    peekRuns(ip, undefined);
    const after = peekRuns(ip, undefined);
    expect(after.remaining).toBe(before.remaining);
  });
});
