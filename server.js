// server.js
require("dotenv").config();
const express = require("express");
const bodyParser = require("body-parser");
const { WebSocketServer } = require("ws");
const WebSocket = require("ws");
const twilio = require("twilio");
const fs = require("fs");
const axios = require("axios"); // Graph HTTP client

// ------------------------- APP SETUP -------------------------
const app = express();
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: false }));

const {
  // Twilio / OpenAI
  TWILIO_ACCOUNT_SID,
  TWILIO_AUTH_TOKEN,
  TWILIO_NUMBER,
  OPENAI_API_KEY,
  OPENAI_MODEL,
  PUBLIC_HOST,
  PORT,

  // Microsoft Graph (Outlook/Teams)
  AZURE_TENANT_ID,
  AZURE_CLIENT_ID,
  AZURE_CLIENT_SECRET,
  ORGANIZER_EMAIL,

  // Optional SMS confirmation
  CONFIRMATION_SMS_FROM,
} = process.env;

if (!OPENAI_API_KEY) console.warn("WARN: OPENAI_API_KEY is not set");
if (!TWILIO_ACCOUNT_SID || !TWILIO_AUTH_TOKEN || !TWILIO_NUMBER) {
  console.warn("WARN: Twilio credentials are not fully set");
}

const twilioClient = twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);

// Load Lexi prompt (source of truth)
let LEXI_PROMPT = "You are Lexi from The Wave App...";
try { LEXI_PROMPT = fs.readFileSync("./lexi-prompt.txt", "utf8"); } catch {}

// ------------------------- AUDIO / TIMING (voice pacing) -------------------------
const FRAME_MS = 20;                 // Twilio media frame = 20ms μ-law
const HEARTBEAT_MS = 25000;          // ping OpenAI WS only (not Twilio)

const MIN_COMMIT_MS = 220;           // >= 220ms buffered before any commit
const MIN_TRAILING_SILENCE_MS = 600; // commit ~600ms after caller stops
const MAX_TURN_MS = 3500;            // cap model turns ~1 short sentence
const GREET_FALLBACK_MS = 1200;      // send greeting if guards didn’t trigger
const COOLDOWN_MS = 300;             // gap after TTS before replying

// ------------------------- UTIL -------------------------
const CLEAN_HOST = (PUBLIC_HOST || "")
  .replace(/^https?:\/\//, "")
  .replace(/\/$/, "");

function safeSend(ws, payload) {
  if (ws && ws.readyState === 1) ws.send(payload);
}

// μ-law decode -> PCM16 (for silence detection only; not sent to OpenAI)
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
  for (let i = 0; i < view.length; i += 80) sum += Math.abs(view[i]);
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
      // machineDetection: "Enable",
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

// ------------------------- Helpers (Graph route) -------------------------
function isValidEmail(e) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e || "");
}
function addMinutesToISOLocal(isoLocal, minutes) {
  // isoLocal like "YYYY-MM-DDTHH:mm:ss"
  const d = new Date(isoLocal);
  if (Number.isNaN(d.getTime())) return isoLocal;
  const d2 = new Date(d.getTime() + minutes * 60 * 1000);
  const pad = (n) => String(n).padStart(2, "0");
  return (
    d2.getFullYear() +
    "-" + pad(d2.getMonth() + 1) +
    "-" + pad(d2.getDate()) +
    "T" + pad(d2.getHours()) +
    ":" + pad(d2.getMinutes()) +
    ":" + pad(d2.getSeconds())
  );
}
function normalizeE164US(phone) {
  if (!phone) return phone;
  const digits = (phone + "").replace(/\D/g, "");
  if (digits.length === 10) return "+1" + digits;
  if (digits.length === 11 && digits.startsWith("1")) return "+" + digits;
  if (phone.startsWith("+")) return phone;
  return phone; // leave as-is if we can't be sure
}

// ------------------------- Native Outlook/Teams via Microsoft Graph -----------------
/**
 * POST /schedule-demo-graph
 * body: { name, email, phone, start, timeZone?, leadId?, callId? }
 * - ALWAYS books a 10-minute demo: end is computed as start + 10 minutes (any provided 'end' is ignored).
 * - timeZone is optional and assumed to "America/New_York" if omitted.
 */
