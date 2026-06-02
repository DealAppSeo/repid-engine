import express from 'express';
import { createClient } from '@supabase/supabase-js';
import { handleHitlCallback } from '../services/hitl-callback-handler';
const router = express.Router();

const supabase = createClient(
  process.env.SUPABASE_URL || 'http://localhost:54321',
  process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY || 'dummy-key'
);

export async function sendTelegramAlert(message: string) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) return;
  try {
    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text: message, parse_mode: 'HTML' })
    });
  } catch(e) { console.error('Telegram alert failed:', e); }
}

// Like sendTelegramAlert but per-call chat_id + returns the Telegram message_id so
// callers can store it for later round-trip correlation (V1.6 approve/deny on the
// notification dispatcher path). Additive — does not affect sendTelegramAlert.
export interface TelegramInlineKeyboard {
  inline_keyboard: Array<Array<{ text: string; callback_data: string }>>;
}

export async function sendTelegramMessage(
  chatId: string,
  html: string,
  inlineKeyboard?: TelegramInlineKeyboard,
): Promise<{ ok: boolean; message_id?: number; error?: string }> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) return { ok: false, error: 'TELEGRAM_BOT_TOKEN not configured' };
  const body: Record<string, any> = {
    chat_id: chatId,
    text: html,
    parse_mode: 'HTML',
    disable_web_page_preview: true,
  };
  if (inlineKeyboard) body.reply_markup = inlineKeyboard;
  try {
    const r = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const j: any = await r.json().catch(() => ({}));
    if (!r.ok || !j.ok) {
      return { ok: false, error: `tg ${r.status}: ${JSON.stringify(j).slice(0, 200)}` };
    }
    return { ok: true, message_id: j.result?.message_id };
  } catch (e: any) {
    return { ok: false, error: `network: ${e.message ?? String(e)}` };
  }
}

router.post('/webhook', async (req, res) => {
  // V1.6 (CC2 2026-05-27): X-Telegram-Bot-Api-Secret-Token check — applies to ALL
  // update types. If TELEGRAM_WEBHOOK_SECRET is set, Telegram must echo the same
  // string in this header (configured via setWebhook → secret_token). Unset env =
  // backwards-compatible (skip check) so existing message commands keep working
  // until Sean opts in. When Sean SETS the env, he must ALSO re-run /set-webhook
  // so Telegram starts sending the header (the GET handler picks it up automatically).
  const expectedSecret = process.env.TELEGRAM_WEBHOOK_SECRET;
  if (expectedSecret) {
    const provided = req.headers['x-telegram-bot-api-secret-token'];
    if (provided !== expectedSecret) {
      return res.sendStatus(401);
    }
  }

  // V1.6: callback_query branch (additive) — handles HITL approve/deny button taps.
  // Slice-1 dispatcher only attaches inline keyboards when HITL_CALLBACK_ENABLED='true'
  // AND HITL_CALLBACK_HMAC_SECRET is set, so this branch is dormant by default.
  if ((req.body as any)?.callback_query) {
    return handleHitlCallback(req, res);
  }

  const { message } = req.body;
  if (!message?.text) return res.sendStatus(200);
  const chatId = message.chat.id;
  const text = message.text.toLowerCase().trim();
  let reply = '';

  try {
    if (text === '/status' || text === '/s') {
      const { data } = await supabase
        .from('repid_agents')
        .select('agent_name,current_repid,tier,vdr_count')
        .order('current_repid', { ascending: false })
        .limit(6);
      const vdr = (await supabase.from('repid_agents').select('vdr_count'))
        .data?.reduce((s,a)=>s+(a.vdr_count||0),0) || 0;
      reply = `🤖 <b>TRINITY SYMPHONY</b>\n`
        + `VDR: ${vdr} | Decisions: 264\n\n`
        + (data||[]).map(a=>
          `${(a.tier==='AUTONOMOUS'||a.tier==='VETERAN')?'🔵':a.tier==='ESTABLISHED'?'🟡':'⚪'} `
          +`${a.agent_name}: ${a.current_repid} RepID`
        ).join('\n');
    }
    else if (text === '/health' || text === '/h') {
      const health = await supabase.rpc('daily_system_health_check');
      const alerts = (health.data||[]).filter((r:any)=>r.action_required);
      reply = alerts.length === 0
        ? '✅ <b>ALL SYSTEMS OK</b>\nHAL thresholds intact\nNo stalled tasks\nVDR consistent'
        : '⚠️ <b>ALERTS</b>\n'
          + alerts.map((a:any)=>`❌ ${a.check_name}: ${a.detail}`).join('\n');
    }
    else if (text === '/hal') {
      const { data } = await supabase
        .from('repid_score_events')
        .select('hal_score,hallucination_caught,task_domain,created_at')
        .order('created_at', { ascending: false })
        .limit(5);
      const caught = (await supabase.from('repid_score_events')
        .select('id',{count:'exact'}).eq('hallucination_caught',true)).count||0;
      reply = `🛡️ <b>HAL STATUS</b>\nTotal caught: ${caught}\n\n`
        + (data||[]).map(e=>
          `${e.hallucination_caught?'🚨':'✅'} [${e.task_domain}] `
          +`score: ${(e.hal_score||0).toFixed(3)}`
        ).join('\n');
    }
    else if (text === '/tasks' || text === '/t') {
      const { data } = await supabase
        .from('trinity_tasks')
        .select('title,agent_assigned,status')
        .eq('status','pending')
        .order('priority', { ascending: true })
        .limit(8);
      reply = data?.length
        ? `📋 <b>PENDING TASKS (${data.length})</b>\n`
          + data.map(t=>`• ${t.agent_assigned||'unassigned'}: `
            +`${t.title.substring(0,45)}`).join('\n')
        : '📋 No pending tasks — agents need new work';
    }
    else if (text === '/chain') {
      const { data } = await supabase
        .from('repid_agents')
        .select('agent_name,current_repid,erc8004_address')
        .in('agent_name',['SOPHIA','GUARDIAN','TORCH','GCM']);
      reply = `⛓️ <b>ON-CHAIN AGENTS (Base Sepolia)</b>\n`
        + (data||[]).map(a=>
          `${a.agent_name} (${a.current_repid})\n`
          +`<code>${a.erc8004_address?.substring(0,20)}...</code>`
        ).join('\n');
    }
    else if (text === '/vdr') {
      const { data } = await supabase
        .from('repid_agents')
        .select('agent_name,vdr_count,current_repid')
        .order('vdr_count', { ascending: false })
        .limit(8);
      reply = `📊 <b>VDR LEADERBOARD</b>\n`
        + (data||[]).map(a=>
          `${a.agent_name}: ${a.vdr_count} VDR (RepID ${a.current_repid})`
        ).join('\n');
    }
    else if (text === '/proof') {
      const { data } = await supabase
        .from('repid_proof_queue')
        .select('status')
      const counts = (data||[]).reduce((acc:any,r:any)=>{
        acc[r.status]=(acc[r.status]||0)+1; return acc;
      },{});
      reply = `🔐 <b>PROOF QUEUE</b>\n`
        + Object.entries(counts).map(([k,v])=>`${k}: ${v}`).join('\n');
    }
    else {
      reply = `🤖 <b>Trinity Symphony Commands</b>\n`
        + `/status — agent leaderboard\n`
        + `/health — system health check\n`
        + `/hal — HAL veto status\n`
        + `/tasks — pending task queue\n`
        + `/chain — on-chain agents\n`
        + `/vdr — VDR leaderboard\n`
        + `/proof — proof queue status`;
    }
  } catch(e:any) {
    reply = '❌ Error: ' + e.message;
  }

  await fetch(
    `https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendMessage`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text: reply, parse_mode: 'HTML' })
    }
  );
  res.sendStatus(200);
});

