// ------------ Twilio <-> OpenAI bridge (permanent version) ------------
const SAMPLE_RATE = 8000; // Twilio uses 8kHz; keep OpenAI at 8kHz to avoid resampling
const MAX_BUFFER_MS = 4000; // cap input buffer to avoid runaway
const SILENCE_MS = 700;     // commit after ~700ms silence (feels snappy)
const HEARTBEAT_MS = 25000;

function mulawDecode(u8) {
  // µ-law -> PCM16 (Uint8Array)
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
  // PCM16 -> µ-law (Uint8Array)
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

// Simple energy detector for silence (on PCM16)
function isSilent(pcmBuf) {
  if (!pcmBuf || pcmBuf.length === 0) return true;
  const view = new Int16Array(pcmBuf.buffer, pcmBuf.byteOffset, pcmBuf.byteLength / 2);
  let sum = 0;
  for (let i = 0; i < view.length; i += 80) { // sample subset to keep CPU low
    const v = view[i];
    sum += Math.abs(v);
  }
  const avg = sum / Math.max(1, Math.floor(view.length / 80));
  return avg < 500; // tune if needed; 300–800 is a good range for 8kHz telephone audio
}

wss.on("connection", (twilioWS, req) => {
  const oaiWS = new WebSocket(
    "wss://api.openai.com/v1/realtime?model=gpt-4o-realtime",
    { headers: { Authorization: `Bearer ${OPENAI_API_KEY}` } }
  );

  // Buffers & timers
  let inputChunks = [];          // PCM16 chunks awaiting send
  let totalBufferedMs = 0;       // best-effort estimate
  let lastVoiceTime = Date.now();// last time we saw non-silent audio
  let speaking = false;          // true when we’re sending user speech
  let closed = false;

  function safeSend(ws, payload) {
    if (ws.readyState === 1) ws.send(payload);
  }

  // ------------ OPENAI -> TWILIO (play assistant audio) ------------
  oaiWS.on("message", (raw) => {
    try {
      const evt = JSON.parse(raw.toString());
      if (evt.type === "response.output_text.delta") {
        // Text tokens (optional log)
        // console.log("OAI text:", evt.delta);
      }
      if (evt.type === "output_audio_chunk.delta" && evt.delta) {
        // evt.delta is base64 PCM16 (8kHz)
        const pcm = Buffer.from(evt.delta, "base64");
        const ulaw = mulawEncode(new Uint8Array(pcm));
        const payload = Buffer.from(ulaw).toString("base64");

        // Send to Twilio as a media frame
        safeSend(twilioWS, JSON.stringify({ event: "media", media: { payload } }));
      }
      if (evt.type === "response.completed") {
        // Mark end of assistant turn if needed (Twilio will keep line open)
      }
    } catch (e) {
      console.error("OAI->Twilio error:", e);
    }
  });

  // ------------ OPENAI session setup ------------
  oaiWS.on("open", () => {
    let leadId = "", callId = "";
    try {
      const url = new URL(`https://${PUBLIC_HOST}${req.url}`);
      leadId = url.searchParams.get("leadId") || "";
      callId  = url.searchParams.get("callId") || "";
    } catch {}

    const sessionUpdate = {
      type: "session.update",
      session: {
        instructions: LEXI_PROMPT,
        modalities: ["audio", "text"],
        voice: "alloy",
        input_audio_format:  { type: "pcm16", sample_rate: SAMPLE_RATE },
        output_audio_format: { type: "pcm16", sample_rate: SAMPLE_RATE },
        turn_detection: { type: "server_vad", threshold: 0.45 }, // OAI’s internal VAD as a helper
        metadata: { leadId, callId }
      }
    };
    safeSend(oaiWS, JSON.stringify(sessionUpdate));
  });

  // ------------ TWILIO -> OPENAI (ingest caller audio) ------------
  function flushToOpenAI(force = false) {
    if (inputChunks.length === 0) return;
    const now = Date.now();
    const sinceVoice = now - lastVoiceTime;

    // If we’re forcing (timeout/silence), send what we have
    if (force || sinceVoice >= SILENCE_MS) {
      const chunk = Buffer.concat(inputChunks);
      inputChunks = [];
      totalBufferedMs = 0;

      // 1) Append audio
      safeSend(oaiWS, JSON.stringify({
        type: "input_audio_buffer.append",
        audio: chunk.toString("base64")
      }));
      // 2) Commit + request a response
      safeSend(oaiWS, JSON.stringify({ type: "input_audio_buffer.commit" }));
      safeSend(oaiWS, JSON.stringify({
        type: "response.create",
        response: { modalities: ["audio"] }
      }));
      speaking = false;
      return;
    }
  }

  twilioWS.on("message", (raw) => {
    try {
      const msg = JSON.parse(raw.toString());

      // Twilio stream lifecycle frames
      if (msg.event === "start") {
        // console.log("Twilio stream started", msg.start);
        return;
      }
      if (msg.event === "stop") {
        // console.log("Twilio stream stopped");
        flushToOpenAI(true);
        return;
      }

      // Audio frames
      if (msg.event === "media" && msg.media && msg.media.payload) {
        const ulawB64 = msg.media.payload;
        const ulaw = Buffer.from(ulawB64, "base64");
        const pcmU8 = mulawDecode(new Uint8Array(ulaw));
        const pcmBuf = Buffer.from(pcmU8);

        // Silence detection
        const now = Date.now();
        const silent = isSilent(pcmBuf);
        if (!silent) {
          lastVoiceTime = now;
          speaking = true;
        }

        // Buffer the PCM for later flush
        inputChunks.push(pcmBuf);
        // ~1 byte PCM16 ≈ 0.0625ms at 8kHz mono (2 bytes/sample). For simple bound:
        totalBufferedMs += Math.round((pcmBuf.length / 2) / SAMPLE_RATE * 1000);
        if (totalBufferedMs > MAX_BUFFER_MS) {
          // Prevent runaway memory if caller is silent but frames keep arriving
          flushToOpenAI(true);
        } else {
          // If silence long enough and we have something, flush
          if (!speaking) flushToOpenAI();
        }
      }
    } catch (e) {
      console.error("Twilio->OAI parse error:", e);
    }
  });

  // ------------ Keep-alive + cleanup ------------
  const heartbeat = setInterval(() => {
    try {
      if (twilioWS.readyState === 1) twilioWS.ping();
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
  twilioWS.on("error", closeAll);
  oaiWS.on("close", closeAll);
  oaiWS.on("error", closeAll);
});
