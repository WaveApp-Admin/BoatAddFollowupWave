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

// ------------------------- HTTP ROUTES -------------------------
app.get("/healthz", (_, res) => res.json({ ok: true }));

app.post("/dial", async (req, res) => {
  try {
    console.log("POST /dial payload:", req.body);
    const { to, leadId = "", callId = "" } = req.body;
    if (!to) return res.status(400).json({ error: "`to` (E.164) required" });

    const CLEAN_HOST = (PUBLIC_HOST || "").replace(/^https?:\/\//, "").replace(/\/$/, "");
    const twimlUrl = `https://${CLEAN_HOST}/voice?leadId=${encodeURIComponent(
      leadId
    )}&callId=${encodeURIComponent(callId)}`;

    const call = await twilioClient.calls.create({
      to,
      from: TWILIO_NUMBER,
      url: twimlUrl,
      machineDetection: "Enable"
    });
    res.status(201).json({ sid: call.sid });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: String(e) });
  }
});

app.post("/voice", (req, res) => {
  const CLEAN_HOST = (PUBLIC_HOST || "").replace(/^https?:\/\//, "").replace(/\/$/, "");
  const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Connect>
    <Stream url="wss://${CLEAN_HOST}/ws/twilio"/>
  </Connect>
</Response>`;
  res.type("text/xml").send(twiml);
});

// ------------------------- SERVER + WS -------------------------
const server = app.listen(PORT || 8080, () =>
  console.log(`HTTP listening on ${PORT || 8080}`)
);

const wss = new WebSocketServer({ noServer: true });
server.on("upgrade", (req, socket, head) => {
  if (req.url && req.url.startsWith("/ws/twilio")) {
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
  } else {
    socket.destroy();
  }
});

// ------------ Twilio <-> OpenAI bridge ------------
const SAMPLE_RATE = 8000; // Twilio uses 8kHz
const MAX_BUFFER_MS = 4000;
const SILENCE_MS = 700;
const HEARTBEAT_MS = 25000;
const TWILIO_FRAME_BYTES = 160; // 20ms of μ-law @ 8kHz (1 byte/sample)

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
  return avg < 500; // tweak if needed
}

wss.on("connection", (twilioWS, req) => {
  const oaiWS = new WebSocket(
    "wss://api.openai.com/v1/realtime?model=gpt-4o-realtime",
    { headers: { Authorization: `Bearer ${OPENAI_API_KEY}` } }
  );

  let streamSid = null;          // Twilio stream ID for outbound frames
  let inputChunks = [];          // buffered PCM16 from caller
  let totalBufferedMs = 0;
  let lastVoiceTime = Date.now();
  let speaking = false;
  let closed = false;

  const CLEAN_HOST = (PUBLIC_HOST || "").replace(/^https?:\/\//, "").replace(/\/$/, "");

  function safeSend(ws, payload) {
    if (ws.readyState === 1) ws.send(payload);
  }

  // Break outgoing μ-law into 20ms frames for Twilio
  function sendUlawInFrames(ulawBytes) {
    if (!streamSid || !ulawBytes || ulawBytes.length === 0) return;
    let offset = 0;
    while (offset < ulawBytes.length) {
      const end = Math.min(offset + TWILIO_FRAME_BYTES, ulawBytes.length);
      const frame = ulawBytes.subarray(offset, end);
      const payload = Buffer.from(frame).toString("base64");
      safeSend(twilioWS, JSON.stringify({
        event: "media",
        streamSid,
        media: { payload, track: "outbound" }
      }));
      offset = end;
    }
  }

  // OpenAI WS diagnostics
  oaiWS.on("error", (err) => console.error("OpenAI WS error:", err));
  oaiWS.on("close", (code, reason) => console.log("OpenAI WS closed:", code, reason?.toString()));

  // OPENAI -> TWILIO (assistant audio back to caller)
  oaiWS.on("message", (raw) => {
    try {
      const evt = JSON.parse(raw.toString());

      if (evt.type === "response.output_text.delta" && evt.delta) {
        // console.log("OAI text:", evt.delta);
      }

      if (evt.type === "output_audio_chunk.delta" && evt.delta) {
        if (!streamSid) return;
        const pcm = Buffer.from(evt.delta, "base64");            // PCM16 @ 8kHz
        const ulaw = mulawEncode(new Uint8Array(pcm));           // -> μ-law
        sendUlawInFrames(ulaw);                                  // 20ms frames
      }
    } catch (e) {
      console.error("OAI->Twilio error:", e);
    }
  });

  // Configure OpenAI session and proactively trigger greeting
  oaiWS.on("open", () => {
    let leadId = "", callId = "";
    try {
      const url = new URL(`https://${CLEAN_HOST}${req.url}`);
      leadId = url.searchParams.get("leadId") || "";
      callId  = url.searchParams.get("callId") || "";
    } catch {}

    safeSend(oaiWS, JSON.stringify({
      type: "session.update",
      session: {
        instructions: LEXI_PROMPT,
        modalities: ["audio", "text"],
        voice: "alloy",
        input_audio_format:  { type: "pcm16", sample_rate: SAMPLE_RATE },
        output_audio_format: { type: "pcm16", sample_rate: SAMPLE_RATE },
        turn_detection: { type: "server_vad", threshold: 0.45 },
        metadata: { leadId, callId }
      }
    }));

    // Kick off a first spoken response so Lexi greets immediately
    safeSend(oaiWS, JSON.stringify({
      type: "response.create",
      response: {
        modalities: ["audio"],
        instructions: "Start with a brief friendly greeting as Lexi from Wave and ask if they can open the Wave app so we can add their boat now."
      }
    }));
  });

  function flushToOpenAI(force = false) {
    if (inputChunks.length === 0) return;
    const now = Date.now();
    const sinceVoice = now - lastVoiceTime;
    if (force || sinceVoice >= SILENCE_MS) {
      const chunk = Buffer.concat(inputChunks);
      inputChunks = [];
      totalBufferedMs = 0;

      safeSend(oaiWS, JSON.stringify({
        type: "input_audio_buffer.append",
        audio: chunk.toString("base64")
      }));
      safeSend(oaiWS, JSON.stringify({ type: "input_audio_buffer.commit" }));
      safeSend(oaiWS, JSON.stringify({
        type: "response.create",
        response: { modalities: ["audio"] }
      }));
      speaking = false;
    }
  }

  // TWILIO -> OPENAI (ingest caller audio + capture streamSid)
  twilioWS.on("message", (raw) => {
    try {
      const msg = JSON.parse(raw.toString());

      if (msg.event === "start") {
        streamSid = msg.start?.streamSid || null;
        console.log("Twilio stream started", { streamSid });
        return;
      }
      if (msg.event === "stop") {
        console.log("Twilio stream stopped");
        flushToOpenAI(true);
        return;
      }

      if (msg.event === "media" && msg.media && msg.media.payload) {
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
        } else {
          if (!speaking) flushToOpenAI();
        }
      }
    } catch (e) {
      console.error("Twilio->OAI parse error:", e);
    }
  });

  // Keep-alive & cleanup (DO NOT ping Twilio: binary ping causes 31950)
  const heartbeat = setInterval(() => {
    try {
      if (oaiWS.readyState === 1) oaiWS.ping();
    } catch {}
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

