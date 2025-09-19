# Wave Voice Agent (Lexi)

A minimal Twilio ↔ OpenAI Realtime bridge so **Lexi** (your Wave follow-up agent) can place/receive calls and talk in real-time.

## What this does
- `/dial` tells Twilio to place a call to a phone number
- `/voice` returns TwiML that opens a media **WebSocket** from Twilio to your server
- `/ws/twilio` bridges that audio to **OpenAI Realtime**, relaying audio both ways
- You drop your **Lexi prompt** in `lexi-prompt.txt`

## Prereqs
- Node.js 18+
- Twilio account + a Voice-enabled number
- OpenAI API key
- (Local testing) ngrok

## Quick Start (local)
```bash
cp .env.example .env
# fill in your real keys/secrets in .env

npm install
npm run start   # or: npm run dev
```

In another terminal, expose locally:
```bash
ngrok http 8080
```

Update `.env` -> `PUBLIC_HOST=<your_ngrok_host>` (no https://). Restart `npm run start` so it picks up the change.

Place a test call:
```bash
curl -X POST https://<your_ngrok_host>/dial   -H "Content-Type: application/json"   -d '{"to":"+1YOURCELLPHONE","leadId":"test-lead-1","callId":"call-001"}'
```

Answer the call—Lexi should talk and listen.

## Deploy to Render
- Create a new **Web Service** from this repo
- Add env vars from `.env.example`
- Set `PUBLIC_HOST` to your Render hostname (without https://)
- `render.yaml` is included for convenience

## Endpoints
- `POST /dial` → `{ "to": "+1...", "leadId": "123", "callId": "abc" }`
- `POST /voice` → TwiML for Twilio (used automatically during call setup)
- `GET /healthz` → simple health check
- `wss://.../ws/twilio` → Twilio Media Stream WebSocket (opened by Twilio)

## Notes
- Keep `/ws/twilio` behind TLS (wss://) in production
- Do **not** modify the audio frames; just relay them
- Replace the prompt in `lexi-prompt.txt` to adjust Lexi's behavior
