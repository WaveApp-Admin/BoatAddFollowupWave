# Wave Voice Agent (Lexi)

A minimal **Twilio ↔ OpenAI Realtime** bridge so **Lexi** (your Wave follow-up agent) can place/receive calls and talk in real-time.  
Optionally, Lexi can **book a 10-minute demo call** and send calendar invites via **Microsoft Graph**.

---

## What this service does

- `POST /dial` – tells Twilio to place a call to a phone number.
- `POST /voice` – returns TwiML that opens a **Twilio Media Stream** to this server.
- `wss://…/ws/twilio` – bridges caller audio ↔ OpenAI Realtime (streaming both ways).
- `POST /schedule-demo-graph` – (optional) sends **Outlook/Teams** calendar invites using Microsoft Graph.
- `GET /healthz` – health check.
- **Prompt** – you control Lexi’s behavior in `lexi-prompt.txt`.

> The booking flow is triggered by a **silent control tag** the model outputs after the caller confirms:
>
> ```
> [[BOOK_DEMO name="First" email="user@example.com" start="YYYY-MM-DDTHH:mm:ss"]]
> ```
> The server detects the tag and calls `/schedule-demo-graph`.

---

## Prerequisites

- **Node.js 18+**
- **Twilio**: account + a **Voice-enabled** phone number
- **OpenAI**: API key with access to a Realtime model (e.g. `gpt-realtime`)
- (Local testing) **ngrok** or similar tunnel
- (Optional, for invites) **Microsoft 365** mailbox + **Azure App Registration**
  - Graph **Application permission**: `Calendars.ReadWrite`
  - Admin consent granted
  - Organizer mailbox (e.g., `info@yourdomain.com`) must be **licensed** to send/own events

---

## Environment Variables

Copy and edit:

```bash
cp .env.example .env
# fill in real values ONLY in .env (do not commit secrets)
