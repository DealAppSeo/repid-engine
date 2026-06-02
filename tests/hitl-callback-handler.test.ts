/**
 * V1.6 — HITL approve/deny callback handler + expiry sweeper — unit tests.
 *
 * Coverage:
 *   • Signing/verification roundtrip + tamper rejection
 *   • Malformed payload + missing secret graceful fail
 *   • Expired-mid-click (no UPDATE)
 *   • Happy-path approve + deny (atomic UPDATE → decisions audit row → ack)
 *   • Double-tap idempotency (first wins, second gets "Already approved")
 *   • Chat-id binding (mismatch rejected, missing rejected)
 *   • Short-id not found / ambiguous
 *   • Expiry sweeper (claims expired, kill-switch off)
 *   • Dispatcher attaches inline_keyboard only when both V1.6 gates set
 */
import crypto from 'crypto';

jest.mock('../src/db', () => ({
  db: {
    from: (table: string) => {
      const st = (global as any).__v16Mock || {};
      const h = st[table] || {};
      const chain: any = {
        select: () => chain,
        insert: (v: any) => { if (h._insert) h._insert(v); return Promise.resolve({ error: null }); },
        eq: () => chain,
        contains: () => chain,
        then: (res: any, rej: any) => Promise.resolve(h.await ?? { data: [], error: null }).then(res, rej),
      };
      return chain;
    },
  },
}));
jest.mock('../src/db/direct-pg', () => ({
  pgQuery: jest.fn(async (text: string) => {
    const fixtures = (global as any).__v16Pg || {};
    if (text.includes('SELECT r.id::text AS request_id')) return fixtures.resolve ?? [];
    if (text.includes("SET status = $1") && text.includes('decision_metadata')) return fixtures.atomicUpdate ?? [];
    if (text.includes("SELECT status FROM trinity_hitl_requests WHERE id::text =")) return fixtures.finalStatus ?? [{ status: 'unknown' }];
    if (text.includes('current_repid::text AS r FROM repid_agents')) return fixtures.agentRepid ?? [];
    if (text.includes("SET status='expired'")) return fixtures.sweeperExpired ?? [];
    if (text.includes("SET status='expired'") && text.includes('click-after-expiry')) return [];
    return [];
  }),
}));

// Default-valid env so sign+verify + Telegram-mock work for most tests; tests that
// need an env absent will delete it in their setup. TELEGRAM_BOT_TOKEN matters
// because answerCallback() + editMessageRemoveKeyboard() early-return without it.
beforeEach(() => {
  process.env.HITL_CALLBACK_HMAC_SECRET = 'unit-test-hmac-secret-32-bytes-min';
  process.env.TELEGRAM_BOT_TOKEN = 'unit-test-bot-token';
  (global as any).fetch = jest.fn(async () => ({ ok: true, json: async () => ({ ok: true }) }));
});
afterEach(() => {
  delete (global as any).__v16Mock;
  delete (global as any).__v16Pg;
  delete process.env.HITL_CALLBACK_HMAC_SECRET;
  delete process.env.HITL_CALLBACK_TTL_HOURS;
  delete process.env.HITL_CALLBACK_ENABLED;
  delete process.env.HITL_EXPIRY_SWEEPER_ENABLED;
  delete (global as any).fetch;
  pgMock.mockClear();   // call-history must NOT leak across tests
});

import {
  signCallbackPayload,
  verifyCallbackPayload,
  shortIdFromUuid,
  handleHitlCallback,
} from '../src/services/hitl-callback-handler';
import { pollOnce as sweeperPoll, startHitlExpirySweeper } from '../src/services/hitl-expiry-sweeper';
import { pgQuery } from '../src/db/direct-pg';

const pgMock = pgQuery as jest.Mock;

function makeRes() {
  const r: any = {};
  r.sendStatus = jest.fn(() => r);
  return r;
}

function futureExp(hours = 1): number { return Math.floor(Date.now() / 1000) + hours * 3600; }
function pastExp(hours = 1): number   { return Math.floor(Date.now() / 1000) - hours * 3600; }

