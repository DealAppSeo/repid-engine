# B7 — the one live Telegram bot

Measured 2026-10-04 from the tree at `4ed45cdec3645ca5b22833b29b73a3cda3bb37b7` and one HTTP probe.
Railway logs: NOT CHECKED from this session (no log reader attached). Vercel controller-pwa: NOT CHECKED here; CC2's bus note says no such project.

## Result: VERIFIED operator, not the public door

The live webhook the code points at is the operator bot.

- URL: `https://repid-engine-production.up.railway.app/api/v1/telegram/webhook`
- Sha of the file that hardcodes that URL: `6335ae9b2a192b27b854c6e934cc41ef0f590f64` (`src/routes/telegram.ts`)
- Tree sha read: `4ed45cdec3645ca5b22833b29b73a3cda3bb37b7`
- Commands in that handler: `/wake`, `/sleep`, `/status`, `/health`, `/hal`, `/tasks`, `/chain`, `/vdr`, `/proof`. HITL callbacks go to `handleHitlCallback`.
- Token env: `TELEGRAM_BOT_TOKEN`. Not `TELEGRAM_PUBLIC_BOT_TOKEN`.
- `GET /api/v1/telegram` on that host returned 401. The set-webhook handler is `GET /api/v1/telegram/set-webhook` and writes the URL above. Probe did not call set-webhook.
- `DealAppSeo/trinity-telegram-bot` was already recorded empty on the bus. This probe did not re-list it.

This is not the public phone door. B8 must be a separate handler behind `TELEGRAM_PUBLIC_BOT_TOKEN`. Do not point a stranger at `/wake`.
