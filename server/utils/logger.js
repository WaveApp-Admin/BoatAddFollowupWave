// server/utils/logger.js
/**
 * Structured JSON logger for consistent single-line logging
 * Each log entry is a single JSON line with: { ts, level, msg, ...context }
 */

function createLogger(context = {}) {
  const { rid, leadId, callId, stage } = context;

  function log(level, msg, extra = {}) {
    const entry = {
      ts: new Date().toISOString(),
      level,
      msg,
    };

    // Add context fields if present
    if (rid) entry.rid = rid;
    if (leadId) entry.leadId = leadId;
    if (callId) entry.callId = callId;
    if (stage) entry.stage = stage;

    // Merge any additional fields
    Object.assign(entry, extra);

    // Output as single-line JSON
    console.log(JSON.stringify(entry));
  }

  return {
    debug: (msg, extra) => log("debug", msg, extra),
    info: (msg, extra) => log("info", msg, extra),
    warn: (msg, extra) => log("warn", msg, extra),
    error: (msg, extra) => log("error", msg, extra),
  };
}

module.exports = { createLogger };
