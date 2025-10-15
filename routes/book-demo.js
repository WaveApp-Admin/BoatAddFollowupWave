const express = require('express');
const router = express.Router();
const { getAppToken, createGraphEvent } = require('../graph-calendar');
const { sendDemoInviteEmail } = require('../email-invite');
const { normalizeEmail } = require('../email-utils'); // ✅ sanitize email inputs
const { checkAndRegister } = require('../server/utils/idempotency');
const { createLogger } = require('../server/utils/logger');
const { canonicalizeISO } = require('../server/utils/slots');

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

function isOn(value) {
  if (!value) return false;
  const s = String(value).toLowerCase();
  return s === '1' || s === 'true' || s === 'yes' || s === 'on';
}

router.post('/schedule-demo-graph', async (req, res) => {
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

    const organizer = process.env.DEMO_ORGANIZER_UPN || process.env.ORGANIZER_EMAIL;
    if (!organizer) {
      log.warn('organizer-not-configured');
      return res.status(500).json({ error: 'Organizer not configured' });
    }

    // Normalize start; use 10-minute demo by default
    let startISO = normalizeStartISO(start);
    if (!startISO) {
      log.warn('invalid-start', { start });
      return res.status(400).json({ error: 'invalid start datetime' });
    }
    
    // Canonicalize to ensure consistent format
    startISO = canonicalizeISO(startISO);
    const endISO = new Date(new Date(startISO).getTime() + 10 * 60000).toISOString();

    // Check idempotency - prevent duplicate bookings within 15 minutes
    const idempotency = checkAndRegister(email, startISO);
    if (idempotency.isDuplicate) {
      log.info('duplicate-booking', {
        bookKey: idempotency.bookKey,
        email,
        startISO,
      });
      return res.status(409).json({ 
        error: 'Duplicate booking', 
        bookKey: idempotency.bookKey,
        cached: idempotency.cached,
      });
    }

    const useSmtpPrimary = isOn(process.env.HOTFIX_EMAIL_PRIMARY);
    const allowSmtpFallback = isOn(process.env.HOTFIX_EMAIL_FALLBACK);

    // --- SMTP PRIMARY (hotfix mode) ---
    if (useSmtpPrimary) {
      log.info('smtp-primary', { email, startISO, location });
      const mail = await sendDemoInviteEmail({
        to: email,
        start: startISO,
        subject,
        location,
        meetingLink,
        organizerEmail: organizer,
        organizerName: process.env.ORGANIZER_NAME || 'Wave',
      });
      log.info('booked-via-smtp', { 
        messageId: mail.messageId, 
        id: mail.id,
        bookKey: idempotency.bookKey,
      });
      return res.status(201).json({ ok: true, id: mail.id, method: 'smtp', messageId: mail.messageId });
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
        return res.status(201).json({ ok: true, id: result.id, eventId: result.id, method: 'graph' });
      }

      log.warn('graph-no-id', { 
        result,
        fallback: allowSmtpFallback,
      });
      if (!allowSmtpFallback) {
        return res.status(400).json({ ok: false, error: 'graph_create_failed', detail: result || null });
      }
      // fall through to SMTP
    } catch (err) {
      log.warn('graph-error', {
        status: err?.status || 0,
        body: err?.body,
        message: err?.message,
        fallback: allowSmtpFallback,
      });
      if (!allowSmtpFallback) {
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
    });
    log.info('booked-via-smtp', { 
      messageId: mail.messageId, 
      id: mail.id,
      bookKey: idempotency.bookKey,
    });
    return res.status(201).json({ ok: true, id: mail.id, method: 'smtp', messageId: mail.messageId });

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
