// server.js
require("dotenv").config();
const express = require("express");
const { WebSocketServer } = require("ws");
const WebSocket = require("ws");
const twilio = require("twilio");
const fs = require("fs");
const axios = require("axios"); // Graph HTTP client
const requestTrace = require("./request-trace");

// ------------------------- APP SETUP -------------------------
const app = express();
app.use(requestTrace());
app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ extended: false }));

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
  DEMO_ORGANIZER_UPN,
  ORGANIZER_EMAIL,

  // Optional SMS confirmation
  CONFIRMATION_SMS_FROM,
} = process.env;

if (!OPENAI_API_KEY) console.warn("WARN: OPENAI_API_KEY is not set");
if (!TWILIO_ACCOUNT_SID || !TWILIO_AUTH_TOKEN || !TWILIO_NUMBER) {
  console.warn("WARN: Twilio credentials are not fully set");
}
if (!PUBLIC_HOST && !process.env.RENDER_EXTERNAL_URL) {
  console.warn("WARN: PUBLIC_HOST/RENDER_EXTERNAL_URL is not set; booking will use fallback only");
}
[
  { name: "AZURE_TENANT_ID", value: AZURE_TENANT_ID },
  { name: "AZURE_CLIENT_ID", value: AZURE_CLIENT_ID },
  { name: "AZURE_CLIENT_SECRET", value: AZURE_CLIENT_SECRET },
  {
    name: "DEMO_ORGANIZER_UPN",
    value: DEMO_ORGANIZER_UPN || ORGANIZER_EMAIL,
    warn: !DEMO_ORGANIZER_UPN && ORGANIZER_EMAIL
  }
].forEach(({ name, value, warn }) => {
  if (!value) {
    console.warn(`WARN: ${name} is not set`);
  } else if (warn) {
    console.warn(`WARN: DEMO_ORGANIZER_UPN not set; falling back to ORGANIZER_EMAIL`);
  }
});

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

const CLASSIFY_YES_NO =
  "You are a strict classifier. Based ONLY on the caller’s immediate last utterance, output a single token:\n" +
  "YES  — if they clearly accepted the booking (yes, sounds good, book it, perfect, that works, etc.)\n" +
  "NO   — if they declined or deferred (no, not now, later, another day, etc.)\n" +
  "Do NOT include any other words, punctuation, or explanation. Output exactly YES or NO.";

const SPEECH_ENERGY_THRESHOLD = 500;  // simple RMS gate for caller speech detection
const SILENCE_HOLD_MS = 700;          // how long silence must persist before committing audio
const SILENCE_CHECK_INTERVAL = 200;   // cadence for silence watchdog
const MIN_COMMIT_BYTES = 800;         // ensure >=100 ms of audio before committing

