// email-invite.js
const nodemailer = require('nodemailer');
const crypto = require('crypto');

// Circuit breaker state per transport
const circuitState = {
  smtp: { failures: 0, lastFailure: 0, isOpen: false },
  graph: { failures: 0, lastFailure: 0, isOpen: false },
};

const CIRCUIT_THRESHOLD = 5; // Open circuit after 5 consecutive failures
const CIRCUIT_WINDOW_MS = 2 * 60 * 1000; // 2 minutes
const CIRCUIT_RESET_MS = 2 * 60 * 1000; // Auto-close after 2 minutes

function checkCircuit(transport) {
  const state = circuitState[transport];
  if (!state) return false;

  const now = Date.now();
  
  // Auto-close if enough time has passed
  if (state.isOpen && now - state.lastFailure > CIRCUIT_RESET_MS) {
    state.isOpen = false;
    state.failures = 0;
    const log = require('./server/utils/logger').createLogger({ stage: 'email' });
    log.info('email-transport-circuit-closed', { transport });
  }

  return state.isOpen;
}

function recordFailure(transport) {
  const state = circuitState[transport];
  if (!state) return;

  const now = Date.now();
  
  // Reset counter if outside window
  if (now - state.lastFailure > CIRCUIT_WINDOW_MS) {
    state.failures = 1;
  } else {
    state.failures++;
  }
  
  state.lastFailure = now;

  // Open circuit if threshold exceeded
  if (state.failures >= CIRCUIT_THRESHOLD && !state.isOpen) {
    state.isOpen = true;
    const log = require('./server/utils/logger').createLogger({ stage: 'email' });
    log.warn('email-transport-circuit-open', { 
      transport, 
      failures: state.failures,
      windowMs: CIRCUIT_WINDOW_MS,
    });
  }
}

function recordSuccess(transport) {
  const state = circuitState[transport];
  if (!state) return;
  
  state.failures = 0;
  if (state.isOpen) {
    state.isOpen = false;
    const log = require('./server/utils/logger').createLogger({ stage: 'email' });
    log.info('email-transport-circuit-closed', { transport });
  }
}

function fmtICS(dt) {
  return new Date(dt).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
}
function normStartISO(input) {
  const d = new Date(input);
  if (isNaN(d.getTime())) throw new Error('Invalid start datetime');
  const z = new Date(Date.UTC(
    d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(),
    d.getUTCHours(), d.getUTCMinutes(), 0, 0
  ));
  return z.toISOString().replace(/\.\d{3}Z$/, 'Z');
}
function escICS(s = '') {
  return String(s)
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\n/g, '\\n');
}

async function makeTransport() {
  if (process.env.SMTP_URL) return nodemailer.createTransport(process.env.SMTP_URL);
  const { SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, SMTP_SECURE } = process.env;
  if (!SMTP_HOST) throw new Error('Missing SMTP_HOST or SMTP_URL');
  return nodemailer.createTransport({
    host: SMTP_HOST,
    port: Number(SMTP_PORT || 587),
    secure: String(SMTP_SECURE || '').toLowerCase() === 'true',
    auth: SMTP_USER ? { user: SMTP_USER, pass: SMTP_PASS } : undefined,
    pool: true, // Enable connection pooling
    maxConnections: 5,
    maxMessages: 100,
    // Explicit timeouts
    connectionTimeout: 10000, // 10 seconds
    greetingTimeout: 5000,
    socketTimeout: 15000,
  });
}

let transporterPromise = null;

async function getTransporter() {
  if (!transporterPromise) {
    transporterPromise = (async () => {
      const transporter = await makeTransport();
      return transporter;
    })();
  }
  try {
    return await transporterPromise;
  } catch (err) {
    transporterPromise = null;
    throw err;
  }
}

async function verifySmtpOnBoot() {
  try {
    const transporter = await getTransporter();
    await transporter.verify();
    console.log('[SMTP_READY]', { host: transporter.options?.host || 'unknown' });
  } catch (err) {
    console.warn('[SMTP_READY_FAIL]', String(err?.message || err));
  }
}

function isTransientError(err) {
  if (!err) return false;
  const code = err.code || '';
  const message = (err.message || '').toLowerCase();
  
  // Network errors
  if (['ENOTFOUND', 'ETIMEDOUT', 'ECONNRESET', 'ECONNREFUSED'].includes(code)) {
    return true;
  }
  
  // SMTP 5xx errors (server errors)
  if (err.responseCode && err.responseCode >= 500) {
    return true;
  }
  
  // Timeout messages
  if (message.includes('timeout') || message.includes('timed out')) {
    return true;
  }
  
  return false;
}

async function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Send a 10-minute demo invite via email (.ics attachment).
 * @param {Object} p
 * @param {string} p.to
 * @param {string} p.start  ISO string (any TZ)
 * @param {string} [p.subject]
 * @param {string} [p.location]
 * @param {string} [p.organizerEmail]
 * @param {string} [p.organizerName]
 * @param {string} [p.meetingLink]
 * @param {Object} [logger] Optional logger instance
 */
