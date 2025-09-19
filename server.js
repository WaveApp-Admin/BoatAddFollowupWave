\
require("dotenv").config();
const express = require("express");
const bodyParser = require("body-parser");
const { WebSocketServer } = require("ws");
const WebSocket = require("ws");
const twilio = require("twilio");
const fs = require("fs");

const app = express();
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: false }));

const {
  TWILIO_ACCOUNT_SID,
  TWILIO_AUTH_TOKEN,
  TWILIO_NUMBER,
  OPENAI_API_KEY,
  PUBLIC_HOST,
  PORT
} = process.env;

if (!OPENAI_API_KEY) console.warn("WARN: OPENAI_API_KEY is not set");
if (!TWILIO_ACCOUNT_SID || !TWILIO_AUTH_TOKEN || !TWILIO_NUMBER) {
  console.warn("WARN: Twilio credentials are not fully set");
}

const twilioClient = twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);
const LEXI_PROMPT = fs.readFileSync("./lexi-prompt.txt", "utf8");

// Health check
app.get("/healthz", (_, res) => res.json({ ok: true }));

// 1) Trigger an outbound call: POST /dial { "to": "+1...", "leadId":"123", "callId":"abc" }
app.post("/dial", async (req, res) => {
  try {
    const { to, leadId = "", callId = "" } = req.body;
    if (!to) return res.status(400).json({ error: "`to` (E.164) required" });

    const twimlUrl = `https://${PUBLIC_HOST}/voice?leadId=${encodeURIComponent(
      leadId
    )}&callId=${encodeURIComponent(callId)}`;

    const call = await twilioClient.calls.create({
      to,
      from: TWILIO_NUMBER,
      url: twimlUrl,
      machineDetection: "Enable" // optional: helps avoid talking to voicemail
    });
    res.json({ sid: call.sid });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: String(e) });
  }
});

// 2) Twilio hits this after dialing. We return TwiML telling it to open a WS stream to us.
app.post("/voice", (req, res) => {
  const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Connect>
    <Stream url="wss://${PUBLIC_HOST}/ws/twilio"/>
  </Connect>
</Response>`;
  res.type("text/xml").send(twiml);
});

// 3) Start HTTP server, then attach a WS server for /ws/twilio
const server = app.listen(PORT || 8080, () =>
  console.log(`HTTP listening on ${PORT || 8080}`)
);

const wss = new WebSocketServer({ noServer: true });
server.on("upgrade", (req, socket, head) => {
  if (req.url.startsWith("/ws/twilio")) {
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
  } else {
    socket.destroy();
  }
});

// 4) Bridge: Twilio <-> OpenAI Realtime
wss.on("connection", (twilioWS, req) => {
  const oaiWS = new WebSocket(
    "wss://api.openai.com/v1/realtime?model=gpt-4o-realtime",
    { headers: { Authorization: `Bearer ${OPENAI_API_KEY}` } }
  );

  oaiWS.on("open", () => {
    // Pass Lexi’s prompt + metadata (lead/call IDs) into the Realtime session
    let leadId = "", callId = "";
    try {
      const url = new URL(`https://${PUBLIC_HOST}${req.url}`);
      leadId = url.searchParams.get("leadId") || "";
      callId = url.searchParams.get("callId") || "";
    } catch {}

    oaiWS.send(JSON.stringify({
      type: "session.update",
      session: {
        instructions: LEXI_PROMPT,
        modalities: ["audio", "text"],
        voice: "alloy",
        metadata: { leadId, callId }
      }
    }));
  });

  // Relay frames both directions
  twilioWS.on("message", (data) => {
    if (oaiWS.readyState === 1) oaiWS.send(data);
  });
  oaiWS.on("message", (data) => {
    if (twilioWS.readyState === 1) twilioWS.send(data);
  });

  // Keep-alive and cleanup
  const heartbeat = setInterval(() => {
    try {
      if (twilioWS.readyState === 1) twilioWS.ping();
      if (oaiWS.readyState === 1) oaiWS.ping();
    } catch {}
  }, 25000);

  const closeAll = () => {
    clearInterval(heartbeat);
    try { twilioWS.close(); } catch {}
    try { oaiWS.close(); } catch {}
  };

  twilioWS.on("close", closeAll);
  twilioWS.on("error", closeAll);
  oaiWS.on("close", closeAll);
  oaiWS.on("error", closeAll);
});