// ------------------------- UTIL -------------------------
function computeCleanHost() {
  const envHost = (process.env.PUBLIC_HOST || process.env.RENDER_EXTERNAL_URL || "").trim();
  let host = envHost.replace(/^https?:\/\//, "").replace(/\/+$/, "");
  if (!host) {
    console.warn("[BOOK] PUBLIC_HOST/RENDER_EXTERNAL_URL missing. Will use 127.0.0.1 fallback only.");
    return null;
  }
  return host;
}

const CLEAN_HOST = computeCleanHost();

function safeSend(ws, payload) {
  if (ws && ws.readyState === 1) ws.send(payload);
}

// --- Realtime audio buffer (>=100ms) ---
function makeAudioBuffer(flushFn, opts = {}) {
  // For 8kHz μ-law, 20ms ≈ 160 bytes. Target ~100-140ms per commit.
  const MIN_BYTES = opts.minBytes || 800;   // ~100ms
  const MAX_BYTES = opts.maxBytes || 1600;  // cap ~200ms to keep latency reasonable
  const FLUSH_MS  = opts.flushMs  || 140;   // safety flush if speech is slow to arrive

  let chunks = [];
  let total = 0;
  let timer = null;

  function flush(reason = "timer") {
    if (timer) { clearTimeout(timer); timer = null; }
    if (total <= 0) return;

    const buf = Buffer.concat(chunks, total);
    if (!buf || buf.length < 100) {
      console.warn(`[AUDIO] skipped flush: buffer too small (${buf?.length || 0} bytes)`);
      chunks = buf && buf.length ? [buf] : [];
      total = buf ? buf.length : 0;
      maybeStartTimer();
      return;
    }

    chunks = [];
    total = 0;

    console.log(`[AUDIO] commit ${buf.length} bytes (${reason})`);
    try { flushFn(buf); }
    catch (e) { console.error("[AUDIO] flush error", e); }
  }

  function maybeStartTimer() {
    if (!timer) {
      timer = setTimeout(() => flush("timeout"), FLUSH_MS);
      if (timer.unref) timer.unref();
    }
  }

  return {
    push(frameBuf) {
      if (!frameBuf || !frameBuf.length) return;
      chunks.push(frameBuf);
      total += frameBuf.length;

      if (total >= MIN_BYTES) {
        const reason = total >= MAX_BYTES ? "max" : "min";
        flush(reason);
      } else {
        maybeStartTimer();
      }
    },
    flush,
    reset() { chunks = []; total = 0; if (timer) { clearTimeout(timer); timer = null; } }
  };
}

// ------------------------- HTTP ROUTES -------------------------
app.get("/healthz", (_, res) => res.json({ ok: true }));
app.post("/twilio/status", (req, res) => {
  console.log("[TWILIO-STATUS]", req.body);
  res.sendStatus(200);
});
app.use(require("./routes/book-demo"));

// Kick off an outbound call
app.post("/dial", async (req, res) => {
  try {
    console.log("POST /dial payload:", req.body);
    const { to, leadId = "", callId = "" } = req.body;
    if (!to) return res.status(400).json({ error: "`to` (E.164) required" });

    const hostForTwilio = CLEAN_HOST || `127.0.0.1:${PORT || 8080}`;
    if (!CLEAN_HOST) {
      console.warn('[DIAL] CLEAN_HOST missing; using fallback host for Twilio URLs', { hostForTwilio });
    }
    const twimlUrl =
      `https://${hostForTwilio}/voice?leadId=${encodeURIComponent(leadId)}&callId=${encodeURIComponent(callId)}`;

    console.log("Using TwiML URL:", twimlUrl);

    const call = await twilioClient.calls.create({
      to,
      from: TWILIO_NUMBER,
      url: twimlUrl,
      method: "POST",
      // machineDetection: "Enable",
      statusCallback: `https://${hostForTwilio}/status`,
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

  const hostForTwilio = CLEAN_HOST || `127.0.0.1:${PORT || 8080}`;
  if (!CLEAN_HOST) {
    console.warn('[VOICE] CLEAN_HOST missing; using fallback host for Stream URL', { hostForTwilio });
  }
  const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Connect>
    <Stream url="wss://${hostForTwilio}/ws/twilio">
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

  const oaiURL = `wss://api.openai.com/v1/realtime?model=${encodeURIComponent(OPENAI_MODEL || "gpt-realtime")}`;
  console.log("[RT] OpenAI realtime connect: metadata disabled");
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

  let bookingReady = null;
  let awaitingConfirm = false;
  let confirmAskedAt = 0;
  let lastAssistantAudioMs = 0;

  let bytesSinceLastCommit = 0;
  let callerSpeaking = false;
  let silenceStartedAt = 0;
  let lastMediaReceivedAt = 0;
  let silenceMonitor = null;

  let confirmClassificationInFlight = false;
  const classifierResponseIds = new Set();
  const classifierTextById = new Map();

  const pendingCallerFrames = [];
  let pendingCommitReason = null;

  let audioBuf = null;

  // Remember metadata so we can include if desired
  let metaLeadId = "";
  let metaCallId = "";

  // Log only once per assistant turn that we’re receiving text
  let loggedDeltaThisTurn = false;

  let lastReadback = { email: null, start: null, raw: "" };
  let awaitingBookingConfirm = false;

  const pendingOut = [];

  function startSilenceMonitor() {
    if (silenceMonitor) return;
    silenceMonitor = setInterval(() => {
      if (!callerSpeaking) return;
      const now = Date.now();
      if (lastMediaReceivedAt && now - lastMediaReceivedAt > SILENCE_HOLD_MS) {
        callerSpeaking = false;
        commitCallerAudio("silence_timeout");
      }
    }, SILENCE_CHECK_INTERVAL);
  }

  function stopSilenceMonitor() {
    if (silenceMonitor) {
      clearInterval(silenceMonitor);
      silenceMonitor = null;
    }
  }

  function muLawByteToLinear(uVal) {
    let sample = ~uVal & 0xff;
    const sign = sample & 0x80;
    sample &= 0x7f;
    const exponent = (sample & 0x70) >> 4;
    let mantissa = sample & 0x0f;
    mantissa |= 0x10;
    mantissa <<= 1;
    let pcm = mantissa << (exponent + 2);
    pcm -= 33;
    return sign ? -pcm : pcm;
  }

  function computeFrameEnergy(buf) {
    if (!buf || !buf.length) return 0;
    let total = 0;
    for (let i = 0; i < buf.length; i++) {
      total += Math.abs(muLawByteToLinear(buf[i]));
    }
    return total / buf.length;
  }

  function flushPendingCallerFrames() {
    if (!pendingCallerFrames.length) return false;
    if (!audioBuf) return false;
    while (pendingCallerFrames.length) {
      const frame = pendingCallerFrames.shift();
      audioBuf.push(frame);
    }
    return true;
  }

  function performCallerCommit(reason = "", source = "explicit") {
    if (!oaiReady || oaiWS.readyState !== WebSocket.OPEN) return false;
    if (bytesSinceLastCommit <= 0) return false;
    safeSend(oaiWS, JSON.stringify({ type: "input_audio_buffer.commit" }));
    if (awaitingConfirm) {
      console.log("AUDIO_COMMIT", { reason, bytesSinceLastCommit, source });
    }
    bytesSinceLastCommit = 0;
    silenceStartedAt = 0;
    callerSpeaking = false;
    pendingCommitReason = null;
    if (awaitingConfirm && !confirmClassificationInFlight) {
      setTimeout(() => maybeTriggerConfirmClassifier(), 60);
    }
    return true;
  }

  function commitCallerAudio(reason = "") {
    const commitReason = reason || pendingCommitReason || "auto";
    pendingCommitReason = commitReason;
    flushPendingCallerFrames();
    if (audioBuf) audioBuf.flush("commit-request");
    if (!oaiReady || oaiWS.readyState !== WebSocket.OPEN) return false;
    if (bytesSinceLastCommit < MIN_COMMIT_BYTES && bytesSinceLastCommit > 0) {
      console.log("[AUDIO] commit guard", { bytesSinceLastCommit, min: MIN_COMMIT_BYTES, reason: commitReason });
    }
    return performCallerCommit(commitReason);
  }

  function handleCallerAudioFrame(frameBuf) {
    lastMediaReceivedAt = Date.now();
    const energy = computeFrameEnergy(frameBuf);
    if (energy > SPEECH_ENERGY_THRESHOLD) {
      callerSpeaking = true;
      silenceStartedAt = 0;
      pendingCommitReason = null;
    } else if (callerSpeaking) {
      if (!silenceStartedAt) {
        silenceStartedAt = Date.now();
      } else if (Date.now() - silenceStartedAt >= SILENCE_HOLD_MS) {
        callerSpeaking = false;
        commitCallerAudio("silence_hold");
      }
    }
    if (audioBuf) {
      audioBuf.push(frameBuf);
    } else {
      pendingCallerFrames.push(frameBuf);
    }
    flushPendingCallerFrames();
    startSilenceMonitor();
  }

  function parseControlTag(text, tagName) {
    if (!text) return null;
    const normalized = text
      .replace(/[“”]/g, '"')
      .replace(/[‘’]/g, "'")
      .replace(/\u200B/g, "");

    const re = new RegExp(`\\[\\[${tagName}\\s+([^\\]]+)\\\\]\\]`, 'i');
    const m = normalized.match(re);
    if (!m) return null;

    const attrsStr = m[1];
    const attrs = {};
    attrsStr.replace(/(\w+)\s*=\s*"(.*?)"/g, (_, k, v) => {
      attrs[k.toLowerCase()] = v.trim();
    });

    if (attrs.email) attrs.email = attrs.email.replace(/[\s.,;:!?]+$/, '');

    if (attrs.start) {
      if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(attrs.start)) {
        attrs.start = `${attrs.start}:00`;
      }
      const d = new Date(attrs.start);
      if (!Number.isNaN(d.getTime())) attrs.start = d.toISOString();
    }

    console.log('BOOK_TAG_PARSED', { tagName, attrs });
    return attrs;
  }

  function applyBookingReady(attrs) {
    if (!attrs) return false;
    const email = attrs.email;
    const start = attrs.start;
    if (email && start) {
      const alreadySame = bookingReady && bookingReady.email === email && bookingReady.start === start;
      bookingReady = { email, start };
      awaitingConfirm = true;
      confirmAskedAt = Date.now();
      if (!alreadySame) {
        console.log('BOOKING_READY', bookingReady);
      }
      return true;
    }
    console.warn('BOOKING_READY tag missing email/start', attrs);
    return false;
  }

  function onOpenAIReady() {
    console.log("[RT] OpenAI ready; starting buffered audio");
    bytesSinceLastCommit = 0;
    audioBuf = makeAudioBuffer((chunk) => {
      if (!chunk || !chunk.length) return;
      if (!oaiReady || oaiWS.readyState !== WebSocket.OPEN) {
        console.warn("[RT] No active OpenAI WS; dropping audio");
        return;
      }
      const payload = chunk.toString("base64");
      try {
        safeSend(oaiWS, JSON.stringify({
          type: "input_audio_buffer.append",
          audio: payload
        }));
        bytesSinceLastCommit += chunk.length;
      } catch (err) {
        console.error("[AUDIO] send error", err);
      }
    });
    flushPendingCallerFrames();
  }

  async function evaluateBookingTags(text, source) {
    if (!text) return;
    const demoTag = parseControlTag(text, 'BOOK_DEMO');
    const readyTag = parseControlTag(text, 'BOOKING_READY');

    if (readyTag) applyBookingReady(readyTag);

    let candidate = null;
    if (demoTag && demoTag.email && demoTag.start) {
      candidate = { attrs: demoTag, label: 'BOOK_DEMO' };
    } else if (readyTag && readyTag.email && readyTag.start) {
      candidate = { attrs: readyTag, label: 'BOOKING_READY' };
    }

    if (!candidate) return;

    if (bookingDone) {
      console.log('BOOK skip: booking already done');
      return;
    }
    if (bookingInFlight) {
      console.log('BOOK skip: booking already in flight');
      return;
    }

    const payload = {
      name: candidate.attrs.name || 'Guest',
      email: candidate.attrs.email,
      start: candidate.attrs.start,
      leadId: metaLeadId,
      callId: metaCallId,
      source: candidate.label,
    };

    try {
      await postBookDemo(payload, { label: candidate.label });
    } catch (err) {
      console.error(`${candidate.label} POST failed (${source}):`, err?.response?.data || err?.message || err);
      if (source !== 'latch') {
        issueResponse(
          "Hmm—that didn’t go through. Want a different time, or should I follow up by text?",
          { force: true }
        );
      }
    }
  }

  function maybeTriggerConfirmClassifier() {
    if (!awaitingConfirm || confirmClassificationInFlight) return;
    confirmClassificationInFlight = true;
    safeSend(oaiWS, JSON.stringify({
      type: "response.create",
      response: {
        modalities: ["text"],
        conversation: "none",
        instructions: CLASSIFY_YES_NO,
        metadata: {
          kind: "yes_no_classifier",
          confirmAskedAt
        }
      }
    }));
  }

  async function handleBookingDecision(decisionText) {
    const trimmed = (decisionText || "").trim().toUpperCase();
    const result = trimmed === "YES" ? "YES" : trimmed === "NO" ? "NO" : "UNKNOWN";
    console.log("BOOKING_CONFIRM", { result });
    confirmClassificationInFlight = false;

    if (result !== "YES") {
      awaitingConfirm = false;
      bookingReady = null;
      return;
    }

    if (!bookingReady) {
      awaitingConfirm = false;
      return;
    }

    const payload = {
      name: metaLeadId || "Guest",
      email: bookingReady.email,
      start: bookingReady.start,
      leadId: metaLeadId,
      callId: metaCallId,
      source: 'BOOKING_CONFIRM'
    };

    try {
      await postBookDemo(payload, { label: "BOOKING" });
      awaitingConfirm = false;
      bookingReady = null;
      issueResponse("Done. Your demo call invite is on the way.", { force: true });
    } catch (err) {
      awaitingConfirm = false;
      bookingReady = null;
      console.error("BOOKING_CONFIRM_POST_ERROR", err?.response?.data || err?.message || err);
      issueResponse(
        "That didn’t go through. Want a different time, or should I follow up by text?",
        { force: true }
      );
    }
  }

  function sendOrQueueToTwilio(b64) {
    if (!b64) return;
    if (!streamSid) { pendingOut.push(b64); return; }
    safeSend(twilioWS, JSON.stringify({ event: "media", streamSid, media: { payload: b64 } }));
  }
  function drainPending() { while (pendingOut.length && streamSid) sendOrQueueToTwilio(pendingOut.shift()); }

  function normalizeAssistantText(evt, currentTurnText) {
    const coerce = (val) => {
      if (val == null) return "";
      if (typeof val === "string") return val;
      if (Array.isArray(val)) return val.map((item) => coerce(item)).filter(Boolean).join(" ");
      if (typeof val === "object") {
        if (typeof val.text !== "undefined") return coerce(val.text);
        if (typeof val.output_text !== "undefined") return coerce(val.output_text);
        try {
          return JSON.stringify(val);
        } catch {
          return String(val);
        }
      }
      return String(val);
    };

    let combined = coerce(currentTurnText);
    const append = (piece) => {
      const str = coerce(piece).trim();
      if (!str) return;
      if (!combined) {
        combined = str;
        return;
      }
      if (!combined.includes(str)) combined = `${combined} ${str}`;
    };

    append(evt?.response?.output_text);

    const content = evt?.response?.content;
    if (Array.isArray(content)) {
      for (const part of content) {
        if (!part) continue;
        if (typeof part === "string") {
          append(part);
          continue;
        }
        append(part.text);
        append(part.output_text);
      }
    }

    return (combined || "")
      .replace(/[\u201C\u201D]/g, '"')
      .replace(/[\u2018\u2019]/g, "'")
      .replace(/\u200B/g, "")
      .replace(/\s+/g, " ")
      .trim();
  }

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

  async function postBookDemo(payload, { label = "BOOK_DEMO" } = {}) {
    if (bookingDone) {
      console.log('BOOK skip: booking already done');
      return null;
    }
    if (bookingInFlight) {
      console.log('BOOK skip: booking already in flight');
      return null;
    }

    bookingInFlight = true;
    console.log('postBookDemo ENTER', { bookingInFlight, bookingDone, payload });

    const cleanHost = computeCleanHost();
    const primaryURL = cleanHost ? `https://${cleanHost}/schedule-demo-graph` : null;
    const fallbackURL = `http://127.0.0.1:${process.env.PORT || 8080}/schedule-demo-graph`;
    console.log('BOOK_POST_TARGETS', { primaryURL, fallbackURL });

    const logName = label === "BOOKING" ? "BOOKING_POST" : "BOOK_DEMO_POST";

    try {
      if (primaryURL) {
        try {
          const r = await axios.post(primaryURL, payload, { timeout: 10000 });
          const data = r.data || {};
          console.log(logName, { status: r.status, eventId: data?.eventId || null, url: primaryURL });
          bookingDone = true;
          return data;
        } catch (err1) {
          const status1 = err1?.response?.status || 0;
          const body1 = err1?.response?.data || err1?.message || err1;
          console.error(`${logName}_PRIMARY_FAIL`, { status: status1, body: body1, url: primaryURL });
        }
      } else {
        console.log(`${logName}_PRIMARY_SKIP`, { reason: 'no_clean_host' });
      }

      console.log(`${logName}_FALLBACK_ATTEMPT`, {
        url: fallbackURL,
        reason: primaryURL ? 'primary_failed' : 'no_primary_available',
      });
      const r2 = await axios.post(fallbackURL, payload, { timeout: 10000 });
      const data2 = r2.data || {};
      console.log(logName, {
        status: r2.status,
        eventId: data2?.eventId || null,
        url: fallbackURL,
        transport: 'fallback',
      });
      bookingDone = true;
      return data2;
    } catch (err) {
      const status = err?.response?.status || 0;
      const body = err?.response?.data || err?.message || err;
      console.error(`${logName}_FALLBACK_FAIL`, { status, body, url: fallbackURL });
      throw err;
    } finally {
      bookingInFlight = false;
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
      lastAssistantAudioMs = Date.now();
    }

    // Capture assistant text fragments and scan for BOOK_DEMO *during streaming*
    if (
      (evt?.type === "response.text.delta" || evt?.type === "response.output_text.delta") &&
      typeof evt.delta === "string"
    ) {
      const responseId = evt?.response_id || evt?.response?.id || null;
      if (responseId && classifierResponseIds.has(responseId)) {
        const prior = classifierTextById.get(responseId) || "";
        classifierTextById.set(responseId, prior + evt.delta);
        return;
      }

      currentTurnText += evt.delta;
      await evaluateBookingTags(currentTurnText, 'stream');
      if (!loggedDeltaThisTurn) {
        console.log("Assistant text streaming… len=", currentTurnText.length);
        loggedDeltaThisTurn = true;
      }

      // evaluateBookingTags handles tolerant tag parsing and booking triggers
    }

    if (evt?.type === "response.created") {
      loggedDeltaThisTurn = false;
      const responseId = (evt.response && evt.response.id) || evt.id || null;
      const kind = evt?.response?.metadata?.kind || evt?.metadata?.kind || null;
      if (kind === "yes_no_classifier") {
        if (responseId) classifierResponseIds.add(responseId);
        return;
      }
      hasActiveResponse = true;
      pendingResponseRequested = false;
      lastResponseId = responseId || lastResponseId;
      lastTTSCompletedAt = Date.now();
      return;
    }

    if (evt?.type === "response.completed") {
      const responseId = evt?.response?.id || evt.id || null;
      if (responseId && classifierResponseIds.has(responseId)) {
        let classifierText = classifierTextById.get(responseId) || "";
        if (!classifierText) {
          const outputText = evt?.response?.output_text;
          if (Array.isArray(outputText) && outputText.length) classifierText = outputText.join("");
          if (!classifierText) {
            const content = evt?.response?.content;
            if (Array.isArray(content) && content.length) {
              const parts = [];
              for (const piece of content) {
                if (!piece) continue;
                if (typeof piece === "string") parts.push(piece);
                else if (typeof piece.text === "string") parts.push(piece.text);
                else if (Array.isArray(piece.text)) parts.push(piece.text.join(""));
              }
              classifierText = parts.join("");
            }
          }
        }
        classifierResponseIds.delete(responseId);
        classifierTextById.delete(responseId);
        await handleBookingDecision(classifierText);
        return;
      }

      hasActiveResponse = false;
      pendingResponseRequested = false;
      lastResponseId = null;
      lastTTSCompletedAt = Date.now();
      lastAssistantAudioMs = Date.now();

      const finalTurnText = normalizeAssistantText(evt, currentTurnText);
      currentTurnText = finalTurnText || "";
      const completedLogText = (finalTurnText || "").slice(0, 400);
      console.log("COMPLETED_TEXT:", completedLogText);

      if (finalTurnText) {
        const lower = finalTurnText.toLowerCase();
        const emailMatch = finalTurnText.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i);
        const isoMatch = finalTurnText.match(/\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?\b/);
        let normalizedStart = null;
        if (isoMatch && isoMatch[0]) {
          normalizedStart = isoMatch[0];
          if (normalizedStart.length === 16) normalizedStart += ":00";
        }

        if (emailMatch || normalizedStart) {
          const nextReadback = {
            email: emailMatch ? emailMatch[0] : lastReadback.email,
            start: normalizedStart ? normalizedStart : lastReadback.start,
            raw: finalTurnText
          };
          if (emailMatch && normalizedStart) {
            console.log("READBACK_PARSED", { email: nextReadback.email, start: nextReadback.start });
          }
          lastReadback = nextReadback;
        } else {
          lastReadback.raw = finalTurnText;
        }

        const trimmed = finalTurnText.trim().replace(/["'\s.!?]+$/g, "");
        if (/(book\s*it\??)$/i.test(trimmed)) {
          awaitingBookingConfirm = true;
          const latchPayload = {
            email: lastReadback.email,
            start: lastReadback.start
          };
          if (!lastReadback.email || !lastReadback.start) {
            latchPayload.raw = lastReadback.raw || finalTurnText;
            latchPayload.missingFields = true;
          }
          console.log("ARM_BOOKING_LATCH", latchPayload);
        } else if (lower.includes("book it")) {
          lastReadback.raw = finalTurnText;
        }
      }

      await evaluateBookingTags(currentTurnText, 'completed');
      console.log("TURN_TEXT:", (currentTurnText || "").slice(0, 200));
      console.log('ASSISTANT_TURN_TEXT:', JSON.stringify(currentTurnText));
      loggedDeltaThisTurn = false;
      currentTurnText = "";

      safeSend(twilioWS, JSON.stringify({ event: "mark", streamSid, mark: { name: `lexi_done_${Date.now()}` } }));
    }

    if (evt?.type === "response.canceled") {
      const responseId = evt?.response?.id || evt?.response_id || evt.id || null;
      if (responseId && classifierResponseIds.has(responseId)) {
        classifierResponseIds.delete(responseId);
        classifierTextById.delete(responseId);
        confirmClassificationInFlight = false;
        return;
      }
      hasActiveResponse = false;
      lastResponseId = null;
      lastTTSCompletedAt = Date.now();
      lastAssistantAudioMs = Date.now();
    }

    if (evt?.type === "input_audio_buffer.speech_started") {
      const now = Date.now();
      const msSinceAssistantAudio = now - lastAssistantAudioMs;
      console.log("speech_started", { hasActiveResponse, msSinceAssistantAudio });
      if (hasActiveResponse && lastResponseId && msSinceAssistantAudio < 1200) {
        safeSend(oaiWS, JSON.stringify({ type: "response.cancel", response_id: lastResponseId }));
        lastResponseId = null;
        hasActiveResponse = false;
      }
      safeSend(twilioWS, JSON.stringify({ event: "clear", streamSid }));
      let latchTriggered = false;
      if (awaitingBookingConfirm) {
        const latchRaw = lastReadback.raw || "";
        if (lastReadback.email && lastReadback.start) {
          console.log("CONFIRM_BARGE_IN_BOOK_NOW");
          const payload = {
            name: "Guest",
            email: lastReadback.email,
            start: lastReadback.start,
            leadId: metaLeadId,
            callId: metaCallId,
            source: 'BOOKING_LATCH'
          };
          try {
            await postBookDemo(payload, { label: "BOOKING" });
          } catch (err) {
            console.error("BOOK_DEMO POST failed (latch):", err?.response?.data || err?.message || err);
          }
        } else {
          console.log("LATCH_CONFIRM_BUT_MISSING_FIELDS", { raw: latchRaw });
        }
        awaitingBookingConfirm = false;
        latchTriggered = true;
      }
      if (!latchTriggered && !hasActiveResponse && !pendingResponseRequested) {
        requestDefaultAssistantResponse();
      }
    }

    if (evt?.type === "error") {
      console.error("OpenAI server error event:", evt);
      if (evt?.error?.code === "input_audio_buffer_commit_empty") {
        console.error("[RT] Received empty-commit error. Verify buffer logic & frame sizes.");
      }
    }
  });

  // ----------------- OPENAI SESSION CONFIG -----------------
  oaiWS.on("open", () => {
    console.log("OpenAI WS opened");
    oaiReady = true;
    onOpenAIReady();

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
        session: {
          input_audio_format: "g711_ulaw"
        }
      }));

      drainPending();
      attemptGreet();
      return;
    }

    if (msg.event === "stop") {
      console.log("[TWILIO] stream stopped");
      commitCallerAudio("stream_stop");
      stopSilenceMonitor();
      endRealtimeSession();
      return;
    }

    if (msg.event === "media" && msg.media?.payload) {
      try {
        const b64 = msg?.media?.payload;
        if (!b64) return;
        const frame = Buffer.from(b64, "base64");
        console.log("[AUDIO] recv", frame.length, "bytes");
        handleCallerAudioFrame(frame);
      } catch (e) {
        console.error("[AUDIO] frame error", e);
      }
    }
  });

  const heartbeat = setInterval(() => {
    try { if (oaiWS.readyState === 1) oaiWS.ping(); } catch {}
  }, HEARTBEAT_MS);

  async function endRealtimeSession() {
    try {
      if (audioBuf) audioBuf.flush("session-end");
      if (bytesSinceLastCommit > 0 && oaiReady && oaiWS.readyState === WebSocket.OPEN) {
        safeSend(oaiWS, JSON.stringify({ type: "input_audio_buffer.commit" }));
        bytesSinceLastCommit = 0;
      }
      if (oaiWS.readyState === WebSocket.OPEN || oaiWS.readyState === WebSocket.CONNECTING) {
        try { oaiWS.close(); } catch {}
      }
      console.log("[RT] realtime closed gracefully");
    } catch (e) {
      console.error("[RT] realtime close error", e);
    } finally {
      audioBuf?.reset?.();
      audioBuf = null;
    }
  }

  async function closeAll() {
    if (closed) return;
    closed = true;
    clearInterval(heartbeat);
    stopSilenceMonitor();
    pendingCallerFrames.length = 0;
    pendingCommitReason = null;
    await endRealtimeSession();
    try { twilioWS.close(); } catch {}
    if (oaiWS.readyState !== WebSocket.CLOSED && oaiWS.readyState !== WebSocket.CLOSING) {
      try { oaiWS.close(); } catch {}
    }
  }

  twilioWS.on("close", closeAll);
  twilioWS.on("error", (e) => { console.error("Twilio WS error:", e); closeAll(); });
  oaiWS.on("close", closeAll);
  oaiWS.on("error", (e) => {
    console.error("OpenAI WS error:", e);
    if (e?.error?.code === "input_audio_buffer_commit_empty") {
      console.error("[RT] Received empty-commit error. Verify buffer logic & frame sizes.");
    }
  });

});
