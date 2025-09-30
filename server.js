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
try {
  LEXI_PROMPT = fs.readFileSync("./lexi-prompt.txt", "utf8");
  console.log("Lexi prompt bytes:", Buffer.byteLength(LEXI_PROMPT, "utf8"));
} catch {}

// ------------------------- AUDIO / TIMING -------------------------
const FRAME_MS = 20;                 // Twilio frame = 20ms μ-law
const HEARTBEAT_MS = 25000;

const MIN_COMMIT_MS = 220;           // don’t even consider committing < 220ms turn
const MIN_TRAILING_SILENCE_MS = 600; // natural pause
const MAX_TURN_MS = 3500;            // cap long monologues
const GREET_FALLBACK_MS = 1200;
const COOLDOWN_MS = 300;             // slight pause after TTS

// ------------------------- UTIL -------------------------
const CLEAN_HOST = (PUBLIC_HOST || "").replace(/^https?:\/\//, "").replace(/\/$/, "");

function safeSend(ws, payload) {
  if (ws && ws.readyState === 1) ws.send(payload);
}

// μ-law decode -> PCM16 (LE bytes)
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

// Silence check on PCM16
function pcmIsSilent(pcmU8, threshold = 500) {
  const view = new Int16Array(pcmU8.buffer, pcmU8.byteOffset, pcmU8.byteLength / 2);
  let sum = 0, samples = 0;
  for (let i = 0; i < view.length; i += 80) { sum += Math.abs(view[i]); samples++; }
  const avg = samples ? sum / samples : 0;
  return avg < threshold;
}

// ------------------------- HTTP ROUTES -------------------------
app.get("/healthz", (_, res) => res.json({ ok: true }));

app.post("/dial", async (req, res) => {
  try {
    console.log("POST /dial payload:", req.body);
    const { to, leadId = "", callId = "" } = req.body;
    if (!to) return res.status(400).json({ error: "`to` (E.164) required" });

    const twimlUrl = `https://${CLEAN_HOST}/voice?leadId=${encodeURIComponent(leadId)}&callId=${encodeURIComponent(callId)}`;
    console.log("Using TwiML URL:", twimlUrl);

    const call = await twilioClient.calls.create({
      to, from: TWILIO_NUMBER, url: twimlUrl, method: "POST",
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

// ------------------------- GRAPH HELPERS -------------------------
function isValidEmail(e) { return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test((e || "").trim()); }
function addMinutesToISOLocal(isoLocal, minutes) {
  const d = new Date(isoLocal); if (Number.isNaN(d.getTime())) return isoLocal;
  const d2 = new Date(d.getTime() + minutes * 60 * 1000);
  const pad = (n) => String(n).padStart(2, "0");
  return `${d2.getFullYear()}-${pad(d2.getMonth()+1)}-${pad(d2.getDate())}T${pad(d2.getHours())}:${pad(d2.getMinutes())}:${pad(d2.getSeconds())}`;
}
function normalizeE164US(phone) {
  if (!phone) return phone;
  const digits = (phone + "").replace(/\D/g, "");
  if (digits.length === 10) return "+1" + digits;
  if (digits.length === 11 && digits.startsWith("1")) return "+" + digits;
  if (phone.startsWith("+")) return phone;
  return phone;
}

/**
 * POST /schedule-demo-graph
 * body: { name, email, phone, start, timeZone?, leadId?, callId? }
 */
app.post("/schedule-demo-graph", async (req, res) => {
  const {
    name = "Guest",
    email,
    phone,
    start,
    timeZone = "America/New_York",
  } = req.body || {};

  if (!AZURE_TENANT_ID || !AZURE_CLIENT_ID || !AZURE_CLIENT_SECRET || !ORGANIZER_EMAIL) {
    return res.status(500).json({ error: "Graph env vars are missing" });
  }

  const cleanEmail = (email || "").trim().replace(/[.,;:]+$/, "");
  let cleanStart = (start || "").trim();
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(cleanStart)) cleanStart += ":00";

  if (!cleanEmail || !isValidEmail(cleanEmail)) {
    return res.status(400).json({ error: "Valid email is required" });
  }
  if (!cleanStart) {
    return res.status(400).json({ error: "start is required (YYYY-MM-DDTHH:mm[:ss])" });
  }

  const end = addMinutesToISOLocal(cleanStart, 10);
  const smsPhone = normalizeE164US(phone);

  try {
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

    const attendee = { emailAddress: { address: cleanEmail, name }, type: "required" };
    const createEvt = await axios.post(
      `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(ORGANIZER_EMAIL)}/events?sendUpdates=all`,
      {
        subject: "Wave Demo Call (10 min)",
        body: {
          contentType: "HTML",
          content: `Wave demo call.<br/><br/>When: ${cleanStart} → ${end} (${timeZone})<br/>If you need to reschedule, reply to this email.`
        },
        start: { dateTime: cleanStart, timeZone },
        end:   { dateTime: end,        timeZone },
        location: { displayName: "Demo call" },
        isOnlineMeeting: true,
        onlineMeetingProvider: "teamsForBusiness",
        attendees: [attendee],
        allowNewTimeProposals: true,
        responseRequested: true
      },
      { headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" } }
    );

    const eventId = createEvt.data.id;
    const joinUrl = createEvt?.data?.onlineMeeting?.joinUrl || null;
    console.log("Graph event created (invites sent):", { eventId, attendee: cleanEmail, hasJoinUrl: !!joinUrl });

    if (smsPhone && CONFIRMATION_SMS_FROM) {
      const smsText =
        `Wave demo call confirmed: ` +
        `${new Date(cleanStart).toLocaleString("en-US", { timeZone, month: "short", day: "numeric" })} ` +
        `${new Date(cleanStart).toLocaleString("en-US", { timeZone, timeStyle: "short" })}.` +
        (joinUrl ? ` Join: ${joinUrl}` : "");
      try {
        await twilioClient.messages.create({ from: CONFIRMATION_SMS_FROM, to: smsPhone, body: smsText });
      } catch (smsErr) {
        console.warn("SMS failed:", smsErr?.message || smsErr);
      }
    }

    res.status(201).json({ ok: true, eventId, attendee: cleanEmail, joinUrl, start: cleanStart, end, timeZone });
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

  // tag buffers / guards
  let currentTurnText = "";
  let bookingInFlight = false;
  let bookingDone = false;

  // meta
  let metaLeadId = "";
  let metaCallId = "";

  // turn-tracking + *actual* appended frame count
  let framesSinceLastAppend = 0;
  let trailingSilenceMs = 0;
  let turnAccumulatedMs = 0;
  let accumulatedMs = 0;
  let appendedFramesSinceLastCommit = 0; // <— key guard

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
        response: { modalities: ["audio","text"], instructions: "Say exactly: 'Hi, I’m Lexi with The Wave App. Do you have a minute?'" }
      }));
    }
  }

  // helper: post book demo (primary host, no loopback here — keep simple & visible)
  async function postBookDemo(payload) {
    if (bookingInFlight || bookingDone) return;
    bookingInFlight = true;
    const url = `https://${CLEAN_HOST}/schedule-demo-graph`;
    console.log("BOOK_DEMO posting:", { url, email: payload.email, start: payload.start });
    const r = await axios.post(url, payload, { timeout: 10000 });
    console.log("BOOK_DEMO success:", r.data);
    bookingDone = true;
    return r.data;
  }

  // ---- DIAGNOSTICS ----
  twilioWS.on("error", (e) => console.error("Twilio WS error:", e));
  oaiWS.on("error",   (e) => console.error("OpenAI WS error:", e));
  oaiWS.on("close", (code, reason) => console.log("OpenAI WS closed:", code, reason?.toString()));

  // ----------------- OPENAI -> TWILIO -----------------
  oaiWS.on("message", async (raw) => {
    let evt; try { evt = JSON.parse(raw.toString()); } catch { return; }

    // Audio out
    if (evt?.type === "response.audio.delta" || evt?.type === "response.output_audio.delta" || evt?.type === "output_audio_chunk.delta") {
      const b64 = evt.delta || evt.audio || null;
      if (b64) sendOrQueueToTwilio(b64);
    }

    // Text out — accumulate and watch for BOOK_DEMO during streaming
    if ((evt?.type === "response.text.delta" || evt?.type === "response.output_text.delta") && typeof evt.delta === "string") {
      currentTurnText += evt.delta;

      if (!bookingDone && !bookingInFlight) {
        const m = currentTurnText.match(/\[\[\s*BOOK_DEMO\s+([^\]]+)\]\]/i);
        if (m) {
          const attrs = {};
          const pairRe = /(\w+)\s*=\s*"([^"]*)"/g; let p;
          while ((p = pairRe.exec(m[1])) !== null) attrs[p[1]] = p[2];

          const name  = attrs.name || "Guest";
          const email = (attrs.email || "").trim().replace(/[.,;:]+$/, "");
          let   start = (attrs.start || "").trim();
          if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(start)) start += ":00";

          if (email && start) {
            console.log("BOOK_DEMO tag detected (streaming):", { email, start });
            const payload = { name, email, start, leadId: metaLeadId, callId: metaCallId };
            postBookDemo(payload).then(() => {
              if (!hasActiveResponse) {
                hasActiveResponse = true;
                safeSend(oaiWS, JSON.stringify({
                  type: "response.create",
                  response: { modalities: ["audio","text"], instructions: "Done. Your demo call invite is on the way." }
                }));
              }
            }).catch(err => {
              console.error("BOOK_DEMO POST failed (streaming):", err?.response?.data || err.message);
            });
          } else {
            console.warn("BOOK_DEMO tag missing email/start (streaming)");
          }
        }
      }
    }

    if (evt?.type === "response.created") {
      hasActiveResponse = true;
      lastResponseId = (evt.response && evt.response.id) || evt.id || lastResponseId;
    }

    if (evt?.type === "response.completed") {
      hasActiveResponse = false;
      lastTTSCompletedAt = Date.now();
      lastResponseId = null;

      if (!bookingDone && !bookingInFlight) {
        const m2 = currentTurnText.match(/\[\[\s*BOOK_DEMO\s+([^\]]+)\]\]/i);
        if (m2) {
          const attrs = {};
          const pairRe = /(\w+)\s*=\s*"([^"]*)"/g; let q;
          while ((q = pairRe.exec(m2[1])) !== null) attrs[q[1]] = q[2];

          const name  = attrs.name || "Guest";
          const email = (attrs.email || "").trim().replace(/[.,;:]+$/, "");
          let   start = (attrs.start || "").trim();
          if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(start)) start += ":00";

          if (email && start) {
            console.log("BOOK_DEMO tag detected (completed):", { email, start });
            const payload = { name, email, start, leadId: metaLeadId, callId: metaCallId };
            try {
              await postBookDemo(payload);
              if (!hasActiveResponse) {
                hasActiveResponse = true;
                safeSend(oaiWS, JSON.stringify({
                  type: "response.create",
                  response: { modalities: ["audio","text"], instructions: "Done. Your demo call invite is on the way." }
                }));
              }
            } catch (err) {
              console.error("BOOK_DEMO POST failed (completed):", err?.response?.data || err.message);
            }
          }
        }
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

    // Robust: PCM16 IN, μ-law OUT
    safeSend(oaiWS, JSON.stringify({
      type: "session.update",
      session: {
        instructions: LEXI_PROMPT,
        modalities: ["audio", "text"],
        voice: "shimmer",
        temperature: 0.6,
        input_audio_format:  "pcm16",
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
    safeSend(oaiWS, JSON.stringify({ type: "response.create", response: { modalities: ["audio","text"], instructions: instr } }));
    if (!askedBoatStatus && instr === "Say exactly: 'Great. Have you added your boat to your account yet?'") {
      askedBoatStatus = true;
    }
  }

  function maybeCommitUserTurn(force = false) {
    // Only commit if:
    //  - we buffered audio (framesSinceLastAppend > 0),
    //  - the turn has enough duration (accumulatedMs),
    //  - caller actually spoke (userSpokeSinceLastTTS),
    //  - and we've appended at least 5 frames (~100ms) to OAI since last commit.
    if (framesSinceLastAppend === 0) return;
    if (accumulatedMs < MIN_COMMIT_MS) return;
    if (!userSpokeSinceLastTTS) return;
    if (appendedFramesSinceLastCommit < 5 && !force) return;

    const ms = accumulatedMs;
    console.log("Committing user turn:", { ms, appendedFramesSinceLastCommit });

    // reset counters
    framesSinceLastAppend = 0;
    trailingSilenceMs = 0;
    turnAccumulatedMs = 0;
    accumulatedMs = 0;
    appendedFramesSinceLastCommit = 0;

    safeSend(oaiWS, JSON.stringify({ type: "input_audio_buffer.commit" }));

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

  // ----------------- TWILIO -> OPENAI -----------------
  twilioWS.on("message", (raw) => {
    let msg; try { msg = JSON.parse(raw.toString()); } catch { return; }

    if (msg.event === "start") {
      streamSid = msg.start?.streamSid || null;
      const params = msg.start?.customParameters || {};
      metaLeadId = params.leadId || "";
      metaCallId = params.callId || "";
      console.log("Twilio stream started", { streamSid, leadId: metaLeadId, callId: metaCallId });

      safeSend(oaiWS, JSON.stringify({ type: "session.update", session: { metadata: { leadId: metaLeadId, callId: metaCallId } } }));

      // reset counters on new stream
      appendedFramesSinceLastCommit = 0;
      framesSinceLastAppend = 0;
      accumulatedMs = 0;
      trailingSilenceMs = 0;
      turnAccumulatedMs = 0;

      drainPending();
      attemptGreet();
      return;
    }

    if (msg.event === "stop") {
      console.log("Twilio stream stopped");
      // finalize only if we really buffered something >= 5 frames
      if (appendedFramesSinceLastCommit >= 5) maybeCommitUserTurn(true);
      return;
    }

    if (msg.event === "media" && msg.media?.payload) {
      // Twilio base64 μ-law -> PCM16 -> append to OpenAI (input_audio_format=pcm16)
      const ulaw = Buffer.from(msg.media.payload, "base64");
      const pcmU8 = mulawDecode(new Uint8Array(ulaw));
      const pcmB64 = Buffer.from(pcmU8).toString("base64");

      safeSend(oaiWS, JSON.stringify({ type: "input_audio_buffer.append", audio: pcmB64 }));

      appendedFramesSinceLastCommit += 1;                    // *actual* appended
      framesSinceLastAppend += 1;
      turnAccumulatedMs += FRAME_MS;
      accumulatedMs += FRAME_MS;

      const silent = pcmIsSilent(pcmU8);
      trailingSilenceMs = silent ? (trailingSilenceMs + FRAME_MS) : 0;
      if (!silent) userSpokeSinceLastTTS = true;

      if (trailingSilenceMs >= MIN_TRAILING_SILENCE_MS || turnAccumulatedMs >= MAX_TURN_MS) {
        maybeCommitUserTurn(false);
      }
    }
  });

  const heartbeat = setInterval(() => { try { if (oaiWS.readyState === 1) oaiWS.ping(); } catch {} }, HEARTBEAT_MS);

  function closeAll() {
    if (closed) return;
    closed = true;
    clearInterval(heartbeat);
    try { if (appendedFramesSinceLastCommit >= 5) maybeCommitUserTurn(true); } catch {}
    try { twilioWS.close(); } catch {}
    try { oaiWS.close(); } catch {}
  }

  twilioWS.on("close", closeAll);
  twilioWS.on("error", (e) => { console.error("Twilio WS error:", e); closeAll(); });
  oaiWS.on("close", closeAll);
  oaiWS.on("error", (e) => { console.error("OpenAI WS error:", e); });

});
