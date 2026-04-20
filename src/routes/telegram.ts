import express from 'express';
import { createClient } from '@supabase/supabase-js';
const router = express.Router();

const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
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

router.post('/webhook', async (req, res) => {
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
          `${a.tier==='AUTONOMOUS'?'🔵':a.tier==='EARNING_AUTONOMY'?'🟡':'⚪'} `
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

export default router;