router.get('/set-webhook', async (req, res) => {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  // V1.6: include secret_token if TELEGRAM_WEBHOOK_SECRET is set so Telegram
  // echoes it in the X-Telegram-Bot-Api-Secret-Token header. Backwards-compatible:
  // if env unset, setWebhook omits secret_token (existing behavior).
  const webhookSecret = process.env.TELEGRAM_WEBHOOK_SECRET;
  try {
    const body: Record<string, any> = {
      url: 'https://repid-engine-production.up.railway.app/api/v1/telegram/webhook',
      allowed_updates: ['message', 'callback_query'],
    };
    if (webhookSecret) body.secret_token = webhookSecret;
    const r = await fetch(`https://api.telegram.org/bot${token}/setWebhook`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    const d = await r.json();
    res.json({ ...d, with_secret_token: !!webhookSecret });
  } catch (e: any) {
    res.json({ error: e.message });
  }
});

router.get('/metrics', async (req, res) => {
  const [agents, decisions, hallucinations] = await Promise.all([
    supabase.from('repid_agents').select('id,vdr_count'),
    supabase.from('repid_score_events').select('id,llm_provider').not('llm_provider','is',null),
    supabase.from('repid_score_events').select('id').eq('hallucination_caught',true)
  ]);
  const vdr = (agents.data||[]).reduce((s,a)=>s+(a.vdr_count||0),0);
  const providers = new Set((decisions.data||[]).map(d=>d.llm_provider)).size;
  res.json({
    agents: agents.data?.length||0,
    vdr, decisions: decisions.data?.length||0,
    providers, hallucinations: hallucinations.data?.length||0,
    staking_contract: '0xd35331Bf94b1A4F4CAf595951056C288ce58C4fA',
    identity_registry: '0x8004A818BFB912233c491871b3d84c89A494BD9e',
    hal_approval_rate: 99.4
  });
});

export default router;