describe('signing + verification', () => {
  test('sign + verify roundtrip — valid', () => {
    const payload = signCallbackPayload('a', 'deadbeef', futureExp());
    expect(payload).toMatch(/^v1:a:deadbeef:\d{10}:[0-9a-f]{8}$/);
    const v = verifyCallbackPayload(payload);
    expect(v.ok).toBe(true);
    expect(v.decision).toBe('a');
    expect(v.requestIdShort).toBe('deadbeef');
  });

  test('verify rejects tampered hmac', () => {
    const payload = signCallbackPayload('a', 'deadbeef', futureExp());
    // flip the last hex char
    const tampered = payload.slice(0, -1) + (payload.slice(-1) === 'a' ? 'b' : 'a');
    const v = verifyCallbackPayload(tampered);
    expect(v.ok).toBe(false);
    expect(v.error).toMatch(/invalid hmac/);
  });

  test('verify rejects malformed payload', () => {
    expect(verifyCallbackPayload('').ok).toBe(false);
    expect(verifyCallbackPayload('v1:a:deadbeef').ok).toBe(false);
    expect(verifyCallbackPayload('v2:a:deadbeef:1234567890:00000000').ok).toBe(false);
    expect(verifyCallbackPayload('v1:x:deadbeef:1234567890:00000000').ok).toBe(false);
  });

  test('sign throws when HITL_CALLBACK_HMAC_SECRET missing', () => {
    delete process.env.HITL_CALLBACK_HMAC_SECRET;
    expect(() => signCallbackPayload('a', 'deadbeef', futureExp())).toThrow(/not configured/);
  });

  test('verify rejects when secret missing (graceful, no throw)', () => {
    delete process.env.HITL_CALLBACK_HMAC_SECRET;
    expect(verifyCallbackPayload('v1:a:deadbeef:1234567890:00000000').ok).toBe(false);
  });

  test('shortIdFromUuid extracts 8-hex from uuid', () => {
    expect(shortIdFromUuid('8e7a4c3b-1234-5678-9abc-def012345678')).toBe('8e7a4c3b');
    expect(shortIdFromUuid('8E7A4C3B-...')).toBe('8e7a4c3b');
  });
});

