/**
 * Escalation router — taxonomy tests (CC2 2026-05-26).
 * agent_internal no-op · squad_internal recorded-only · code_agent→autonomous_tasks(cc/gemini) ·
 * sean→autonomous_tasks(sean, requires_sean_approval) + Telegram.
 */
jest.mock('../src/routes/telegram', () => ({ sendTelegramAlert: jest.fn(async () => {}) }));
jest.mock('../src/db', () => ({
  db: {
    from: (table: string) => {
      const st = (global as any).__escMock || {};
      const h = st[table] || {};
      const chain: any = {
        select: () => chain,
        insert: (v: any) => { if (h._insert) h._insert(v); return chain; },
        update: (v: any) => { if (h._update) h._update(v); return chain; },
        eq: () => chain,
        single: () => Promise.resolve(h.single ?? { data: null }),
        then: (res: any, rej: any) => Promise.resolve(h.await ?? { data: [] }).then(res, rej),
      };
      return chain;
    },
  },
}));

import { routeEscalation } from '../src/services/escalation-router';
import { sendTelegramAlert } from '../src/routes/telegram';

const tgMock = sendTelegramAlert as jest.Mock;

function setMock(tables: any) { (global as any).__escMock = tables; }
afterEach(() => { delete (global as any).__escMock; tgMock.mockClear(); });

test('agent_internal → no escalation recorded', async () => {
  setMock({});
  const r = await routeEscalation({ agent_id: 'a', level: 'agent_internal', summary: 's' });
  expect(r.routed).toBe(false);
  expect(tgMock).not.toHaveBeenCalled();
});

test('squad_internal → recorded only, routed_to=squad, no autonomous task', async () => {
  const escIns: any[] = [];
  setMock({ controller_escalations: { single: { data: { id: 1 } }, _insert: (v: any) => escIns.push(v) } });
  const r = await routeEscalation({ agent_id: 'a', level: 'squad_internal', summary: 's' });
  expect(r.routed).toBe(true);
  expect(r.routed_to).toBe('squad');
  expect(r.autonomous_task_id).toBeNull();
  expect(escIns[0].level).toBe('squad_internal');
});

test('code_agent → autonomous_tasks(cc), no sean approval', async () => {
  const autoIns: any[] = [];
  setMock({
    autonomous_tasks: { single: { data: { id: 777 } }, _insert: (v: any) => autoIns.push(v) },
    controller_escalations: { single: { data: { id: 2 } } },
  });
  const r = await routeEscalation({ agent_id: 'trinity-mel', level: 'code_agent', summary: 'cross-squad failed' });
  expect(r.routed_to).toBe('cc');
  expect(r.autonomous_task_id).toBe(777);
  expect(autoIns[0].assigned_to).toBe('cc');
  expect(autoIns[0].requires_sean_approval).toBe(false);
  expect(tgMock).not.toHaveBeenCalled();
});

test('code_agent assignee=gemini → autonomous_tasks(gemini)', async () => {
  const autoIns: any[] = [];
  setMock({
    autonomous_tasks: { single: { data: { id: 778 } }, _insert: (v: any) => autoIns.push(v) },
    controller_escalations: { single: { data: { id: 3 } } },
  });
  const r = await routeEscalation({ agent_id: 'x', level: 'code_agent', summary: 's', assignee: 'gemini' });
  expect(r.routed_to).toBe('gemini');
  expect(autoIns[0].assigned_to).toBe('gemini');
});

test('sean → autonomous_tasks(sean, requires_sean_approval) + Telegram', async () => {
  const autoIns: any[] = [];
  const escUpd: any[] = [];
  setMock({
    autonomous_tasks: { single: { data: { id: 900 } }, _insert: (v: any) => autoIns.push(v) },
    controller_escalations: { single: { data: { id: 42 } }, _update: (v: any) => escUpd.push(v), await: {} },
  });
  const r = await routeEscalation({ agent_id: 'trinity-veritas', task_id: 5, level: 'sean', summary: 'strategic decision' });
  expect(r.routed_to).toBe('sean');
  expect(r.autonomous_task_id).toBe(900);
  expect(autoIns[0].assigned_to).toBe('sean');
  expect(autoIns[0].requires_sean_approval).toBe(true);
  expect(tgMock).toHaveBeenCalledTimes(1);
  expect(tgMock.mock.calls[0][0]).toMatch(/Escalation . Sean/);
  expect(r.telegram_sent).toBe(true);
  expect(escUpd[0].telegram_sent).toBe(true);
});
