const express = require('express');
const router = express.Router();
const { getAppToken, createGraphEvent } = require('../graph-calendar');
const { sendDemoInviteEmail } = require('../email-invite');

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
  try {
    const {
      email,
      start,
      subject = 'Wave Demo',
      location = 'Online',
      meetingLink,              // optional: include in email body if SMTP path is used
    } = req.body || {};

    if (!email || !start) {
      console.warn(`[BOOK ${rid}] missing fields`, { email: !!email, start: !!start });
      return res.status(400).json({ error: 'email and start required' });
    }

    const organizer = process.env.DEMO_ORGANIZER_UPN || process.env.ORGANIZER_EMAIL;
    if (!organizer) {
      console.warn('[BOOK] Organizer not configured; set DEMO_ORGANIZER_UPN or ORGANIZER_EMAIL');
      return res.status(500).json({ error: 'Organizer not configured' });
    }

    // Normalize start; use 10-minute demo by default
    const startISO = normalizeStartISO(start);
    if (!startISO) {
      console.warn(`[BOOK ${rid}] invalid start datetime`, { start });
      return res.status(400).json({ error: 'invalid start datetime' });
    }
    const endISO = new Date(new Date(startISO).getTime() + 10 * 60000).toISOString();

    const useSmtpPrimary = isOn(process.env.HOTFIX_EMAIL_PRIMARY);
    const allowSmtpFallback = isOn(process.env.HOTFIX_EMAIL_FALLBACK);

    // --- SMTP PRIMARY (hotfix mode) ---
    if (useSmtpPrimary) {
      console.log(`[BOOK ${rid}] SMTP primary path`, { email, startISO, location });
      const mail = await sendDemoInviteEmail({
        to: email,
        start: startISO,
        subject,
        location,
        meetingLink,
        organizerEmail: organizer,
        organizerName: process.env.ORGANIZER_NAME || 'Wave',
      });
      console.log(`[BOOK ${rid}] SMTP primary SUCCESS`, { messageId: mail.messageId, id: mail.id });
      return res.status(201).json({ ok: true, id: mail.id, method: 'smtp', messageId: mail.messageId });
    }

    // --- GRAPH PRIMARY ---
    try {
      console.log(`[BOOK ${rid}] GRAPH creating invite`, { email, startISO, endISO, location });
      console.log('[GRAPH] acquiring app token…');
      const token = await getAppToken();
      console.log('[GRAPH] token OK');

      const result = await createGraphEvent({
        token,
        organizer,
        eventInput: { email, subject, startISO, endISO, location },
        logger: console,
      });

      if (result?.id) {
        console.log(`[BOOK ${rid}] GRAPH SUCCESS eventId=${result.id}`);
        return res.status(201).json({ ok: true, id: result.id, eventId: result.id, method: 'graph' });
      }

      console.warn(`[BOOK ${rid}] GRAPH returned no id${allowSmtpFallback ? ' → falling back to SMTP' : ''}`, { result });
      if (!allowSmtpFallback) {
        return res.status(400).json({ ok: false, error: 'graph_create_failed', detail: result || null });
      }
      // fall through to SMTP
    } catch (err) {
      console.warn(`[BOOK ${rid}] GRAPH error${allowSmtpFallback ? ' → falling back to SMTP' : ''}`, {
        status: err?.status || 0,
        body: err?.body,
        message: err?.message,
      });
      if (!allowSmtpFallback) {
        return res.status(502).json({ ok: false, error: 'graph_create_failed', detail: err?.body || err?.message });
      }
      // fall through to SMTP
    }

    // --- SMTP FALLBACK ---
    console.log(`[BOOK ${rid}] SMTP fallback path`, { email, startISO, location });
    const mail = await sendDemoInviteEmail({
      to: email,
      start: startISO,
      subject,
      location,
      meetingLink,
      organizerEmail: organizer,
      organizerName: process.env.ORGANIZER_NAME || 'Wave',
    });
    console.log(`[BOOK ${rid}] SMTP fallback SUCCESS`, { messageId: mail.messageId, id: mail.id });
    return res.status(201).json({ ok: true, id: mail.id, method: 'smtp', messageId: mail.messageId });

  } catch (err) {
    console.error(`[BOOK ${rid}] FAILED`, {
      status: err?.status || 0,
      body: err?.body,
      message: err?.message,
      stack: err?.stack,
    });
    return res.status(500).json({ ok: false, error: 'booking_failed', detail: err?.body || err?.message });
  }
});

module.exports = router;
