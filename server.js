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
const TWILIO_FRAME_BYTES = 160;  // 20ms μ-law @ 8kHz
const MAX_BUFFER_MS = 4000;      // Max caller audio to buffer before forcing flush
const SILENCE_MS = 700;          // Silence gap to send chunk to OpenAI
const HEARTBEAT_MS = 25000;      // Ping OpenAI WS only (not Twilio)
const MIN_COMMIT_MS = 120;       // Guard: commit only when we have >= ~100ms PCM

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
  return new Uint8Array(new DataView(out.buffer).buffer);
}

// (Kept for reference; not used if we request mulaw output from OpenAI)
function mulawEncode(pcmU8) {
  const pcm = new Int16Array(pcmU8.buffer, pcmU8.byteOffset, pcmU8.byteLength / 2);
  const out = new Uint8Array(pcm.length);
  for (let i = 0; i < pcm.length; i++) {
    let s = pcm[i];
    let sign = (s >> 8) & 0x80;
    if (sign !== 0) s = -s;
    if (s > 32635) s = 32635;
    s += 132;
    let exp = 7;
    for (let e = 0x4000; (s & e) === 0 && exp > 0; e >>= 1) exp--;
    let mant = (s >> (exp + 3)) & 0x0f;
    out[i] = ~(sign | (exp << 4) | mant);
  }
  return out;
}

function isSilent(pcmBuf) {
  if (!pcmBuf || pcmBuf.length === 0) return true;
  const view = new Int16Array(pcmBuf.buffer, pcmBuf.byteOffset, pcmBuf.byteLength / 2);
  let sum = 0;
  for (let i = 0; i < view.length; i += 80) sum += Math.abs(view[i]);
  const avg = sum / Math.max(1, Math.floor(view.length / 80));
  return avg < 500; // tune if needed
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
      // machineDetection: "Enable", // ← disable during debugging for faster start
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
  let inputChunks = [];           // buffered PCM16 from caller
  let totalBufferedMs = 0;
  let lastVoiceTime = Date.now();
  let speaking = false;
  let closed = false;

  // Coordination + buffering
  let oaiReady = false;
  let greetingSent = false;
  const pendingOut = []; // base64 mulaw chunks produced before streamSid exists

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
    if (oaiReady && streamSid && !greetingSent) {
      greetingSent = true;
      console.log("Sending greeting");
      safeSend(oaiWS, JSON.stringify({
        type: "response.create",
        response: {
          modalities: ["audio","text"], // ← IMPORTANT: both, not just "audio"
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

    // 🎯 ACCEPT ALL CURRENT AUDIO DELTA NAMES
    if (
      evt?.type === "response.audio.delta" ||            // current
      evt?.type === "response.output_audio.delta" ||     // older
      evt?.type === "output_audio_chunk.delta"           // legacy preview
    ) {
      const b64 = evt.delta || evt.audio || null;        // base64 mulaw/8k (headerless)
      if (b64) {
        if (!oaiWS._firstDeltaLogged) {
          console.log("Got model audio delta, bytes(base64):", b64.length);
          oaiWS._firstDeltaLogged = true;
        }
        sendOrQueueToTwilio(b64);
      }
    }

    // Optional: text debug so we know the model is responding
    if (evt?.type === "response.text.delta" && evt.delta) {
      if (!oaiWS._firstTextLogged) {
        console.log("Model text (first 40 chars):", evt.delta.slice(0, 40));
        oaiWS._firstTextLogged = true;
      }
    }

    if (evt?.type === "response.completed") {
      safeSend(twilioWS, JSON.stringify({
        event: "mark",
        streamSid,
        mark: { name: `lexi_done_${Date.now()}` }
      }));
    }

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

    // Configure the session (no metadata yet; we’ll get it from Twilio 'start')
    safeSend(oaiWS, JSON.stringify({
      type: "session.update",
      session: {
        instructions: LEXI_PROMPT,
        modalities: ["audio", "text"],
        voice: "alloy",
        input_audio_format:  { type: "pcm16", sample_rate: 8000 },
        output_audio_format: { type: "pcm_mulaw", sample_rate: 8000 },
        turn_detection: { type: "server_vad", threshold: 0.45 }
      }
    }));

    // Only greet once both sides are ready
    attemptGreet();
  });

  // ----------------- TWILIO -> OPENAI (caller audio) -----------------
  function flushToOpenAI(force = false) {
    if (inputChunks.length === 0) return;

    const now = Date.now();
    const sinceVoice = now - lastVoiceTime;
    if (!force && sinceVoice < SILENCE_MS) return;

    // Combine what we have
    const chunk = Buffer.concat(inputChunks);
    const chunkMs = Math.round((chunk.length / 2) / SAMPLE_RATE * 1000); // 16-bit mono @ 8k

    if (chunkMs < MIN_COMMIT_MS) {
      // Not enough audio to commit yet — keep buffering
      return;
    }

    // Enough audio — send & commit
    inputChunks = [];
    totalBufferedMs = 0;

    safeSend(oaiWS, JSON.stringify({
      type: "input_audio_buffer.append",
      audio: chunk.toString("base64")
    }));
    safeSend(oaiWS, JSON.stringify({ type: "input_audio_buffer.commit" }));
    safeSend(oaiWS, JSON.stringify({
      type: "response.create",
      response: { modalities: ["audio","text"] } // ← IMPORTANT: both
    }));
    speaking = false;
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

      // Push metadata into the OpenAI session now that we have it
      safeSend(oaiWS, JSON.stringify({
        type: "session.update",
        session: { metadata: { leadId: leadIdFromTwilio, callId: callIdFromTwilio } }
      }));

      // We can now send any model audio that was generated early
      drainPending();
      // Only greet once both sides are ready
      attemptGreet();
      return;
    }

    if (msg.event === "stop") {
      console.log("Twilio stream stopped");
      flushToOpenAI(true);
      return;
    }

    if (msg.event === "media" && msg.media?.payload) {
      const ulaw = Buffer.from(msg.media.payload, "base64");
      const pcmU8 = mulawDecode(new Uint8Array(ulaw));
      const pcmBuf = Buffer.from(pcmU8);

      const now = Date.now();
      const silent = isSilent(pcmBuf);
      if (!silent) { lastVoiceTime = now; speaking = true; }

      inputChunks.push(pcmBuf);
      totalBufferedMs += Math.round((pcmBuf.length / 2) / SAMPLE_RATE * 1000);

      if (totalBufferedMs > MAX_BUFFER_MS) {
        flushToOpenAI(true);
      } else if (!speaking) {
        flushToOpenAI();
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
    try { flushToOpenAI(true); } catch {}
    try { twilioWS.close(); } catch {}
    try { oaiWS.close(); } catch {}
  }

  twilioWS.on("close", closeAll);
  twilioWS.on("error", (e) => { console.error("Twilio WS error:", e); closeAll(); });
  oaiWS.on("close", closeAll);
  oaiWS.on("error", (e) => { console.error("OpenAI WS error:", e); });
});
