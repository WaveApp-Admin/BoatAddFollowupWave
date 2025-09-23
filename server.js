// server.js
require("dotenv").config();
const express = require("express");
const bodyParser = require("body-parser");
const { WebSocketServer } = require("ws");
const WebSocket = require("ws");
const twilio = require("twilio");
const fs = require("fs");

// ------------------------- APP SETUP -------------------------
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

// Load Lexi system prompt
let LEXI_PROMPT = "You are Lexi from The Wave App...";
try { LEXI_PROMPT = fs.readFileSync("./lexi-prompt.txt", "utf8"); } catch {}

// Audio / timing constants
const SAMPLE_RATE = 8000;        // Twilio = 8kHz
const FRAME_MS = 20;             // Twilio media frame = 20ms μ-law
const COMMIT_CHUNK_MS = 360;     // Commit to OpenAI roughly every 360ms
const HEARTBEAT_MS = 25000;      // Ping OpenAI WS only (not Twilio)

// ------------------------- UTIL -------------------------
const CLEAN_HOST = (PUBLIC_HOST || "")
  .replace(/^https?:\/\//, "")
  .replace(/\/$/, "");

function safeSend(ws, payload) {
  if (ws && ws.readyState === 1) ws.send(payload);
}

// ------------------------- HTTP ROUTES -------------------------
app.get("/healthz", (_, res) => res.json({ ok: true }));

// Kick off an outbound call
app.post("/dial", async (req, res) => {
  try {
    console.log("POST /dial payload:", req.body);
    const { to, leadId = "", callId = "" } = req.body;
    if (!to) return res.status(400).json({ error: "`to` (E.164) required" });

    const twimlUrl =
      `https://${CLEAN_HOST}/voice?leadId=${encodeURIComponent(leadId)}&callId=${encodeURIComponent(callId)}`;

    console.log("Using TwiML URL:", twimlUrl);

    const call = await twilioClient.calls.create({
      to,
      from: TWILIO_NUMBER,
      url: twimlUrl,
      method: "POST",
      // machineDetection: "Enable", // keep disabled while debugging
      statusCallback: `https://${CLEAN_HOST}/status`,
      statusCallbackMethod: "POST",
      statusCallbackEvent: ["initiated", "ringing", "answered", "completed"]
    });

    console.log("Call SID:", call.sid);
    res.status(201).json({ sid: call.sid });
  } catch (e) {
    console.error("Error in /dial:", e);
    res.status(500).json({ error: String(e) });
  }
});

app.post("/status", (req, res) => {
  const { CallSid, CallStatus, CallDuration, Timestamp, SequenceNumber } = req.body || {};
  console.log("Twilio STATUS:", { CallSid, CallStatus, CallDuration, Timestamp, SequenceNumber, body: req.body });
  res.sendStatus(204);
});

// Serve TwiML (bidirectional stream + metadata via <Parameter>)
function voiceHandler(req, res) {
  console.log("Twilio hit /voice", { method: req.method, query: req.query, body: req.body });
  const leadId = encodeURIComponent(req.query.leadId || "");
  const callId = encodeURIComponent(req.query.callId || "");

  const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Connect>
    <Stream url="wss://${CLEAN_HOST}/ws/twilio">
      <Parameter name="leadId" value="${leadId}"/>
      <Parameter name="callId" value="${callId}"/>
    </Stream>
  </Connect>
</Response>`;
  res.type("text/xml").send(twiml);
}
app.all("/voice", voiceHandler);

// ------------------------- SERVER + WS UPGRADE -------------------------
const server = app.listen(PORT || 8080, () =>
  console.log(`HTTP listening on ${PORT || 8080}`)
);

const wss = new WebSocketServer({ noServer: true });
server.on("upgrade", (req, socket, head) => {
  console.log("HTTP upgrade request for:", req.url);
  if (req.url && req.url.startsWith("/ws/twilio")) {
    wss.handleUpgrade(req, socket, head, (ws) => {
      console.log("WebSocket upgraded for /ws/twilio");
      wss.emit("connection", ws, req);
    });
  } else {
    socket.destroy();
  }
});

// ------------------------- Twilio <-> OpenAI BRIDGE -------------------------
wss.on("connection", (twilioWS, req) => {
  console.log("WS connection handler entered");

  // Realtime model (env override if desired)
  const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-realtime"; // or "gpt-4o-realtime-preview-2024-12-17"
  const oaiURL = `wss://api.openai.com/v1/realtime?model=${encodeURIComponent(OPENAI_MODEL)}`;
  const oaiWS = new WebSocket(oaiURL, {
    headers: {
      Authorization: `Bearer ${OPENAI_API_KEY}`,
      "OpenAI-Beta": "realtime=v1"
    }
  });

  // Better error visibility on handshake failures
  oaiWS.on("unexpected-response", (req2, res) => {
    console.error("OpenAI WS unexpected-response", res.statusCode, res.statusMessage);
    res.on("data", d => console.error("OpenAI WS body:", d.toString()));
  });

  // Per-call state
  let streamSid = null;
  let closed = false;

  let oaiReady = false;
  let greetingSent = false;
  let hasActiveResponse = false;  // prevent overlapping responses

  // For committing cadence
  let appendedMsSinceCommit = 0;

  const pendingOut = [];          // base64 μ-law audio chunks produced before streamSid exists

  function sendOrQueueToTwilio(b64) {
    if (!b64) return;
    if (!streamSid) {
      pendingOut.push(b64);
      return;
    }
    safeSend(twilioWS, JSON.stringify({
      event: "media",
      streamSid,
      media: { payload: b64 }
    }));
  }

  function drainPending() {
    while (pendingOut.length && streamSid) {
      sendOrQueueToTwilio(pendingOut.shift());
    }
  }

  function attemptGreet() {
    if (oaiReady && streamSid && !greetingSent && !hasActiveResponse) {
      greetingSent = true;
      hasActiveResponse = true;
      console.log("Sending greeting");
      safeSend(oaiWS, JSON.stringify({
        type: "response.create",
        response: {
          modalities: ["audio","text"],
          // keep this opener ultra short & barge-in friendly
          instructions: "Hi! This is Lexi with The Wave App — quick question: do you have the app open?"
        }
      }));
    }
  }

  // ---- DIAGNOSTICS / SAFETY
  twilioWS.on("error", (e) => console.error("Twilio WS error:", e));
  oaiWS.on("error",   (e) => console.error("OpenAI WS error:", e));
  oaiWS.on("close", (code, reason) => console.log("OpenAI WS closed:", code, reason?.toString()));

  // ----------------- OPENAI -> TWILIO (assistant speech) -----------------
  oaiWS.on("message", (raw) => {
    let evt;
    try { evt = JSON.parse(raw.toString()); } catch { return; }

    // Accept all current audio delta names
    if (
      evt?.type === "response.audio.delta" ||
      evt?.type === "response.output_audio.delta" ||
      evt?.type === "output_audio_chunk.delta"
    ) {
      const b64 = evt.delta || evt.audio || null; // base64 g711_ulaw after session config
      if (b64) {
        if (!oaiWS._firstDeltaLogged) {
          console.log("Got model audio delta, bytes(base64):", b64.length);
          oaiWS._firstDeltaLogged = true;
        }
        sendOrQueueToTwilio(b64);
      }
    }

    if (evt?.type === "response.created") {
      hasActiveResponse = true;
    }
    if (evt?.type === "response.completed") {
      hasActiveResponse = false;
      safeSend(twilioWS, JSON.stringify({
        event: "mark",
        streamSid,
        mark: { name: `lexi_done_${Date.now()}` }
      }));
    }

    // When model detects the caller speaking, pre-empt playback
    if (evt?.type === "input_audio_buffer.speech_started") {
      safeSend(twilioWS, JSON.stringify({ event: "clear", streamSid }));
    }

    if (evt?.type === "error") {
      console.error("OpenAI server error event:", evt);
    }
  });

  // ----------------- OPENAI SESSION CONFIG -----------------
  oaiWS.on("open", () => {
    console.log("OpenAI WS opened");
    oaiReady = true;

    // IMPORTANT:
    // - input_audio_format: Twilio sends G.711 μ-law @ 8k -> stream frames directly (no decode)
    // - output_audio_format: also μ-law @ 8k -> pass straight back to Twilio
    // - voice: choose a female-sounding voice (e.g., shimmer)
    safeSend(oaiWS, JSON.stringify({
      type: "session.update",
      session: {
        // Nudge that prevents "Hi Lexi" / third-person weirdness
        instructions:
          LEXI_PROMPT +
          "\n\nBehavior rules (do not read aloud): You are Lexi, speaking in first person. Never say 'Hi Lexi' or refer to yourself in third-person. Keep the first turn under 2 seconds and end with a single question.",
        modalities: ["audio", "text"],
        voice: "shimmer",
        input_audio_format:  "g711_ulaw",
        output_audio_format: "g711_ulaw",
        turn_detection: { type: "server_vad", threshold: 0.45 }
      }
    }));

    attemptGreet();
  });

  // ----------------- TWILIO -> OPENAI (caller audio) -----------------
  function commitIfReady(force = false) {
    if (force || appendedMsSinceCommit >= COMMIT_CHUNK_MS) {
      appendedMsSinceCommit = 0;
      safeSend(oaiWS, JSON.stringify({ type: "input_audio_buffer.commit" }));
      if (!hasActiveResponse) {
        hasActiveResponse = true;
        safeSend(oaiWS, JSON.stringify({
          type: "response.create",
          response: { modalities: ["audio","text"] }
        }));
      }
    }
  }

  twilioWS.on("message", (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }

    if (msg.event === "start") {
      streamSid = msg.start?.streamSid || null;

      // Metadata from <Parameter>
      const params = msg.start?.customParameters || {};
      const leadIdFromTwilio = params.leadId || "";
      const callIdFromTwilio = params.callId || "";

      console.log("Twilio stream started", { streamSid, leadIdFromTwilio, callIdFromTwilio });

      // Attach metadata
      safeSend(oaiWS, JSON.stringify({
        type: "session.update",
        session: { metadata: { leadId: leadIdFromTwilio, callId: callIdFromTwilio } }
      }));

      drainPending();
      attemptGreet();
      return;
    }

    if (msg.event === "stop") {
      console.log("Twilio stream stopped");
      // Finalize any partial chunk
      commitIfReady(true);
      return;
    }

    if (msg.event === "media" && msg.media?.payload) {
      // Twilio -> μ-law/8k base64; with input_audio_format="g711_ulaw" we can append directly
      safeSend(oaiWS, JSON.stringify({
        type: "input_audio_buffer.append",
        audio: msg.media.payload // base64 μ-law bytes
      }));
      appendedMsSinceCommit += FRAME_MS;

      // Commit at cadence (no silence detection needed while we debug)
      if (appendedMsSinceCommit >= COMMIT_CHUNK_MS) {
        commitIfReady(true);
      }
    }
  });

  // ----------------- KEEPALIVE & CLEANUP -----------------
  const heartbeat = setInterval(() => {
    try { if (oaiWS.readyState === 1) oaiWS.ping(); } catch {}
  }, HEARTBEAT_MS);

  function closeAll() {
    if (closed) return;
    closed = true;
    clearInterval(heartbeat);
    try { commitIfReady(true); } catch {}
    try { twilioWS.close(); } catch {}
    try { oaiWS.close(); } catch {}
  }

  twilioWS.on("close", closeAll);
  twilioWS.on("error", (e) => { console.error("Twilio WS error:", e); closeAll(); });
  oaiWS.on("close", closeAll);
  oaiWS.on("error", (e) => { console.error("OpenAI WS error:", e); });
});
