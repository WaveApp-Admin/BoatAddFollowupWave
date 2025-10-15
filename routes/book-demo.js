const express = require('express');
const router = express.Router();
const { getAppToken, createGraphEvent } = require('../graph-calendar');
const { sendDemoInviteEmail } = require('../email-invite');
const { normalizeEmail } = require('../email-utils'); // ✅ sanitize email inputs
const { checkAndRegister } = require('../server/utils/idempotency');
const { createLogger } = require('../server/utils/logger');
const { canonicalizeISO } = require('../server/utils/slots');
const { createRateLimiter } = require('../server/middleware/rate-limit');

function normalizeStartISO(input) {
  const d = new Date(input);
  if (isNaN(d.getTime())) return null;
  // Zero seconds; force Z
  const z = new Date(Date.UTC(
    d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(),
    d.getUTCHours(), d.getUTCMinutes(), 0, 0
  ));
  return z.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

function parseHotfixFlag(value) {
  if (!value) return null;
  const s = String(value).toLowerCase().trim();
  if (s === 'smtp') return 'smtp';
  if (s === 'graph') return 'graph';
  return null;
}

// Rate limiter for booking endpoint
const bookingRateLimiter = createRateLimiter({
  windowMs: 60000, // 1 minute
  max: 5,
  keyGenerator: (req) => {
    // Rate limit by IP and email
    const ip = req.ip || 'unknown';
    const email = req.body?.email || '';
    return `book:${ip}:${email}`;
  },
  message: 'Too many booking requests',
});

router.post('/schedule-demo-graph', bookingRateLimiter, async (req, res) => {
  const rid = req.rid || 'no-rid';
  const log = req.log || createLogger({ rid, stage: 'book' });
  
  try {
    let {                     // ← let so we can sanitize email
      email,
      start,
      subject = 'Wave Demo',
      location = 'Online',
      meetingLink,            // optional: included in SMTP body
    } = req.body || {};

    // ✅ sanitize the email (handles "www.", " dot ", " at ", stray punctuation)
    email = normalizeEmail(email);

    if (!email || !start) {
      log.warn('missing-fields', { email: !!email, start: !!start });
      return res.status(400).json({ error: 'email and start required' });
    }

    // Validate email format
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email)) {
      log.warn('invalid-email', { email });
      return res.status(400).json({ error: 'invalid email format' });
    }

    // Normalize start; use 10-minute demo by default
    let startISO = normalizeStartISO(start);
    if (!startISO) {
      log.warn('invalid-start', { start });
      return res.status(400).json({ error: 'invalid start datetime' });
    }
    
    // Check if start is in canonical format YYYY-MM-DDTHH:MM:00.000Z
    const canonicalPattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:00\.000Z$/;
    if (!canonicalPattern.test(startISO)) {
      const suggested = canonicalizeISO(startISO);
      log.warn('normalized-start', { 
        input: start, 
        suggested, 
        tz: process.env.SCHED_TZ || process.env.BASE_TZ || 'America/New_York' 
      });
      return res.status(422).json({ 
        error: 'non_canonical', 
        suggested,
        message: 'Start time must be in canonical format: YYYY-MM-DDTHH:MM:00.000Z'
      });
    }
    
    const endISO = new Date(new Date(startISO).getTime() + 10 * 60000).toISOString();

    // Check idempotency EARLY - prevent duplicate bookings within 15 minutes
    const idempotency = checkAndRegister(email, startISO);
    if (idempotency.isDuplicate) {
      log.info('duplicate-booking-suppressed', {
        bookKey: idempotency.bookKey,
        email,
        startISO,
        ttlSec: 900, // 15 minutes
      });
      return res.status(409).json({ 
        duplicated: true,
        bookKey: idempotency.bookKey,
        ttlSec: 900,
      });
    }

    const organizer = process.env.DEMO_ORGANIZER_UPN || process.env.ORGANIZER_EMAIL;
    if (!organizer) {
      log.warn('organizer-not-configured');
      return res.status(500).json({ error: 'Organizer not configured' });
    }

    const primaryMode = parseHotfixFlag(process.env.HOTFIX_EMAIL_PRIMARY) || 'graph';
    const fallbackMode = parseHotfixFlag(process.env.HOTFIX_EMAIL_FALLBACK) || 'smtp';

    // --- SMTP PRIMARY (hotfix mode) ---
    if (primaryMode === 'smtp') {
      log.info('smtp-primary', { email, startISO, location });
      const mail = await sendDemoInviteEmail({
        to: email,
        start: startISO,
        subject,
        location,
        meetingLink,
        organizerEmail: organizer,
        organizerName: process.env.ORGANIZER_NAME || 'Wave',
      }, log);
      log.info('booked-via-smtp', { 
        messageId: mail.messageId, 
        id: mail.id,
        bookKey: idempotency.bookKey,
      });
      return res.status(201).json({ 
        ok: true, 
        id: mail.id, 
        method: 'smtp', 
        messageId: mail.messageId,
        startISO, // Echo canonical startISO
      });
    }

    // --- GRAPH PRIMARY ---
    try {
      log.info('graph-attempt', { email, startISO, endISO, location });
      const token = await getAppToken();

      const result = await createGraphEvent({
        token,
        organizer,
        eventInput: { email, subject, startISO, endISO, location },
        logger: log,
      });

      if (result?.id) {
        log.info('booked-via-graph', { 
          eventId: result.id,
          bookKey: idempotency.bookKey,
        });
        return res.status(201).json({ 
          ok: true, 
          id: result.id, 
          eventId: result.id, 
          method: 'graph',
          startISO, // Echo canonical startISO
        });
      }

      log.warn('graph-no-id', { 
        result,
        fallback: fallbackMode === 'smtp',
      });
      if (fallbackMode !== 'smtp') {
        return res.status(400).json({ ok: false, error: 'graph_create_failed', detail: result || null });
      }
      // fall through to SMTP
    } catch (err) {
      log.warn('graph-error', {
        status: err?.status || 0,
        body: err?.body,
        message: err?.message,
        fallback: fallbackMode === 'smtp',
      });
      if (fallbackMode !== 'smtp') {
        return res.status(502).json({ ok: false, error: 'graph_create_failed', detail: err?.body || err?.message });
      }
      // fall through to SMTP
    }

    // --- SMTP FALLBACK ---
    log.info('smtp-fallback', { email, startISO, location });
    const mail = await sendDemoInviteEmail({
      to: email,
      start: startISO,
      subject,
      location,
      meetingLink,
      organizerEmail: organizer,
      organizerName: process.env.ORGANIZER_NAME || 'Wave',
    }, log);
    log.info('booked-via-smtp', { 
      messageId: mail.messageId, 
      id: mail.id,
      bookKey: idempotency.bookKey,
    });
    return res.status(201).json({ 
      ok: true, 
      id: mail.id, 
      method: 'smtp', 
      messageId: mail.messageId,
      startISO, // Echo canonical startISO
    });

  } catch (err) {
    log.error('booking-failed', {
      status: err?.status || 0,
      body: err?.body,
      message: err?.message,
      stack: err?.stack,
    });
    return res.status(500).json({ ok: false, error: 'booking_failed', detail: err?.body || err?.message });
  }
});

module.exports = router;