async function sendDemoInviteEmail(p, logger = null) {
  const log = logger || require('./server/utils/logger').createLogger({ stage: 'email' });
  
  // Check circuit breaker
  if (checkCircuit('smtp')) {
    const err = new Error('SMTP circuit breaker is open');
    err.code = 'CIRCUIT_OPEN';
    log.warn('email-send-failed', { 
      via: 'smtp',
      error: 'circuit_open',
      reason: 'Circuit breaker is open due to repeated failures',
    });
    throw err;
  }
  
  const startISO = normStartISO(p.start);
  const organizerEmail =
    p.organizerEmail || process.env.ORGANIZER_EMAIL || process.env.DEMO_ORGANIZER_UPN;
  const organizerName = p.organizerName || process.env.ORGANIZER_NAME || 'Wave';
  if (!organizerEmail) throw new Error('Missing organizer email');

  const uid = crypto.randomUUID();
  const ics = [
    'BEGIN:VCALENDAR',
    'PRODID:-//Wave//Demo Invite//EN',
    'VERSION:2.0',
    'METHOD:REQUEST',
    'BEGIN:VEVENT',
    `UID:${uid}`,
    `DTSTAMP:${fmtICS(new Date())}`,
    `DTSTART:${fmtICS(startISO)}`,
    `DURATION:PT10M`,
    `SUMMARY:${escICS(p.subject || 'Wave Demo')}`,
    `DESCRIPTION:${escICS(
      `Quick 10-minute Wave demo.${p.meetingLink ? `\nJoin: ${p.meetingLink}` : ''}`
    )}`,
    `LOCATION:${escICS(p.location || 'Online')}`,
    `ORGANIZER;CN=${escICS(organizerName)}:mailto:${organizerEmail}`,
    `ATTENDEE;CN=${escICS(p.to)};ROLE=REQ-PARTICIPANT;RSVP=TRUE:mailto:${p.to}`,
    'END:VEVENT',
    'END:VCALENDAR',
    '',
  ].join('\r\n');

  const mailOptions = {
    from: `${organizerName} <${organizerEmail}>`,
    to: p.to,
    bcc: process.env.INVITE_BCC || undefined,
    replyTo: process.env.REPLY_TO || organizerEmail,
    subject: p.subject || 'Wave Demo',
    text: `Inviting you to a quick demo.\nStarts: ${startISO}\nLocation: ${
      p.location || 'Online'
    }\n${p.meetingLink || ''}`,
    html: `<p>Inviting you to a quick demo.</p>
           <p><b>Starts:</b> ${startISO}</p>
           <p><b>Location:</b> ${escICS(p.location || 'Online')}</p>
           ${p.meetingLink ? `<p><a href="${p.meetingLink}">Join link</a></p>` : ''}
           <p>Accept the calendar invite attached.</p>`,
    alternatives: [
      {
        contentType: 'text/calendar; method=REQUEST; charset=UTF-8',
        content: ics,
      },
    ],
    attachments: [
      {
        filename: 'invite.ics',
        content: ics,
        contentType: 'text/calendar; method=REQUEST; name="invite.ics"',
      },
    ],
  };

  // Retry logic with exponential backoff
  const delays = [400, 1200, 3000]; // milliseconds
  let lastError = null;

  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const transporter = await getTransporter();
      log.debug('email-send-attempt', { 
        attempt, 
        to: p.to,
        hasMeetingLink: Boolean(p.meetingLink),
      });
      
      const info = await transporter.sendMail(mailOptions);
      
      // Positive ack check: require messageId and check for 250 response
      if (!info.messageId) {
        throw new Error('No messageId in SMTP response');
      }
      
      // Check for successful SMTP response (250)
      const response = info.response || '';
      if (response && !response.includes('250')) {
        log.warn('email-send-suspicious-response', { 
          messageId: info.messageId,
          response,
        });
      }
      
      recordSuccess('smtp');
      log.info('email-send-ok', { 
        via: 'smtp',
        messageId: info.messageId,
        to: p.to,
        attempt,
      });
      
      return { id: uid, messageId: info.messageId, start: startISO };
      
    } catch (err) {
      lastError = err;
      
      // Check if this is a transient error
      if (!isTransientError(err) || attempt === 3) {
        // Non-transient error or final attempt - record failure and throw
        recordFailure('smtp');
        log.error('email-send-failed', {
          via: 'smtp',
          attempt,
          error: err.message,
          code: err.code,
          responseCode: err.responseCode,
          to: p.to,
        });
        throw err;
      }
      
      // Transient error - retry with backoff
      const delay = delays[attempt - 1] || 1000;
      log.warn('email-send-retry', {
        via: 'smtp',
        attempt,
        error: err.message,
        code: err.code,
        nextAttemptIn: delay,
      });
      
      await sleep(delay);
    }
  }
  
  // Should never reach here, but just in case
  recordFailure('smtp');
  throw lastError || new Error('Email send failed after retries');
}

module.exports = { sendDemoInviteEmail, verifySmtpOnBoot, getTransporter };