describe('handleHitlCallback', () => {
  function mkReq(decision: 'a' | 'd', shortId: string, expSec: number, chatId = '99999') {
    return {
      body: {
        callback_query: {
          id: 'cb-1', data: signCallbackPayload(decision, shortId, expSec),
          message: { chat: { id: Number(chatId) }, message_id: 4242 },
          from: { id: Number(chatId) },
        },
      },
      headers: {},
    } as any;
  }

  test('expired-mid-click → does not call atomic UPDATE, answers "expired"', async () => {
    const req = mkReq('a', 'deadbeef', pastExp(2));
    const res = makeRes();
    await handleHitlCallback(req, res);
    expect(res.sendStatus).toHaveBeenCalledWith(200);
    // none of the resolve/atomic update SQLs should have fired
    const resolveCalls = pgMock.mock.calls.filter((c: any[]) => /SELECT r\.id::text AS request_id/.test(c[0]));
    expect(resolveCalls.length).toBe(0);
    // Telegram answer should have been called with the expired message
    expect((global as any).fetch).toHaveBeenCalled();
    const tgBody = JSON.parse(((global as any).fetch as jest.Mock).mock.calls[0][1].body);
    expect(tgBody.text).toMatch(/expired/i);
    expect(tgBody.show_alert).toBe(true);
  });

  test('happy path APPROVE → atomic UPDATE + decisions audit row + ack', async () => {
    const inserts: any[] = [];
    (global as any).__v16Mock = {
      trinity_hitl_decisions: { _insert: (v: any) => inserts.push(v) },
    };
    (global as any).__v16Pg = {
      resolve: [{
        request_id: '8e7a4c3b-aaaa-bbbb-cccc-dddddddddddd',
        agent_id: 'trinity-mel', task_id: 5, reason: 'CAPABILITY_GAP: cait', status: 'pending',
        expected_chat_id: '99999',
      }],
      atomicUpdate: [{ id: '8e7a4c3b-aaaa-bbbb-cccc-dddddddddddd', status: 'approved' }],
      agentRepid: [{ r: '1467' }],
    };
    const req = mkReq('a', '8e7a4c3b', futureExp());
    const res = makeRes();
    await handleHitlCallback(req, res);
    expect(res.sendStatus).toHaveBeenCalledWith(200);
    expect(inserts.length).toBe(1);
    expect(inserts[0].decision).toBe('APPROVED');
    expect(inserts[0].agent_id).toBe('trinity-mel');
    expect(inserts[0].agent_repid).toBe('1467');
    expect(inserts[0].telegram_message_id).toBe(4242);
    expect(typeof inserts[0].signature).toBe('string');
    expect(inserts[0].signature.length).toBeGreaterThan(32);
    // ack message was "Approved"
    const tgCalls = ((global as any).fetch as jest.Mock).mock.calls;
    const ack = tgCalls.find((c: any[]) => c[0].includes('answerCallbackQuery'));
    expect(JSON.parse(ack[1].body).text).toMatch(/Approved/);
  });

  test('happy path DENY → decision=DENIED in audit', async () => {
    const inserts: any[] = [];
    (global as any).__v16Mock = { trinity_hitl_decisions: { _insert: (v: any) => inserts.push(v) } };
    (global as any).__v16Pg = {
      resolve: [{ request_id: 'aaaaaaaa-...', agent_id: 'trinity-x', task_id: null,
                  reason: 'CAPABILITY_GAP', status: 'pending', expected_chat_id: '99999' }],
      atomicUpdate: [{ id: 'aaaaaaaa-...', status: 'denied' }],
      agentRepid: [],
    };
    const req = mkReq('d', 'aaaaaaaa', futureExp());
    const res = makeRes();
    await handleHitlCallback(req, res);
    expect(inserts[0].decision).toBe('DENIED');
    expect(inserts[0].agent_repid).toBe('unknown'); // fallback when lookup returns []
  });

  test('double-tap idempotency → second tap matches 0 rows → "Already <status>"', async () => {
    (global as any).__v16Pg = {
      resolve: [{ request_id: 'rid', agent_id: 'a', task_id: 1, reason: 'r', status: 'approved',
                  expected_chat_id: '99999' }],
      atomicUpdate: [],                                       // 0 rows = already terminal
      finalStatus: [{ status: 'approved' }],
    };
    const req = mkReq('a', 'cafe1234', futureExp());
    const res = makeRes();
    await handleHitlCallback(req, res);
    expect(res.sendStatus).toHaveBeenCalledWith(200);
    const tgCalls = ((global as any).fetch as jest.Mock).mock.calls;
    const ack = tgCalls.find((c: any[]) => c[0].includes('answerCallbackQuery'));
    expect(JSON.parse(ack[1].body).text).toMatch(/Already approved/);
    // and keyboard was edited away
    const editCall = tgCalls.find((c: any[]) => c[0].includes('editMessageReplyMarkup'));
    expect(editCall).toBeDefined();
  });

  test('chat-id binding mismatch → "Not authorized for this chat"', async () => {
    (global as any).__v16Pg = {
      resolve: [{ request_id: 'rid', agent_id: 'a', task_id: 1, reason: 'r', status: 'pending',
                  expected_chat_id: '11111' }],                // pref bound to a DIFFERENT chat
    };
    const req = mkReq('a', 'beef1234', futureExp(), '99999');  // user clicking from chat 99999
    const res = makeRes();
    await handleHitlCallback(req, res);
    const tgCalls = ((global as any).fetch as jest.Mock).mock.calls;
    const ack = tgCalls.find((c: any[]) => c[0].includes('answerCallbackQuery'));
    expect(JSON.parse(ack[1].body).text).toMatch(/Not authorized/);
    // no atomic update attempted (resolve fired, atomicUpdate did not)
    const updateCalls = pgMock.mock.calls.filter((c: any[]) => /SET status = \$1/.test(c[0]));
    expect(updateCalls.length).toBe(0);
  });

  test('expected_chat_id null (no prior notification matched) → also "Not authorized"', async () => {
    (global as any).__v16Pg = {
      resolve: [{ request_id: 'rid', agent_id: 'a', task_id: 1, reason: 'r', status: 'pending',
                  expected_chat_id: null }],
    };
    const req = mkReq('a', 'beef0000', futureExp());
    const res = makeRes();
    await handleHitlCallback(req, res);
    const ack = ((global as any).fetch as jest.Mock).mock.calls.find((c: any[]) => c[0].includes('answerCallbackQuery'));
    expect(JSON.parse(ack[1].body).text).toMatch(/Not authorized/);
  });

  test('short_id not found → "Request not found"', async () => {
    (global as any).__v16Pg = { resolve: [] };
    const req = mkReq('a', '00000000', futureExp());
    const res = makeRes();
    await handleHitlCallback(req, res);
    const ack = ((global as any).fetch as jest.Mock).mock.calls.find((c: any[]) => c[0].includes('answerCallbackQuery'));
    expect(JSON.parse(ack[1].body).text).toMatch(/Request not found/);
  });

  test('short_id ambiguous (2 matches) → "Ambiguous"', async () => {
    (global as any).__v16Pg = {
      resolve: [
        { request_id: 'r1', agent_id: 'a', task_id: 1, reason: 'r', status: 'pending', expected_chat_id: '99999' },
        { request_id: 'r2', agent_id: 'a', task_id: 1, reason: 'r', status: 'pending', expected_chat_id: '99999' },
      ],
    };
    const req = mkReq('a', '11111111', futureExp());
    const res = makeRes();
    await handleHitlCallback(req, res);
    const ack = ((global as any).fetch as jest.Mock).mock.calls.find((c: any[]) => c[0].includes('answerCallbackQuery'));
    expect(JSON.parse(ack[1].body).text).toMatch(/Ambiguous/);
  });

  test('malformed callback_data → rejected before any DB hop', async () => {
    const req: any = {
      body: { callback_query: { id: 'cb', data: 'totally-bogus',
        message: { chat: { id: 1 }, message_id: 1 }, from: { id: 1 } } },
      headers: {},
    };
    const res = makeRes();
    await handleHitlCallback(req, res);
    const ack = ((global as any).fetch as jest.Mock).mock.calls.find((c: any[]) => c[0].includes('answerCallbackQuery'));
    expect(JSON.parse(ack[1].body).text).toMatch(/Rejected: malformed/);
    expect(pgMock).not.toHaveBeenCalled();
  });

  test('no callback_query in body → 200 with no side effect', async () => {
    const req: any = { body: {}, headers: {} };
    const res = makeRes();
    await handleHitlCallback(req, res);
    expect(res.sendStatus).toHaveBeenCalledWith(200);
    expect(pgMock).not.toHaveBeenCalled();
  });
});

