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
} catch {
  console.warn("WARN: lexi-prompt.txt not found, using fallback prompt");
}

// ------------------------- AUDIO / TIMING (voice pacing) -------------------------
const HEARTBEAT_MS = 25000;          // ping OpenAI WS only (not Twilio)
const GREET_FALLBACK_MS = 1200;      // send greeting if guards didn’t trigger

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
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test((e || "").trim());
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

function extractTextFragments(value) {
  if (value == null) return "";
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(extractTextFragments).join("");
  if (typeof value === "object") {
    let acc = "";
    if ("text" in value) acc += extractTextFragments(value.text);
    if ("output_text" in value) acc += extractTextFragments(value.output_text);
    if ("content" in value) acc += extractTextFragments(value.content);
    if ("value" in value) acc += extractTextFragments(value.value);
    if ("delta" in value) acc += extractTextFragments(value.delta);
    return acc;
  }
  return "";
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

  // ---- Normalize email and start ----
  const cleanEmail = (email || "").trim().replace(/[.,;:]+$/, "");
  let cleanStart = (start || "").trim();
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(cleanStart)) {
    // Accept YYYY-MM-DDTHH:mm by auto-adding :00
    cleanStart += ":00";
  }

  if (!cleanEmail || !isValidEmail(cleanEmail)) {
    return res.status(400).json({ error: "Valid email is required" });
  }
  if (!cleanStart) {
    return res.status(400).json({ error: "start is required (YYYY-MM-DDTHH:mm[:ss])" });
  }

  const end = addMinutesToISOLocal(cleanStart, 10);      // ALWAYS 10 minutes
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

    // 2) Create event with Teams and SEND invites (sendUpdates=all)
    const subject = "Wave Demo Call (10 min)";
    const attendee = { emailAddress: { address: cleanEmail, name }, type: "required" };
    const createEvt = await axios.post(
      `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(ORGANIZER_EMAIL)}/events?sendUpdates=all`,
      {
        subject,
        body: {
          contentType: "HTML",
          content:
            `Wave demo call.<br/><br/>` +
            `When: ${cleanStart} → ${end} (${timeZone})<br/>` +
            `If you need to reschedule, reply to this email.`
        },
        start: { dateTime: cleanStart, timeZone },
        end:   { dateTime: end,        timeZone },
        location: { displayName: "Demo call" },     // not “Microsoft Teams”
        isOnlineMeeting: true,
        onlineMeetingProvider: "teamsForBusiness",
        attendees: [attendee],
        allowNewTimeProposals: true,
        responseRequested: true
      },
      {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json"
        }
      }
    );

    const eventId = createEvt.data.id;
    const joinUrl = createEvt?.data?.onlineMeeting?.joinUrl || null;
    console.log("Graph event created (invites sent):", { eventId, attendee: cleanEmail, hasJoinUrl: !!joinUrl });

    // 3) Optional SMS confirm (short, simple wording)
    if (smsPhone && CONFIRMATION_SMS_FROM) {
      const smsText =
        `Wave demo call confirmed: ` +
        `${new Date(cleanStart).toLocaleString("en-US", { timeZone, month: "short", day: "numeric" })} ` +
        `${new Date(cleanStart).toLocaleString("en-US", { timeZone, timeStyle: "short" })}.` +
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
  let pendingResponseRequested = false;
  let lastResponseId = null;

  let askedBoatStatus = false;

  // NEW: buffer model text per turn to catch control tags
  let currentTurnText = "";
  let bookingInFlight = false;
  let bookingDone = false;
  let lastTTSCompletedAt = 0;
  let lastAssistantAudioTs = 0;

  // Remember metadata so we can include if desired
  let metaLeadId = "";
  let metaCallId = "";

  // Log only once per assistant turn that we’re receiving text
  let loggedDeltaThisTurn = false;

  const pendingOut = [];

  function sendOrQueueToTwilio(b64) {
    if (!b64) return;
    if (!streamSid) { pendingOut.push(b64); return; }
    safeSend(twilioWS, JSON.stringify({ event: "media", streamSid, media: { payload: b64 } }));
  }
  function drainPending() { while (pendingOut.length && streamSid) sendOrQueueToTwilio(pendingOut.shift()); }

  function attemptGreet() {
    if (oaiReady && streamSid && !greetingSent && !hasActiveResponse && !pendingResponseRequested) {
      greetingSent = true;
      console.log("Sending greeting");
      issueResponse("Say exactly: 'Hi, I’m Lexi with The Wave App. Do you have a minute?'", { force: true });
    }
  }

  // ---- DIAGNOSTICS / SAFETY ----
  twilioWS.on("error", (e) => console.error("Twilio WS error:", e));
  oaiWS.on("error",   (e) => console.error("OpenAI WS error:", e));
  oaiWS.on("close", (code, reason) => console.log("OpenAI WS closed:", code, reason?.toString()));

  // Helper: try primary https://${CLEAN_HOST}, then local loopback as fallback
  async function postBookDemo(payload) {
    if (bookingInFlight || bookingDone) return;
    bookingInFlight = true;

    const primaryURL = `https://${CLEAN_HOST}/schedule-demo-graph`;
    const fallbackURL = `http://127.0.0.1:${PORT || 8080}/schedule-demo-graph`;

    try {
      console.log("BOOK_DEMO posting (primary):", { email: payload.email, start: payload.start });
      const r = await axios.post(primaryURL, payload, { timeout: 10000 });
      const data = r.data || {};
      console.log("BOOK_DEMO success:", { eventId: data?.eventId || null, to: payload.email });
      bookingDone = true;
      bookingInFlight = false;
      return data;
    } catch (err1) {
      console.warn("BOOK_DEMO primary failed, trying fallback:", err1?.message || err1);
      try {
        console.log("BOOK_DEMO posting (fallback):", { email: payload.email, start: payload.start });
        const r2 = await axios.post(fallbackURL, payload, { timeout: 10000 });
        const data2 = r2.data || {};
        console.log("BOOK_DEMO success:", { eventId: data2?.eventId || null, to: payload.email });
        bookingDone = true;
        bookingInFlight = false;
        return data2;
      } catch (err2) {
        bookingInFlight = false; // allow a later retry if needed
        throw err2;
      }
    }
  }

  // ----------------- OPENAI -> TWILIO (assistant speech + control tags) -----------------
  oaiWS.on("message", async (raw) => {
    let evt; try { evt = JSON.parse(raw.toString()); } catch { return; }

    // Capture assistant audio
    if (evt?.type === "response.audio.delta" ||
        evt?.type === "response.output_audio.delta" ||
        evt?.type === "output_audio_chunk.delta") {
      const b64 = evt.delta || evt.audio || null;
      if (b64) sendOrQueueToTwilio(b64);
      lastTTSCompletedAt = Date.now();
      lastAssistantAudioTs = Date.now();
    }

    // Capture assistant text fragments and scan for BOOK_DEMO *during streaming*
    if (
      evt?.type === "response.text.delta" ||
      evt?.type === "response.output_text.delta"
    ) {
      const deltaText = extractTextFragments(evt.delta);
      if (deltaText) {
        currentTurnText += deltaText;
        console.log("[DEBUG] Normalized text delta chunk:", deltaText.slice(0, 120)); // TEMP DEBUG
        if (!loggedDeltaThisTurn) {
          console.log("Assistant text streaming… len=", currentTurnText.length);
          loggedDeltaThisTurn = true;
        }

        // STREAM-TIME TAG DETECTION (one-shot, ASCII quotes)
        if (!bookingDone && !bookingInFlight) {
          const m = currentTurnText.match(/\[\[\s*BOOK_DEMO\s+([^\]]+)\]\]/i);
          if (m) {
            console.log("[DEBUG] BOOK_DEMO tag match during stream"); // TEMP DEBUG
          // Parse attributes safely
          const attrs = {};
          let raw = m[1] || "";
          raw = raw.replace(/[\u201C\u201D]/g, '"').replace(/\u200B/g, '');
          const pairRe = /(\w+)\s*=\s*"([^"]*)"/g;
          let p;
          while ((p = pairRe.exec(raw)) !== null) attrs[p[1]] = p[2];

          const name  = attrs.name || "Guest";
          const email = (attrs.email || "").trim().replace(/[.,;:]+$/, "");
          let   start = (attrs.start || "").trim();
          if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(start)) start += ":00";

          if (email && start) {
            console.log("BOOK_DEMO tag detected (streaming):", { email, start });
            const payload = { name, email, start, leadId: metaLeadId, callId: metaCallId };
            postBookDemo(payload).catch(err => {
              console.error("BOOK_DEMO POST failed (streaming):", err?.response?.data || err.message);
              issueResponse(
                "Hmm—that didn’t go through. Want a different time, or should I follow up by text?",
                { force: true }
              );
            });
          } else {
            console.warn("BOOK_DEMO tag parse failed:", raw);
            console.warn("BOOK_DEMO tag missing email/start (streaming)");
          }
        }
      }
    }

    if (evt?.type === "response.created") {
      loggedDeltaThisTurn = false;
      hasActiveResponse = true;
      pendingResponseRequested = false;
      lastResponseId = (evt.response && evt.response.id) || evt.id || lastResponseId;
      lastTTSCompletedAt = Date.now();
    }

    if (evt?.type === "response.completed") {
      hasActiveResponse = false;
      pendingResponseRequested = false;
      lastResponseId = null;
      lastTTSCompletedAt = Date.now();

      let finalTurnText = currentTurnText;
      if (!finalTurnText) {
        const fallbackOutputText = extractTextFragments(evt?.response?.output_text);
        if (fallbackOutputText) {
          console.log("[DEBUG] Final text from response.output_text fallback:", fallbackOutputText.slice(0, 200)); // TEMP DEBUG
          finalTurnText = fallbackOutputText;
        }
      }
      if (!finalTurnText) {
        const fallbackContentText = extractTextFragments(evt?.response?.content);
        if (fallbackContentText) {
          console.log("[DEBUG] Final text from response.content fallback:", fallbackContentText.slice(0, 200)); // TEMP DEBUG
          finalTurnText = fallbackContentText;
        }
      }
      if (!finalTurnText) {
        const fallbackStructuredOutput = extractTextFragments(evt?.response?.output);
        if (fallbackStructuredOutput) {
          console.log("[DEBUG] Final text from response.output fallback:", fallbackStructuredOutput.slice(0, 200)); // TEMP DEBUG
          finalTurnText = fallbackStructuredOutput;
        }
      }

      currentTurnText = finalTurnText || "";
      console.log("TURN_TEXT:", (currentTurnText || "").slice(0, 200));

      // FINAL PASS TAG DETECTION (in case there was no streaming hit)
      if (!bookingDone && !bookingInFlight) {
        try {
          await maybeHandleBookDemoTag(currentTurnText);
        } catch (err) {
          console.error("BOOK_DEMO handler error (completed):", err?.message || err);
        }
      }
      loggedDeltaThisTurn = false;
      currentTurnText = "";

      safeSend(twilioWS, JSON.stringify({ event: "mark", streamSid, mark: { name: `lexi_done_${Date.now()}` } }));
    }

    if (evt?.type === "response.canceled") {
      hasActiveResponse = false;
      lastResponseId = null;
      lastTTSCompletedAt = Date.now();
    }

    if (evt?.type === "input_audio_buffer.speech_started") {
      const now = Date.now();
      const msSinceAssistantAudio = now - lastAssistantAudioTs;
      console.log("speech_started", { hasActiveResponse, msSinceAssistantAudio });
      if (hasActiveResponse && lastResponseId && msSinceAssistantAudio <= 1000) {
        safeSend(oaiWS, JSON.stringify({ type: "response.cancel", response_id: lastResponseId }));
        lastResponseId = null;
        hasActiveResponse = false;
      }
      safeSend(twilioWS, JSON.stringify({ event: "clear", streamSid }));
      if (!hasActiveResponse && !pendingResponseRequested) {
        requestDefaultAssistantResponse();
      }
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
        turn_detection: { type: "server_vad", threshold: 0.50 }
      }
    }));

    attemptGreet();
    setTimeout(() => { attemptGreet(); }, GREET_FALLBACK_MS);
  });

  function issueResponse(instr, { markAskedBoat = false, force = false } = {}) {
    if (!instr) return false;
    if (!force && (hasActiveResponse || pendingResponseRequested)) return false;

    if (force && hasActiveResponse && lastResponseId) {
      safeSend(oaiWS, JSON.stringify({ type: "response.cancel", response_id: lastResponseId }));
      lastResponseId = null;
      hasActiveResponse = false;
    }

    pendingResponseRequested = true;
    safeSend(oaiWS, JSON.stringify({
      type: "response.create",
      response: { modalities: ["audio","text"], instructions: instr }
    }));

    if (markAskedBoat) askedBoatStatus = true;
    return true;
  }

  function requestDefaultAssistantResponse() {
    const secondTurn = "Say exactly: 'Great. Have you added your boat to your account yet?'";
    const generalTurn = "Follow the system prompt. Keep replies ≤12 words. Ask exactly one helpful question.";
    if (!askedBoatStatus) {
      issueResponse(secondTurn, { markAskedBoat: true });
    } else {
      issueResponse(generalTurn);
    }
  }

  twilioWS.on("message", (raw) => {
    let msg; try { msg = JSON.parse(raw.toString()); } catch { return; }

    if (msg.event === "start") {
      streamSid = msg.start?.streamSid || null;
      const params = msg.start?.customParameters || {};
      metaLeadId = params.leadId || "";
      metaCallId = params.callId || "";

      console.log("Twilio stream started", { streamSid, leadId: metaLeadId, callId: metaCallId });
      loggedDeltaThisTurn = false;

      safeSend(oaiWS, JSON.stringify({
        type: "session.update",
        session: { metadata: { leadId: metaLeadId, callId: metaCallId } }
      }));

      drainPending();
      attemptGreet();
      return;
    }

    if (msg.event === "stop") {
      console.log("Twilio stream stopped");
      return;
    }

    if (msg.event === "media" && msg.media?.payload) {
      const ulawB64 = msg.media.payload;
      safeSend(oaiWS, JSON.stringify({
        type: "input_audio_buffer.append",
        audio: ulawB64
      }));
    }
  });

  const heartbeat = setInterval(() => {
    try { if (oaiWS.readyState === 1) oaiWS.ping(); } catch {}
  }, HEARTBEAT_MS);

  function closeAll() {
    if (closed) return;
    closed = true;
    clearInterval(heartbeat);
    try { twilioWS.close(); } catch {}
    try { oaiWS.close(); } catch {}
  }

  twilioWS.on("close", closeAll);
  twilioWS.on("error", (e) => { console.error("Twilio WS error:", e); closeAll(); });
  oaiWS.on("close", closeAll);
  oaiWS.on("error", (e) => { console.error("OpenAI WS error:", e); });

  // ----------------- CONTROL TAG HANDLER (fallback on completed) -----------------
  async function maybeHandleBookDemoTag(turnText) {
    if (!turnText || bookingDone || bookingInFlight) return;
    const tagMatch = turnText.match(/\[\[\s*BOOK_DEMO\s+([^\]]+)\]\]/i);
    if (!tagMatch) return;

    const attrs = {};
    let raw = tagMatch[1] || "";
    raw = raw.replace(/[\u201C\u201D]/g, '"').replace(/\u200B/g, '');
    const pairRe = /(\w+)\s*=\s*"([^"]*)"/g;
    let m;
    while ((m = pairRe.exec(raw)) !== null) {
      attrs[m[1]] = m[2];
    }

    const name  = attrs.name || "Guest";
    const email = (attrs.email || "").trim().replace(/[.,;:]+$/, "");
    let   start = (attrs.start || "").trim();
    if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(start)) start += ":00";

    if (!email || !start) {
      console.warn("BOOK_DEMO tag parse failed:", raw);
      console.warn("BOOK_DEMO missing email/start (completed):", attrs);
      return;
    }

    console.log("BOOK_DEMO tag detected:", { email, start });
    const payload = { name, email, start, leadId: metaLeadId, callId: metaCallId };

    try {
      await postBookDemo(payload);
    } catch (err) {
      console.error("BOOK_DEMO POST failed (completed):", err?.response?.data || err.message);
      issueResponse(
        "Hmm—that didn’t go through. Want a different time, or should I follow up by text?",
        { force: true }
      );
    }
  }
});