app.post("/schedule-demo-graph", async (req, res) => {
  const {
    name = "Guest",
    email,
    phone,
    start,
    timeZone = "America/New_York", // assume systematically
    leadId,
    callId
  } = req.body || {};

  if (!AZURE_TENANT_ID || !AZURE_CLIENT_ID || !AZURE_CLIENT_SECRET || !ORGANIZER_EMAIL) {
    return res.status(500).json({ error: "Graph env vars are missing" });
  }
  if (!email || !isValidEmail(email)) {
    return res.status(400).json({ error: "Valid email is required" });
  }
  if (!start) {
    return res.status(400).json({ error: "start is required (YYYY-MM-DDTHH:mm:ss)" });
  }

  const end = addMinutesToISOLocal(start, 10);      // ALWAYS 10 minutes
  const smsPhone = normalizeE164US(phone);

  try {
    // 1) App token
    const tokenResp = await axios.post(
      `https://login.microsoftonline.com/${AZURE_TENANT_ID}/oauth2/v2.0/token`,
      new URLSearchParams({
        client_id: AZURE_CLIENT_ID,
        client_secret: AZURE_CLIENT_SECRET,
        scope: "https://graph.microsoft.com/.default",
        grant_type: "client_credentials"
      }),
      { headers: { "Content-Type": "application/x-www-form-urlencoded" } }
    );
    const accessToken = tokenResp.data.access_token;

    // 2) Create event with Teams (simple, consistent wording)
    const subject = "Wave Demo Call (10 min)";
    const createEvt = await axios.post(
      `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(ORGANIZER_EMAIL)}/events`,
      {
        subject,
        body: {
          contentType: "HTML",
          content:
            `Wave demo call.<br/><br/>` +
            `When: ${start} → ${end} (${timeZone})<br/>` +
            `If you need to reschedule, reply to this email.`
        },
        start: { dateTime: start, timeZone },
        end:   { dateTime: end,   timeZone },
        location: { displayName: "Demo call" },     // not “Microsoft Teams”
        isOnlineMeeting: true,
        onlineMeetingProvider: "teamsForBusiness",
        attendees: [
          { emailAddress: { address: email, name }, type: "required" }
        ],
        allowNewTimeProposals: true,
        responseRequested: true
      },
      { headers: { Authorization: `Bearer ${accessToken}` } }
    );

    const eventId = createEvt.data.id;
    const joinUrl = createEvt?.data?.onlineMeeting?.joinUrl || null;

    // 3) Send invite
    await axios.post(
      `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(ORGANIZER_EMAIL)}/events/${eventId}/send`,
      {},
      { headers: { Authorization: `Bearer ${accessToken}` } }
    );

    // 4) Optional SMS confirm (short, simple wording)
    if (smsPhone && CONFIRMATION_SMS_FROM) {
      const smsText =
        `Wave demo call confirmed: ` +
        `${new Date(start).toLocaleString("en-US", { timeZone, month: "short", day: "numeric" })} ` +
        `${new Date(start).toLocaleString("en-US", { timeZone, timeStyle: "short" })}.` +
        (joinUrl ? ` Join: ${joinUrl}` : "");
      try {
        await twilioClient.messages.create({
          from: CONFIRMATION_SMS_FROM,
          to: smsPhone,
          body: smsText
        });
      } catch (smsErr) {
        console.warn("SMS failed:", smsErr?.message || smsErr);
      }
    }

    res.status(201).json({ ok: true, eventId, attendee: email, joinUrl, start, end, timeZone });
  } catch (e) {
    console.error("schedule-demo-graph error:", e?.response?.data || e.message);
    res.status(500).json({ error: "Graph scheduling failed", detail: e?.response?.data || e.message });
  }
});

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

  const oaiURL = `wss://api.openai.com/v1/realtime?model=${encodeURIComponent(OPENAI_MODEL || "gpt-realtime")}`;
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
  let hasActiveResponse = false;
  let lastResponseId = null;

  // pacing helpers
  let lastTTSCompletedAt = 0;
  let userSpokeSinceLastTTS = false;

  let askedBoatStatus = false;

  // NEW: buffer model text per turn to catch control tags
  let currentTurnText = "";

  // Turn-taking trackers
  let framesSinceLastAppend = 0;
  let trailingSilenceMs = 0;
  let turnAccumulatedMs = 0;
  let accumulatedMs = 0;

  const pendingOut = [];

  function sendOrQueueToTwilio(b64) {
    if (!b64) return;
    if (!streamSid) { pendingOut.push(b64); return; }
    safeSend(twilioWS, JSON.stringify({ event: "media", streamSid, media: { payload: b64 } }));
  }
  function drainPending() { while (pendingOut.length && streamSid) sendOrQueueToTwilio(pendingOut.shift()); }

  function attemptGreet() {
    if (oaiReady && streamSid && !greetingSent && !hasActiveResponse) {
      greetingSent = true;
      hasActiveResponse = true;
      console.log("Sending greeting");
      safeSend(oaiWS, JSON.stringify({
        type: "response.create",
        response: {
          modalities: ["audio","text"],
          instructions: "Say exactly: 'Hi, I’m Lexi with The Wave App. Do you have a minute?'"
        }
      }));
    }
  }

  // ---- DIAGNOSTICS / SAFETY ----
  twilioWS.on("error", (e) => console.error("Twilio WS error:", e));
  oaiWS.on("error",   (e) => console.error("OpenAI WS error:", e));
  oaiWS.on("close", (code, reason) => console.log("OpenAI WS closed:", code, reason?.toString()));

  // ----------------- OPENAI -> TWILIO (assistant speech + control tags) -----------------
  oaiWS.on("message", async (raw) => {
    let evt; try { evt = JSON.parse(raw.toString()); } catch { return; }

    // Capture any audio
    if (evt?.type === "response.audio.delta" ||
        evt?.type === "response.output_audio.delta" ||
        evt?.type === "output_audio_chunk.delta") {
      const b64 = evt.delta || evt.audio || null;
      if (b64) sendOrQueueToTwilio(b64);
    }

    // NEW: capture text fragments to inspect for control tags
    if (evt?.type === "response.text.delta" && typeof evt.delta === "string") {
      currentTurnText += evt.delta;
    }

    if (evt?.type === "response.created") {
      hasActiveResponse = true;
      lastResponseId = (evt.response && evt.response.id) || evt.id || lastResponseId;
    }

    if (evt?.type === "response.completed") {
      hasActiveResponse = false;
      lastTTSCompletedAt = Date.now();
      lastResponseId = null;

      // Handle any [[BOOK_DEMO ...]] tag emitted in this model turn
      try {
        await maybeHandleBookDemoTag(currentTurnText);
      } catch (err) {
        console.error("BOOK_DEMO handler error:", err?.message || err);
      }
      currentTurnText = "";

      safeSend(twilioWS, JSON.stringify({ event: "mark", streamSid, mark: { name: `lexi_done_${Date.now()}` } }));
    }

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

    safeSend(oaiWS, JSON.stringify({
      type: "session.update",
      session: {
        instructions: LEXI_PROMPT,
        modalities: ["audio", "text"],
        voice: "shimmer",
        temperature: 0.6,
        input_audio_format:  "g711_ulaw",
        output_audio_format: "g711_ulaw",
        turn_detection: { type: "server_vad", threshold: 0.45 }
      }
    }));

    attemptGreet();
    setTimeout(() => { attemptGreet(); }, GREET_FALLBACK_MS);
  });

  function sendResponse(instr) {
    if (hasActiveResponse) return;
    hasActiveResponse = true;
    userSpokeSinceLastTTS = false;
    safeSend(oaiWS, JSON.stringify({
      type: "response.create",
      response: { modalities: ["audio","text"], instructions: instr }
    }));
    if (!askedBoatStatus && instr === "Say exactly: 'Great. Have you added your boat to your account yet?'") {
      askedBoatStatus = true;
    }
  }

  function maybeCommitUserTurn(force = false) {
    if (framesSinceLastAppend === 0) return;
    if (accumulatedMs < MIN_COMMIT_MS) return;
    if (!userSpokeSinceLastTTS) return;

    const ms = accumulatedMs;
    framesSinceLastAppend = 0;
    trailingSilenceMs = 0;
    turnAccumulatedMs = 0;
    accumulatedMs = 0;

    safeSend(oaiWS, JSON.stringify({ type: "input_audio_buffer.commit" }));
    console.log("Committed user turn ms:", ms);

    const secondTurn = "Say exactly: 'Great. Have you added your boat to your account yet?'";
    const generalTurn = "Follow the system prompt. Keep replies ≤12 words. Ask exactly one helpful question.";
    const instr = askedBoatStatus ? generalTurn : secondTurn;

    const now = Date.now();
    const elapsed = now - (lastTTSCompletedAt || 0);
    if (lastTTSCompletedAt && elapsed < COOLDOWN_MS) {
      setTimeout(() => sendResponse(instr), COOLDOWN_MS - elapsed);
    } else {
      sendResponse(instr);
    }
  }

  twilioWS.on("message", (raw) => {
    let msg; try { msg = JSON.parse(raw.toString()); } catch { return; }

    if (msg.event === "start") {
      streamSid = msg.start?.streamSid || null;
      const params = msg.start?.customParameters || {};
      const leadId = params.leadId || "";
      const callId = params.callId || "";

      console.log("Twilio stream started", { streamSid, leadId, callId });

      safeSend(oaiWS, JSON.stringify({
        type: "session.update",
        session: { metadata: { leadId, callId } }
      }));

      drainPending();
      attemptGreet();
      return;
    }

    if (msg.event === "stop") {
      console.log("Twilio stream stopped");
      maybeCommitUserTurn(true);
      return;
    }

    if (msg.event === "media" && msg.media?.payload) {
      const ulawB64 = msg.media.payload;
      safeSend(oaiWS, JSON.stringify({
        type: "input_audio_buffer.append",
        audio: ulawB64
      }));

      const ulaw = Buffer.from(ulawB64, "base64");
      const pcmU8 = mulawDecode(new Uint8Array(ulaw));

      framesSinceLastAppend += 1;
      turnAccumulatedMs += FRAME_MS;
      accumulatedMs += FRAME_MS;

      const silent = pcmIsSilent(pcmU8);
      trailingSilenceMs = silent ? (trailingSilenceMs + FRAME_MS) : 0;
      if (!silent) userSpokeSinceLastTTS = true;

      if (trailingSilenceMs >= MIN_TRAILING_SILENCE_MS || turnAccumulatedMs >= MAX_TURN_MS) {
        maybeCommitUserTurn(true);
      }
    }
  });

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

  // ----------------- CONTROL TAG HANDLER -----------------
  async function maybeHandleBookDemoTag(turnText) {
    if (!turnText) return;

    // Match [[BOOK_DEMO name="..." email="..." start="YYYY-MM-DDTHH:mm:ss"]]
    const tagMatch = turnText.match(/\[\[\s*BOOK_DEMO\s+([^\]]+)\]\]/i);
    if (!tagMatch) return;

    // Parse key="value" pairs
    const attrs = {};
    const pairRe = /(\w+)\s*=\s*"([^"]*)"/g;
    let m;
    while ((m = pairRe.exec(tagMatch[1])) !== null) {
      attrs[m[1]] = m[2];
    }

    const name  = attrs.name || "Guest";
    const email = attrs.email || "";
    const start = attrs.start || "";  // "YYYY-MM-DDTHH:mm:ss" local
    if (!email || !start) {
      console.warn("BOOK_DEMO missing email/start:", attrs);
      return;
    }

    // Compose payload; timezone omitted => server defaults America/New_York; 10-min fixed
    const payload = { name, email, start };

    try {
      const r = await axios.post(
        `https://${CLEAN_HOST}/schedule-demo-graph`,
        payload,
        { timeout: 10000 }
      );
      if (r.status >= 200 && r.status < 300) {
        console.log("BOOK_DEMO success:", { eventId: r.data?.eventId, to: email });
        // Speak short confirmation if we are not already speaking
        if (!hasActiveResponse) {
          hasActiveResponse = true;
          safeSend(oaiWS, JSON.stringify({
            type: "response.create",
            response: { modalities: ["audio","text"], instructions: "Done. Your demo call invite is on the way." }
          }));
        }
      } else {
        console.warn("BOOK_DEMO non-2xx:", r.status, r.data);
      }
    } catch (err) {
      console.error("BOOK_DEMO POST failed:", err?.response?.data || err.message);
      if (!hasActiveResponse) {
        hasActiveResponse = true;
        safeSend(oaiWS, JSON.stringify({
          type: "response.create",
          response: { modalities: ["audio","text"], instructions: "Hmm—that didn’t go through. Want a different time, or should I follow up by text?" }
        }));
      }
    }
  }
});
