# OpenClaw Voice Relay (Twilio + Cloudflare Tunnel)

This relay is the bridge between Twilio Voice and your local OpenClaw instance.

## What works right now
- ✅ Outbound call initiation via `POST /call/start`
- ✅ Twilio answers and connects the call to a Media Stream (WebSocket)
- ✅ Relay receives Twilio Media Stream events (scaffold logging)

## What is NOT implemented yet
- ⛔ Live STT/TTS + conversational loop (OpenAI realtime audio)

We’ll implement this next once the networking path (Twilio ⇄ tunnel ⇄ relay) is verified.

---

## Prereqs
- Node.js 18+
- A Twilio phone number with Voice enabled
- Cloudflare Tunnel (`cloudflared`) installed

## Environment variables
Set these as *User* env vars (recommended):

- `OPENAI_API_KEY` (already set)
- `TWILIO_ACCOUNT_SID`
- `TWILIO_AUTH_TOKEN`
- `TWILIO_FROM_NUMBER` (your Twilio voice-enabled number, in E.164)
- `PUBLIC_BASE_URL` (the HTTPS base URL Twilio will reach, e.g. `https://voice.yourdomain.com`)
- `ALLOWED_TO_NUMBERS` (comma-separated E.164 allowlist; start with your number)
- `VOICE_RELAY_PORT` (optional; default 8787)

## Install
```powershell
cd C:\Users\svenftw\.openclaw\workspace\voice-relay
npm install
```

## Run locally
```powershell
npm start
```

Health check:
```powershell
curl http://127.0.0.1:8787/health
```

## Cloudflare Tunnel (concept)
Expose the local relay to the internet so Twilio can reach it.

You can map a hostname to `http://localhost:8787`.

## Twilio configuration
Point your Twilio call URL (voice webhook) to:
- `POST https://<PUBLIC_BASE_URL>/twilio/voice`

Outbound call start:
- `POST https://<PUBLIC_BASE_URL>/call/start` with JSON: `{ "to": "+12029803543" }`

---

## Next step: add OpenAI realtime audio
Once the above pieces are confirmed, we’ll:
- connect Twilio WS audio → OpenAI realtime input
- get transcripts → feed OpenClaw agent
- synthesize TTS → send audio back to Twilio