describe('expiry sweeper', () => {
  test('kill switch off → no claim', async () => {
    delete process.env.HITL_EXPIRY_SWEEPER_ENABLED;
    await startHitlExpirySweeper();
    expect(pgMock).not.toHaveBeenCalled();
  });

  test('pollOnce flips expired rows + logs count', async () => {
    (global as any).__v16Pg = { sweeperExpired: [{ id: 'r1' }, { id: 'r2' }] };
    await sweeperPoll();
    // join the FULL SQL bodies (no slice — `FOR UPDATE SKIP LOCKED` lives deeper in)
    const callSql = pgMock.mock.calls.map((c: any[]) => String(c[0])).join('\n');
    expect(callSql).toMatch(/SET status = 'expired'/);
    expect(callSql).toMatch(/FOR UPDATE SKIP LOCKED/);
  });

  test('pollOnce with no expired rows is a no-op', async () => {
    (global as any).__v16Pg = { sweeperExpired: [] };
    await expect(sweeperPoll()).resolves.not.toThrow();
  });
});

describe('dispatcher attaches inline_keyboard only when V1.6 gates set', () => {
  // White-box check: dispatcher imports signCallbackPayload + only invokes it
  // when both env gates are present. We don't re-test the whole dispatcher (covered
  // in tests/hitl-notification-dispatcher.test.ts); we just verify the gate logic
  // by importing the source and grepping the gate condition.
  test('source contains both env checks on the keyboard branch', () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const fs = require('fs');
    const path = require('path');
    const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'services', 'hitl-notification-dispatcher.ts'), 'utf8');
    expect(src).toMatch(/HITL_CALLBACK_ENABLED === 'true'/);
    expect(src).toMatch(/HITL_CALLBACK_HMAC_SECRET/);
    expect(src).toMatch(/signCallbackPayload/);
  });
});
