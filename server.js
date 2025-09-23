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

// ------------------------- AUDIO / TIMING -------------------------
const SAMPLE_RATE = 8000;            // Twilio = 8kHz
const FRAME_MS = 20;                 // Twilio media frame = 20ms μ-law
const HEARTBEAT_MS = 25000;          // Ping OpenAI WS only (not Twilio)

// Silence/turn-taking thresholds
const MIN_COMMIT_MS = 140;           // must have >= 140ms audio before any commit
const MIN_TRAILING_SILENCE_MS = 300; // commit ~300ms after caller stops
const MAX_TURN_MS = 4000;            // hard cap per user turn
const GREET_FALLBACK_MS = 1200;      // send greeting if guards didn’t trigger

// ------------------------- UTIL -------------------------
const CLEAN_HOST = (PUBLIC_HOST || "")
  .replace(/^https?:\/\//, "")
  .replace(/\/$/, "");

function safeSend(ws, payload) {
  if (ws && ws.readyState === 1) ws.send(payload);
}

// μ-law decode -> PCM16 (for silence detection only; we do NOT send PCM to OpenAI)
function mulawDecode(u8) {
  const out = new Int16Array(u8.length);
  for (let i = 0; i < u8.length; i++) {
    let u = u8[i] ^ 0xff;
    let t = ((u & 0x0f) << 3) + 0x84;
    t <<= (u & 0x70) >> 4;
    out[i] = (u & 0x80) ? (0x84 - t) : (t - 0x84);
  }
  return new Uint8Array(new DataView(out.buffer).buffer); // PCM16 LE bytes
}

// Simple PCM16 silence check (avg abs amplitude)
function pcmIsSilent(pcmU8, threshold = 500) {
  const view = new Int16Array(pcmU8.buffer, pcmU8.byteOffset, pcmU8.byteLength / 2);
  let sum = 0;
  for (let i = 0; i < view.length; i += 80) sum += Math.abs(view[i]); // sample stride
  const avg = sum / Math.max(1, Math.floor(view.length / 80));
  return avg < threshold;
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

  const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-realtime";
  const oaiURL = `wss://api.openai.com/v1/realtime?model=${encodeURIComponent(OPENAI_MODEL)}`;
  const oaiWS = new WebSocket(oaiURL, {
    headers: { Authorization: `Bearer ${OPENAI_API_KEY}`, "OpenAI-Beta": "realtime=v1" }
  });

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
  let followupQueued = false;     // queue a reply if model still speaking

  // Turn-taking trackers
  let framesSinceLastAppend = 0;  // frames since last append (20ms each)
  let trailingSilenceMs = 0;      // consecutive silence
  let turnAccumulatedMs = 0;      // total speech in current user turn
  let accumulatedMs = 0;          // total ms since last commit

  const pendingOut = [];          // base64 μ-law audio before streamSid exists

  function sendOrQueueToTwilio(b64) {
    if (!b64) return;
    if (!streamSid) { pendingOut.push(b64); return; }
    safeSend(twilioWS, JSON.stringify({ event: "media", streamSid, media: { payload: b64 } }));
  }
  function drainPending() { while (pendingOut.length && streamSid) sendOrQueueToTwilio(pendingOut.shift()); }

  // Permission-only opener (no steps yet)
  function attemptGreet() {
    if (oaiReady && streamSid && !greetingSent && !hasActiveResponse) {
      greetingSent = true;
      hasActiveResponse = true;
      console.log("Sending greeting");
      const FIRST_TURN =
        "Give a brief, friendly intro as Lexi from The Wave App, then a polite permission check in one short sentence (≤12 words). " +
        "Example style (do not copy): 'Hey, I’m Lexi with The Wave App—do you have a minute?'. " +
        "Do NOT say 'Hi Lexi'. Do NOT mention opening the app. Do NOT ask about adding the boat yet. Stop after that one sentence.";
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
    let evt; try { evt = JSON.parse(raw.toString()); } catch { return; }

    if (evt?.type === "response.audio.delta" ||
        evt?.type === "response.output_audio.delta" ||
        evt?.type === "output_audio_chunk.delta") {
      const b64 = evt.delta || evt.audio || null; // base64 g711_ulaw
      if (b64) sendOrQueueToTwilio(b64);
    }

    if (evt?.type === "response.created") {
      hasActiveResponse = true;
      lastResponseId = (evt.response && evt.response.id) || evt.id || lastResponseId;
    }

    if (evt?.type === "response.completed") {
      hasActiveResponse = false;
      lastResponseId = null;

      // deliver any queued follow-up now
      if (followupQueued) {
        followupQueued = false;
        hasActiveResponse = true;
        safeSend(oaiWS, JSON.stringify({
          type: "response.create",
          response: {
            modalities: ["audio","text"],
            instructions: "Follow the system prompt. Keep replies ≤12 words. Ask exactly one helpful question."
          }
        }));
      }

      safeSend(twilioWS, JSON.stringify({ event: "mark", streamSid, mark: { name: `lexi_done_${Date.now()}` } }));
    }

    // Barge-in: cancel only if truly active, then clear Twilio buffer
    if (evt?.type === "input_audio_buffer.speech_started") {
      if (hasActiveResponse && lastResponseId) {
        safeSend(oaiWS, JSON.stringify({ type: "response.cancel", response_id: lastResponseId }));
        lastResponseId = null;
        hasActiveResponse = false;
      }
      safeSend(twilioWS, JSON.stringify({ event: "clear", streamSid }));
    }

    if (evt?.type === "error") console.error("OpenAI server error event:", evt);
  });

  // ----------------- OPENAI SESSION CONFIG -----------------
  oaiWS.on("open", () => {
    console.log("OpenAI WS opened");
    oaiReady = true;

    // ✅ MATCH INPUT CODEC TO TWILIO: g711_ulaw in, g711_ulaw out
    safeSend(oaiWS, JSON.stringify({
      type: "session.update",
      session: {
        instructions: LEXI_PROMPT,      // your prompt is the source of truth
        modalities: ["audio", "text"],
        voice: "shimmer",
        temperature: 0.6,               // model enforces >= 0.6 in your logs
        input_audio_format:  "g711_ulaw", // <-- μ-law input
        output_audio_format: "g711_ulaw",
        turn_detection: { type: "server_vad", threshold: 0.40 }
      }
    }));

    attemptGreet();
    setTimeout(() => { attemptGreet(); }, GREET_FALLBACK_MS);
  });

  // ----------------- TWILIO -> OPENAI (caller audio) -----------------
  function maybeCommitUserTurn(force = false) {
    // Only commit if we actually buffered audio and have enough duration
    if (framesSinceLastAppend === 0) return;
    if (accumulatedMs < MIN_COMMIT_MS) return;

    const ms = accumulatedMs; // debug
    framesSinceLastAppend = 0;
    trailingSilenceMs = 0;
    turnAccumulatedMs = 0;
    accumulatedMs = 0;

    safeSend(oaiWS, JSON.stringify({ type: "input_audio_buffer.commit" }));
    console.log("Committed user turn ms:", ms);

    if (hasActiveResponse) {
      followupQueued = true;
    } else {
      hasActiveResponse = true;
      safeSend(oaiWS, JSON.stringify({
        type: "response.create",
        response: {
          modalities: ["audio","text"],
          instructions: "Follow the system prompt. Keep replies ≤12 words. Ask exactly one helpful question."
        }
      }));
    }
  }

  twilioWS.on("message", (raw) => {
    let msg; try { msg = JSON.parse(raw.toString()); } catch { return; }

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
      maybeCommitUserTurn(true); // will skip if < MIN_COMMIT_MS
      return;
    }

    if (msg.event === "media" && msg.media?.payload) {
      // ✅ Pass-through μ-law/8k to OpenAI (matches session.input_audio_format = g711_ulaw)
      const ulawB64 = msg.media.payload; // base64 μ-law from Twilio
      safeSend(oaiWS, JSON.stringify({
        type: "input_audio_buffer.append",
        audio: ulawB64,
        // being explicit per-append helps avoid ingestion ambiguity
        audio_format: "g711_ulaw"
      }));

      // For silence detection locally, decode μ-law -> PCM16 (not sent)
      const ulaw = Buffer.from(ulawB64, "base64");
      const pcmU8 = mulawDecode(new Uint8Array(ulaw)); // bytes of PCM16

      // Update turn-taking trackers
      framesSinceLastAppend += 1;
      turnAccumulatedMs += FRAME_MS;
      accumulatedMs += FRAME_MS;

      // Silence tracking from decoded PCM
      trailingSilenceMs = pcmIsSilent(pcmU8) ? (trailingSilenceMs + FRAME_MS) : 0;

      // Commit on natural pause or long monologue
      if (trailingSilenceMs >= MIN_TRAILING_SILENCE_MS || turnAccumulatedMs >= MAX_TURN_MS) {
        maybeCommitUserTurn(true);
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
    try { maybeCommitUserTurn(true); } catch {}
    try { twilioWS.close(); } catch {}
    try { oaiWS.close(); } catch {}
  }

  twilioWS.on("close", closeAll);
  twilioWS.on("error", (e) => { console.error("Twilio WS error:", e); closeAll(); });
  oaiWS.on("close", closeAll);
  oaiWS.on("error", (e) => { console.error("OpenAI WS error:", e); });
});
