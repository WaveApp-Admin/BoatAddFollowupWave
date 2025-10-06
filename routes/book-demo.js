const express = require('express');
const router = express.Router();
const { getAppToken, createGraphEvent } = require('../graph-calendar');

router.post('/schedule-demo-graph', async (req, res) => {
  const rid = req.rid || 'no-rid';
  try {
    const { email, start, subject = 'Wave Demo', location = 'Online', leadId, callId, fullText } = req.body || {};
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
      email, 
      startISO, 
      endISO, 
      location, 
      organizer,
      leadId, 
      callId, 
      hasFullText: !!fullText 
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

    console.log(`[BOOK ${rid}] SUCCESS eventId=${result?.id}`, { attendee: email, organizer });
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

module.exports = router;
