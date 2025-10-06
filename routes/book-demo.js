const express = require('express');
const router = express.Router();
const { getAppToken, createGraphEvent } = require('../graph-calendar');

router.post('/schedule-demo-graph', async (req, res) => {
  const rid = req.rid || 'no-rid';
  try {
    const { email, start, subject = 'Wave Demo', location = 'Online', fullText, leadId, callId } = req.body || {};
    if (!email || !start) {
      console.warn(`[BOOK ${rid}] missing fields`, { email, start });
      return res.status(400).json({ error: 'email and start required' });
    }
    const organizer = process.env.DEMO_ORGANIZER_UPN || process.env.ORGANIZER_EMAIL;
    if (!organizer) {
      console.warn('[GRAPH] Organizer not configured; set DEMO_ORGANIZER_UPN or ORGANIZER_EMAIL');
      return res.status(500).json({ error: 'Organizer not configured' });
    }
    const startISO = new Date(start).toISOString();
    const endISO = new Date(new Date(startISO).getTime() + 30 * 60000).toISOString();

    console.log(`[BOOK ${rid}] creating invite`, {
      organizer,
      attendee: email,
      startISO,
      endISO,
      location,
      hasFullText: Boolean(fullText),
      leadId: leadId || '(none)',
      callId: callId || '(none)'
    });

    console.log('[GRAPH] acquiring app token…');
    const token = await getAppToken();
    console.log('[GRAPH] token OK');

    const result = await createGraphEvent({
      token,
      organizer,
      eventInput: { email, subject, startISO, endISO, location },
      logger: console,
    });

    console.log(`[BOOK ${rid}] SUCCESS eventId=${result?.id}`);
    res.status(201).json({ ok: true, id: result?.id || null, eventId: result?.id || null });
  } catch (err) {
    console.error(`[BOOK ${rid}] FAILED`, {
      status: err?.status || 0,
      body: err?.body,
      message: err?.message,
      stack: err?.stack,
    });
    res.status(502).json({ ok: false, error: 'graph_create_failed', detail: err?.body || err?.message });
  }
});

// Debug endpoint (only when DEBUG_BOOKING is truthy)
if (process.env.DEBUG_BOOKING && process.env.DEBUG_BOOKING !== '0' && process.env.DEBUG_BOOKING !== 'false') {
  router.post('/__debug/force-book', async (req, res) => {
    const rid = req.rid || 'debug';
    try {
      const { email, start, leadId = 'debug', callId = 'debug' } = req.body || {};
      if (!email || !start) {
        console.warn(`[DEBUG_BOOK ${rid}] missing fields`, { email, start });
        return res.status(400).json({ error: 'email and start required' });
      }

      console.log(`[DEBUG_BOOK ${rid}] forcing booking`, { email, start, leadId, callId });

      // Normalize start time (add seconds if missing, enforce Z)
      let normalizedStart = start;
      if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(start)) {
        normalizedStart = `${start}:00`;
      }
      const startDate = new Date(normalizedStart);
      if (isNaN(startDate.getTime())) {
        return res.status(400).json({ error: 'invalid start time' });
      }
      const startISO = startDate.toISOString().replace('.000Z', 'Z');

      const organizer = process.env.DEMO_ORGANIZER_UPN || process.env.ORGANIZER_EMAIL;
      if (!organizer) {
        console.warn('[DEBUG_BOOK] Organizer not configured');
        return res.status(500).json({ error: 'Organizer not configured' });
      }

      const endISO = new Date(new Date(startISO).getTime() + 30 * 60000).toISOString();

      console.log(`[DEBUG_BOOK ${rid}] normalized ISO`, { startISO, endISO });

      const token = await require('../graph-calendar').getAppToken();
      const result = await require('../graph-calendar').createGraphEvent({
        token,
        organizer,
        eventInput: { email, subject: 'Wave Demo (Debug)', startISO, endISO, location: 'Online' },
        logger: console,
      });

      console.log(`[DEBUG_BOOK ${rid}] SUCCESS eventId=${result?.id}`);
      res.status(201).json({ ok: true, id: result?.id || null, eventId: result?.id || null });
    } catch (err) {
      console.error(`[DEBUG_BOOK ${rid}] FAILED`, {
        status: err?.status || 0,
        body: err?.body,
        message: err?.message,
        stack: err?.stack,
      });
      res.status(500).json({ ok: false, error: 'debug_booking_failed', detail: err?.body || err?.message });
    }
  });
  console.log('[DEBUG] /__debug/force-book endpoint enabled');
}

module.exports = router;
