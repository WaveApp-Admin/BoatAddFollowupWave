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

// Load Lexi system prompt (source of truth)
let LEXI_PROMPT = "You are Lexi from The Wave App...";
try { LEXI_PROMPT = fs.readFileSync("./lexi-prompt.txt", "utf8"); } catch {}

// Audio / timing constants
const SAMPLE_RATE = 8000;        // Twilio = 8kHz
const FRAME_MS = 20;             // Twilio media frame = 20ms μ-law
const COMMIT_CHUNK_MS = 300;     // Commit caller audio roughly every 300ms
const HEARTBEAT_MS = 25000;      // Ping OpenAI WS only (not Twilio)

// ------------------------- UTIL -------------------------
const CLEAN_HOST = (PUBLIC_HOST || "")
  .replace(/^https?:\/\//, "")
  .replace(/\/$/, "");

function safeSend(ws, payload) {
  if (ws && ws.readyState === 1) ws.send(payload);
}

// μ-law decode -> PCM16 (for Twilio -> OpenAI)
function mulawDecode(u8) {
  const out = new Int16Array(u8.length);
  for (let i = 0; i < u8.length; i++) {
    let u = u8[i] ^ 0xff;
    let t = ((u & 0x0f) << 3) + 0x84;
    t <<= (u & 0x70) >> 4;
    out[i] = (u & 0x80) ? (0x84 - t) : (t - 0x84);
  }
  // return as Uint8Array bytes of little-endian PCM16
  return new Uint8Array(new DataView(out.buffer).buffer);
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
      // machineDetection: "Enable", // keep disabled while tuning latency/UX
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
  let lastResponseId = null;      // for barge-in cancellation

  // For committing cadence
  let appendedMsSinceCommit = 0;
  let framesSinceCommit = 0;      // 1 frame ≈ 20ms

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

  // Natural, Playground-style opener (no "Hi Lexi", no "open the app")
  function attemptGreet() {
    if (oaiReady && streamSid && !greetingSent && !hasActiveResponse) {
      greetingSent = true;
      hasActiveResponse = true;
      console.log("Sending greeting");
      const FIRST_TURN =
        "Warm, casual opener in first person. Use 1–2 short sentences (≤20 words total). " +
        "Greet and ask if they’ve added their boat yet. " +
        "Do NOT say 'Hi Lexi' and do NOT mention opening the app. " +
        "Example style (don’t copy verbatim): 'Hey there! Excited to have you on board. Have you had a chance to add your boat yet?'";
      safeSend(oaiWS, JSON.stringify({
        type: "response.create",
        response: { modalities: ["audio","text"], instructions: FIRST_TURN }
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
      lastResponseId = (evt.response && evt.response.id) || evt.id || lastResponseId;
    }
    if (evt?.type === "response.completed") {
      hasActiveResponse = false;
      lastResponseId = null;
      safeSend(twilioWS, JSON.stringify({
        event: "mark",
        streamSid,
        mark: { name: `lexi_done_${Date.now()}` }
      }));
    }

    // When model detects the caller speaking, cancel response + clear Twilio buffer
    if (evt?.type === "input_audio_buffer.speech_started") {
      if (lastResponseId) {
        safeSend(oaiWS, JSON.stringify({ type: "response.cancel", response_id: lastResponseId }));
        lastResponseId = null;
        hasActiveResponse = false;
      }
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

    // input_audio_format: we send PCM16 (decoding μ-law), output: G.711 μ-law to Twilio
    // voice: female; temperature must be >= 0.6 per current model policy
    safeSend(oaiWS, JSON.stringify({
      type: "session.update",
      session: {
        instructions: LEXI_PROMPT,      // Playground prompt is the source of truth
        modalities: ["audio", "text"],
        voice: "shimmer",
        temperature: 0.6,
        input_audio_format:  "pcm16",
        output_audio_format: "g711_ulaw",
        turn_detection: { type: "server_vad", threshold: 0.40 }
      }
    }));

    attemptGreet();
  });

  // ----------------- TWILIO -> OPENAI (caller audio) -----------------
  function commitIfReady(force = false) {
    // Never commit if we haven't actually received any frames since last commit
    if (framesSinceCommit === 0) return;

    if (force || appendedMsSinceCommit >= COMMIT_CHUNK_MS) {
      appendedMsSinceCommit = 0;
      framesSinceCommit = 0;
      safeSend(oaiWS, JSON.stringify({ type: "input_audio_buffer.commit" }));
      if (!hasActiveResponse) {
        hasActiveResponse = true;
        safeSend(oaiWS, JSON.stringify({
          type: "response.create",
          response: { modalities: ["audio","text"], instructions: "Reply in ≤12 words and ask one helpful question." }
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

      // Attach metadata to session
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
      // Finalize any partial chunk (only if we actually buffered something)
      commitIfReady(true);
      return;
    }

    if (msg.event === "media" && msg.media?.payload) {
      // Twilio -> μ-law/8k base64; decode to PCM16 and append (matches input_audio_format)
      const ulaw = Buffer.from(msg.media.payload, "base64");
      const pcmU8 = mulawDecode(new Uint8Array(ulaw)); // bytes of PCM16
      const pcmB64 = Buffer.from(pcmU8).toString("base64");

      safeSend(oaiWS, JSON.stringify({
        type: "input_audio_buffer.append",
        audio: pcmB64
      }));

      appendedMsSinceCommit += FRAME_MS;
      framesSinceCommit += 1;           // each media frame is ~20ms

      // Commit at cadence
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
