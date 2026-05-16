import { db } from '../db';

export async function renderCardHtml(cardId: string): Promise<string | null> {
  const { data: card, error } = await db.from('zkp_cards').select('*').eq('card_id', cardId).maybeSingle();
  if (error || !card) return null;

  const html = `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Trinity Swarm ZKP Proof Card</title>
  <meta property="og:title" content="Verified Action by ${card.agent_name}">
  <meta property="og:description" content="Event: ${card.event_type} | RepID: ${card.agent_repid}">
  <style>
    body {
      font-family: 'Inter', -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      background-color: #0f172a;
      color: #f8fafc;
      display: flex;
      justify-content: center;
      align-items: center;
      height: 100vh;
      margin: 0;
    }
    .card {
      background: linear-gradient(145deg, #1e293b, #0f172a);
      border: 1px solid #334155;
      border-radius: 16px;
      padding: 32px;
      max-width: 500px;
      width: 100%;
      box-shadow: 0 10px 25px rgba(0, 0, 0, 0.5);
    }
    .header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      border-bottom: 1px solid #334155;
      padding-bottom: 16px;
      margin-bottom: 24px;
    }
    .agent-name {
      font-size: 24px;
      font-weight: 700;
      color: #38bdf8;
    }
    .repid {
      font-size: 18px;
      font-weight: 600;
      background-color: #0284c7;
      padding: 4px 12px;
      border-radius: 20px;
    }
    .content-row {
      margin-bottom: 16px;
    }
    .label {
      font-size: 12px;
      color: #94a3b8;
      text-transform: uppercase;
      letter-spacing: 0.05em;
      margin-bottom: 4px;
    }
    .value {
      font-size: 16px;
      word-break: break-all;
    }
    .proof-hash {
      font-family: monospace;
      color: #10b981;
      background-color: #064e3b;
      padding: 8px;
      border-radius: 4px;
      font-size: 14px;
    }
    .verify-btn {
      display: block;
      width: 100%;
      padding: 12px;
      margin-top: 32px;
      background-color: #2563eb;
      color: white;
      text-align: center;
      text-decoration: none;
      border-radius: 8px;
      font-weight: 600;
      transition: background-color 0.2s;
    }
    .verify-btn:hover {
      background-color: #1d4ed8;
    }
  </style>
</head>
<body>
  <div class="card">
    <div class="header">
      <div class="agent-name">${card.agent_name}</div>
      <div class="repid">RepID: ${card.agent_repid}</div>
    </div>
    <div class="content-row">
      <div class="label">Event Type</div>
      <div class="value">${card.event_type}</div>
    </div>
    ${card.task_title ? `
    <div class="content-row">
      <div class="label">Task</div>
      <div class="value">${card.task_title}</div>
    </div>
    ` : ''}
    <div class="content-row">
      <div class="label">ZKP Proof Hash</div>
      <div class="value proof-hash">${card.zkp_proof_hash}</div>
    </div>
    <div class="content-row">
      <div class="label">Timestamp</div>
      <div class="value">${new Date(card.card_created_at).toLocaleString()}</div>
    </div>
    <a href="${card.verification_url}" class="verify-btn" target="_blank">Verify on TrustShell</a>
  </div>
</body>
</html>
  `;
  return html;
}
