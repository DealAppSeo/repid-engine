/**
 * V1.5 Slice-1 HITL notification dispatcher — unit tests (CC2 2026-05-26).
 * Covers: classifier, render, kill-switch, empty claim, no-subscriber audit,
 * happy-path send, telegram failure, misconfigured chat_id. Mocks via a
 * call-time global holder (avoids jest hoisting/TDZ issues).
 */
jest.mock('../src/db', () => ({
  db: {
    from: (table: string) => {
      const st = (global as any).__hitlMock || {};
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
  pgQuery: jest.fn(async () => (global as any).__hitlClaim ?? []),
}));
jest.mock('../src/routes/telegram', () => ({
  sendTelegramMessage: jest.fn(async () => (global as any).__hitlTg ?? { ok: true, message_id: 123 }),
  sendTelegramAlert: jest.fn(async () => {}),
}));

import { pollOnce, startHitlNotificationDispatcher, classifyReason, renderMessage, escapeHtml } from '../src/services/hitl-notification-dispatcher';
import { pgQuery } from '../src/db/direct-pg';
import { sendTelegramMessage } from '../src/routes/telegram';

const pgMock = pgQuery as jest.Mock;
const tgMock = sendTelegramMessage as jest.Mock;

afterEach(() => {
  delete (global as any).__hitlMock;
  delete (global as any).__hitlClaim;
  delete (global as any).__hitlTg;
  delete process.env.NOTIFICATION_DISPATCHER_ENABLED;
  pgMock.mockClear();
  tgMock.mockClear();
});

describe('classifyReason', () => {
  test('CAPABILITY_GAP* → high_priority_capability_gap', () => {
    expect(classifyReason('CAPABILITY_GAP: unknown_task_type: cait')).toBe('high_priority_capability_gap');
    expect(classifyReason('CAPABILITY_GAP')).toBe('high_priority_capability_gap');
  });
  test('non-matching → null', () => {
    expect(classifyReason('CONFUSED: artifact_missing')).toBeNull();
    expect(classifyReason('')).toBeNull();
    expect(classifyReason(null)).toBeNull();
    expect(classifyReason(undefined)).toBeNull();
  });
});

describe('renderMessage + escapeHtml', () => {
  test('escapes html in agent/reason/id', () => {
    expect(escapeHtml('<script>&"')).toBe('&lt;script&gt;&amp;"');
  });
  test('includes agent, reason, request id, controller deep-link', () => {
    const msg = renderMessage({
      id: 'abc-123', agent_id: 'trinity-mel', reason: 'CAPABILITY_GAP: cait',
      task_id: 999, context: null, requested_at: '2026-05-26T00:00:00Z',
    });
    expect(msg).toMatch(/trinity-mel/);
    expect(msg).toMatch(/CAPABILITY_GAP: cait/);
    expect(msg).toMatch(/abc-123/);
    expect(msg).toMatch(/task 999/);
    expect(msg).toMatch(/escalation\/abc-123/);
  });
});

describe('startHitlNotificationDispatcher kill-switch', () => {
  test('NOTIFICATION_DISPATCHER_ENABLED unset → returns without claiming', async () => {
    await startHitlNotificationDispatcher();
    expect(pgMock).not.toHaveBeenCalled();
  });
  test('=== "false" → also disabled', async () => {
    process.env.NOTIFICATION_DISPATCHER_ENABLED = 'false';
    await startHitlNotificationDispatcher();
    expect(pgMock).not.toHaveBeenCalled();
  });
});

describe('pollOnce', () => {
  test('empty claim → no telegram, no inserts', async () => {
    (global as any).__hitlClaim = [];
    await pollOnce();
    expect(tgMock).not.toHaveBeenCalled();
  });

  test('happy path → telegram sent + notifications insert with delivery_status=sent + telegram_message_id', async () => {
    const inserts: any[] = [];
    (global as any).__hitlClaim = [
      { id: 'req-1', agent_id: 'trinity-mel', reason: 'CAPABILITY_GAP: cait', task_id: 1, context: null, requested_at: '2026-05-26T00:00:00Z' },
    ];
    (global as any).__hitlMock = {
      trinity_user_notification_prefs: { await: { data: [
        { id: 7, user_id: '00000000-0000-0000-0000-000000000111', sbt_token_id: null, device_token: null,
          channel_config: { chat_id: '99999' }, opt_in_event_types: ['high_priority_capability_gap'], agent_id: null },
      ], error: null } },
      notifications: { _insert: (v: any) => inserts.push(v) },
    };
    (global as any).__hitlTg = { ok: true, message_id: 5555 };

    await pollOnce();

    expect(tgMock).toHaveBeenCalledTimes(1);
    expect(tgMock.mock.calls[0][0]).toBe('99999');
    expect(inserts.length).toBe(1);
    expect(inserts[0].user_id).toBe('00000000-0000-0000-0000-000000000111');
    expect(inserts[0].type).toBe('high_priority_capability_gap');
    expect(inserts[0].data.delivery_status).toBe('sent');
    expect(inserts[0].data.telegram_message_id).toBe(5555);
    expect(inserts[0].data.channel_pref_id).toBe(7);
  });

  test('no matching pref → audit-only no_subscriber row', async () => {
    const inserts: any[] = [];
    (global as any).__hitlClaim = [
      { id: 'req-2', agent_id: 'trinity-mel', reason: 'CAPABILITY_GAP: cait', task_id: null, context: null, requested_at: '' },
    ];
    (global as any).__hitlMock = {
      trinity_user_notification_prefs: { await: { data: [], error: null } },
      notifications: { _insert: (v: any) => inserts.push(v) },
    };

    await pollOnce();

    expect(tgMock).not.toHaveBeenCalled();
    expect(inserts.length).toBe(1);
    expect(inserts[0].data.delivery_status).toBe('no_subscriber');
    // sentinel user_id when no pref matched
    expect(inserts[0].user_id).toBe('00000000-0000-0000-0000-000000000000');
  });

  test('telegram fails → audit with delivery_status=failed + tg_error', async () => {
    const inserts: any[] = [];
    (global as any).__hitlClaim = [
      { id: 'req-3', agent_id: 'a', reason: 'CAPABILITY_GAP: x', task_id: null, context: null, requested_at: '' },
    ];
    (global as any).__hitlMock = {
      trinity_user_notification_prefs: { await: { data: [
        { id: 1, user_id: null, sbt_token_id: 'sbt-x', device_token: null,
          channel_config: { chat_id: '1' }, opt_in_event_types: ['high_priority_capability_gap'], agent_id: null },
      ], error: null } },
      notifications: { _insert: (v: any) => inserts.push(v) },
    };
    (global as any).__hitlTg = { ok: false, error: 'tg 401: unauthorized' };

    await pollOnce();

    expect(inserts.length).toBe(1);
    expect(inserts[0].data.delivery_status).toBe('failed');
    expect(inserts[0].data.tg_error).toMatch(/tg 401/);
    expect(inserts[0].data.sbt_token_id).toBe('sbt-x');
    // sentinel user_id when pref identifies via sbt only
    expect(inserts[0].user_id).toBe('00000000-0000-0000-0000-000000000000');
  });

  test('pref missing chat_id → misconfigured audit, no telegram call', async () => {
    const inserts: any[] = [];
    (global as any).__hitlClaim = [
      { id: 'req-4', agent_id: 'a', reason: 'CAPABILITY_GAP: y', task_id: null, context: null, requested_at: '' },
    ];
    (global as any).__hitlMock = {
      trinity_user_notification_prefs: { await: { data: [
        { id: 9, user_id: null, sbt_token_id: null, device_token: 'dev-1',
          channel_config: {}, opt_in_event_types: ['high_priority_capability_gap'], agent_id: null },
      ], error: null } },
      notifications: { _insert: (v: any) => inserts.push(v) },
    };

    await pollOnce();

    expect(tgMock).not.toHaveBeenCalled();
    expect(inserts.length).toBe(1);
    expect(inserts[0].data.delivery_status).toBe('misconfigured');
  });

  test('agent-scoped pref only matches when agent_id matches', async () => {
    const inserts: any[] = [];
    (global as any).__hitlClaim = [
      { id: 'req-5', agent_id: 'trinity-mel', reason: 'CAPABILITY_GAP', task_id: null, context: null, requested_at: '' },
    ];
    (global as any).__hitlMock = {
      trinity_user_notification_prefs: { await: { data: [
        // global subscriber — should match
        { id: 10, user_id: null, sbt_token_id: 'sbt-A', device_token: null,
          channel_config: { chat_id: '111' }, opt_in_event_types: ['high_priority_capability_gap'], agent_id: null },
        // pinned to a different agent — should NOT match
        { id: 11, user_id: null, sbt_token_id: 'sbt-B', device_token: null,
          channel_config: { chat_id: '222' }, opt_in_event_types: ['high_priority_capability_gap'], agent_id: 'trinity-other' },
        // pinned to trinity-mel — should match
        { id: 12, user_id: null, sbt_token_id: 'sbt-C', device_token: null,
          channel_config: { chat_id: '333' }, opt_in_event_types: ['high_priority_capability_gap'], agent_id: 'trinity-mel' },
      ], error: null } },
      notifications: { _insert: (v: any) => inserts.push(v) },
    };

    await pollOnce();

    expect(tgMock).toHaveBeenCalledTimes(2);
    const chatsCalled = tgMock.mock.calls.map((c: any[]) => c[0]).sort();
    expect(chatsCalled).toEqual(['111', '333']);
    expect(inserts.length).toBe(2);
  });
});
