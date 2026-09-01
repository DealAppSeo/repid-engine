/**
 * `anchor_confirmed` delivery, and the two ways this could quietly be a lie.
 *
 * WHY THIS EXISTS. A proof is verifiable seconds after a score event; its on-chain attestation
 * lands a couple of minutes later, in a batch. Nothing told the agent when — the only way to find
 * out was to poll the passport and notice a field had changed. This is the push half.
 *
 * TWO THINGS MEASURED BEFORE A LINE WAS WRITTEN, both of which shaped the design:
 *
 *   1. `sendNotification` has ZERO callers. notify.ts was built and never wired.
 *   2. ZERO agents in production have a webhook_url. Nobody is subscribed to anything.
 *
 * (2) is why this file's coverage is the claim, and why the PR says no live delivery has been
 * observed: there is nobody to deliver to yet. A test that pretended otherwise would be the
 * defect this whole line of work exists to remove.
 *
 * It also means `lookupWebhookConfig` SELECTing `webhook_events` and discarding it has never
 * mis-delivered anything — but it is load-bearing the moment either fact changes, which is now.
 */
import { describe, it, expect, jest, beforeEach, afterAll } from '@jest/globals';
import { createHmac } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { AddressInfo } from 'node:net';

const maybeSingle = jest.fn<() => Promise<{ data: unknown }>>();
jest.mock('../src/db', () => ({
  db: {
    from: () => ({ select: () => ({ eq: () => ({ maybeSingle }) }) }),
  },
}));
jest.mock('../src/services/audit-emit', () => ({ emitAuditEvent: jest.fn(async () => undefined) }));

import { notifyAgentEvent, isSubscribed, NOTIFY_EVENTS } from '../src/services/notify';
import { emitAuditEvent } from '../src/services/audit-emit';

const agent = (over: Record<string, unknown> = {}) => ({
  data: { webhook_url: 'http://127.0.0.1:1/hook', webhook_secret: 's3cret', webhook_events: ['anchor_confirmed'], ...over },
});

beforeEach(() => {
  maybeSingle.mockReset().mockResolvedValue(agent());
  (emitAuditEvent as jest.Mock).mockClear();
});

describe('isSubscribed — explicit opt-in, and the null boundary', () => {
  it('an unset or empty list means NOTHING, not everything', () => {
    // The direction is the whole point. If null meant "all", adding `anchor_confirmed` to
    // NOTIFY_EVENTS would have silently widened every webhook in the system on deploy.
    expect(isSubscribed(null, 'anchor_confirmed')).toBe(false);
    expect(isSubscribed(undefined, 'anchor_confirmed')).toBe(false);
    expect(isSubscribed([], 'anchor_confirmed')).toBe(false);
  });

  it('agrees with the score-event route at that same boundary', () => {
    // That route is `(agent.webhook_events || []).includes('score_event')`. A second rule
    // disagreeing with the first at null is exactly how the tier ladder drifted four times.
    const legacy = (events: string[] | null, e: string) => (events || []).includes(e);
    for (const events of [null, [], ['score_event'], ['anchor_confirmed'], ['score_event', 'anchor_confirmed']]) {
      for (const e of NOTIFY_EVENTS) {
        expect(isSubscribed(events, e)).toBe(legacy(events, e));
      }
    }
  });
});

describe('notifyAgentEvent — three outcomes, never two', () => {
  it('no webhook configured is not a failure and is NOT audited as a drop', async () => {
    maybeSingle.mockResolvedValue({ data: { webhook_url: null } });
    const r = await notifyAgentEvent('a1', 'anchor_confirmed', 'anchored', {});
    expect(r).toEqual({ event: 'anchor_confirmed', delivered: false, reason: 'no_webhook' });
    expect(emitAuditEvent).not.toHaveBeenCalled();
  });

  it('subscribed to something else is not a failure and is NOT audited as a drop', async () => {
    // A webhook that deliberately did not ask for this event, recorded as a failed delivery,
    // is a non-event reported as a fault — the mirror of the bug the anchor ladder removed.
    maybeSingle.mockResolvedValue(agent({ webhook_events: ['score_event'] }));
    const r = await notifyAgentEvent('a1', 'anchor_confirmed', 'anchored', {});
    expect(r).toEqual({ event: 'anchor_confirmed', delivered: false, reason: 'not_subscribed' });
    expect(emitAuditEvent).not.toHaveBeenCalled();
  });

  it('a real transport failure IS audited', async () => {
    // 127.0.0.1:1 refuses immediately — a genuine delivery failure, not a policy skip.
    const r = await notifyAgentEvent('a1', 'anchor_confirmed', 'anchored', {});
    expect(r.delivered).toBe(false);
    expect((r as { reason: string }).reason).toBe('delivery_failed');
    expect(emitAuditEvent).toHaveBeenCalled();
  });

  it('a DB lookup failure yields no_webhook and never throws into the worker loop', async () => {
    maybeSingle.mockRejectedValue(new Error('supabase down'));
    await expect(notifyAgentEvent('a1', 'anchor_confirmed', 'x', {})).resolves.toEqual({
      event: 'anchor_confirmed', delivered: false, reason: 'no_webhook',
    });
  });
});

describe('over a real socket — the signature has to survive the wire', () => {
  let server: Server;
  const received: Array<{ body: string; sig: string | undefined }> = [];

  const listen = (): Promise<string> =>
    new Promise((resolve) => {
      server = createServer((req, res) => {
        let body = '';
        req.on('data', (c) => (body += c));
        req.on('end', () => {
          received.push({ body, sig: req.headers['x-webhook-signature'] as string | undefined });
          res.writeHead(200).end('ok');
        });
      }).listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${(server.address() as AddressInfo).port}/hook`));
    });

  afterAll(() => { server?.close(); });

  it('delivers a signed body a receiver can actually verify', async () => {
    const url = await listen();
    maybeSingle.mockResolvedValue(agent({ webhook_url: url }));

    const r = await notifyAgentEvent('agent-42', 'anchor_confirmed', 'Your RepID proof is now anchored on chain.', {
      eas_attestation_uid: '0xUID', tx_hash: '0xTX', network: 'base-sepolia', anchor_status: 'ANCHORED',
    });

    expect(r).toEqual({ event: 'anchor_confirmed', delivered: true, status: 200 });
    expect(received).toHaveLength(1);
    const { body, sig } = received[0]!;

    // The receiver's side of the contract, computed the way a receiver would.
    expect(sig).toBe(createHmac('sha256', 's3cret').update(body).digest('hex'));

    const parsed = JSON.parse(body);
    expect(parsed.agent_id).toBe('agent-42');
    expect(parsed.metadata.eas_attestation_uid).toBe('0xUID');
    expect(parsed.metadata.tx_hash).toBe('0xTX');
    // `event` must be INSIDE the signed body. A receiver that dispatches on the event name has to
    // be able to trust it, and a value carried outside the preimage can be rewritten in transit.
    expect(parsed.event).toBe('anchor_confirmed');
    expect(body).toContain('"event":"anchor_confirmed"');
  });
});
