/**
 * B8 — the PUBLIC phone door: a Telegram bot a stranger can message to check a claim.
 *
 * NOT THE OPERATOR BOT. `src/routes/telegram.ts` serves /api/v1/telegram with TELEGRAM_BOT_TOKEN,
 * and that bot carries /wake, /sleep and HITL approval buttons (B7, confirmed by Grok
 * 2026-10-04). A stranger must never share a bot with those commands, so this door is a separate
 * bot, a separate route and a separate token: TELEGRAM_PUBLIC_BOT_TOKEN. This file never reads
 * TELEGRAM_BOT_TOKEN (pinned by tests/telegram-public.test.ts).
 *
 * WHAT IT DOES. One box: paste a claim, get pass | veto | not-checked from the SAME function the
 * route POST /api/v1/classify uses (`classifyText`), with the privacy line on the first screen.
 * Nothing else: no commands that touch state, no scoring, no storage.
 *
 * INERT UNTIL SEAN SETS ONE VARIABLE. With no TELEGRAM_PUBLIC_BOT_TOKEN the webhook answers 200
 * and makes no call at all, and boot registers nothing. With it set, boot registers the webhook
 * with Telegram once, using a secret derived from the token (so there is no second variable to
 * forget), and Telegram must present that secret on every update.
 *
 * WHAT LEAVES. The claim goes to the classify voters (Groq) and the reply goes back through
 * Telegram. Stored: nothing. The per-chat rate limit is in memory and holds chat ids for one
 * minute only.
 */
import { createHash } from 'node:crypto';
import { Router, json, type Request, type Response } from 'express';
import { classifyText, type ClassifyLabel } from './classify';

export const PUBLIC_WEBHOOK_PATH = '/api/v1/telegram-public/webhook';
const PRODUCTION_BASE = 'https://repid-engine-production.up.railway.app';
const PER_CHAT_PER_MINUTE = 10;
const MAX_CLAIM_CHARS = 1500;

export const PRIVACY_LINE = 'Your text is sent to our checker, Groq, and passes through Telegram. We store nothing.';

export const WELCOME = [
  'Paste one claim and I will check it.',
  '',
  'You get one of three answers:',
  'PASS — two independent checks agree it is true.',
  'VETO — caught: two independent checks agree it is false.',
  'NOT CHECKED — I could not verify it (an opinion, a prediction, too long, or the checks disagreed). Not checked is not the same as true.',
  '',
  PRIVACY_LINE,
].join('\n');

export function replyFor(label: ClassifyLabel): string {
  if (label === 'pass') return 'PASS — two independent checks agree this is true.';
  if (label === 'veto') return 'VETO — Caught. This did not pass: two independent checks agree it is false.';
  return 'NOT CHECKED — I could not verify this. Not checked is not the same as true.';
}

function publicToken(env: NodeJS.ProcessEnv = process.env): string {
  return (env.TELEGRAM_PUBLIC_BOT_TOKEN ?? '').trim();
}

/** Telegram's secret_token: 1-256 chars of A-Z a-z 0-9 _ -. Derived, so it needs no variable. */
export function webhookSecret(token: string): string {
  return createHash('sha256').update(`trustshell-public-door:${token}`).digest('hex');
}

async function send(token: string, chatId: number, text: string): Promise<void> {
  try {
    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text, disable_web_page_preview: true }),
      signal: AbortSignal.timeout(5000),
    });
  } catch {
    // A failed reply is lost, never retried into a loop; Telegram users can resend.
  }
}

const recent = new Map<number, number[]>();

/** Test hook. */
export function __resetPublicDoorLimits(): void {
  recent.clear();
}

function overLimit(chatId: number, now: number): boolean {
  const kept = (recent.get(chatId) ?? []).filter((t) => now - t < 60_000);
  if (kept.length >= PER_CHAT_PER_MINUTE) {
    recent.set(chatId, kept);
    return true;
  }
  kept.push(now);
  recent.set(chatId, kept);
  return false;
}

interface Update {
  message?: { chat?: { id?: unknown; type?: unknown }; text?: unknown };
}

export function createTelegramPublicRouter(): Router {
  const router = Router();
  router.post('/webhook', json({ limit: '64kb' }), async (req: Request, res: Response): Promise<void> => {
    const token = publicToken();
    // Answer Telegram first and fast; a non-200 makes it retry the same update.
    if (!token) {
      res.status(200).json({ ok: true, inert: true });
      return;
    }
    if (req.get('x-telegram-bot-api-secret-token') !== webhookSecret(token)) {
      res.status(403).json({ ok: false });
      return;
    }
    res.status(200).json({ ok: true });

    const msg = (req.body as Update | undefined)?.message;
    const chatId = msg?.chat?.id;
    if (typeof chatId !== 'number' || msg?.chat?.type !== 'private') return;
    const text = typeof msg?.text === 'string' ? msg.text.trim() : '';
    if (!text) return;
    if (text === '/start' || text === '/help' || text === '/privacy') {
      await send(token, chatId, WELCOME);
      return;
    }
    if (overLimit(chatId, Date.now())) {
      await send(token, chatId, 'Slow down: up to 10 checks a minute. Try again shortly.');
      return;
    }
    if (text.length > MAX_CLAIM_CHARS) {
      await send(token, chatId, `${replyFor('not-checked')} (Send one claim, under ${MAX_CLAIM_CHARS} characters.)`);
      return;
    }
    let label: ClassifyLabel = 'not-checked';
    try {
      label = await classifyText(text);
    } catch {
      label = 'not-checked';
    }
    await send(token, chatId, replyFor(label));
  });
  return router;
}

/**
 * Registers the webhook with Telegram once at boot, only when the token is set. Idempotent on
 * Telegram's side. TELEGRAM_PUBLIC_WEBHOOK_BASE overrides the host for a staging deploy.
 */
export async function registerPublicWebhook(env: NodeJS.ProcessEnv = process.env): Promise<'inert' | 'ok' | 'failed'> {
  const token = publicToken(env);
  if (!token) return 'inert';
  const base = (env.TELEGRAM_PUBLIC_WEBHOOK_BASE ?? '').trim() || PRODUCTION_BASE;
  try {
    const r = await fetch(`https://api.telegram.org/bot${token}/setWebhook`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        url: `${base}${PUBLIC_WEBHOOK_PATH}`,
        secret_token: webhookSecret(token),
        allowed_updates: ['message'],
        drop_pending_updates: true,
      }),
      signal: AbortSignal.timeout(10_000),
    });
    const body = (await r.json().catch(() => ({}))) as { ok?: boolean };
    return r.ok && body.ok === true ? 'ok' : 'failed';
  } catch {
    return 'failed';
  }
}

export default createTelegramPublicRouter();
