const express = require('express');
const router = express.Router();
const { createCalendarInvite } = require('../graph-calendar');

router.post('/schedule-demo-graph', async (req, res) => {
  const rid = req.rid || 'no-rid';
  try {
    const { email, start, subject, location } = req.body || {};
    if (!email || !start) {
      console.warn(`[BOOK ${rid}] missing fields`, { email, start });
      return res.status(400).json({ error: 'email and start required' });
    }
    const startISO = new Date(start).toISOString();
    const endISO = new Date(new Date(startISO).getTime() + 30 * 60000).toISOString();

    console.log(`[BOOK ${rid}] creating invite`, { email, startISO, endISO });

    const evt = await createCalendarInvite({
      subject: subject || 'Wave Demo',
      bodyHtml: `<p>Your Wave demo is confirmed.</p>`,
      attendees: [email],
      startISO,
      endISO,
      location: location || 'Online (Teams)',
    });

    console.log(`[BOOK ${rid}] SUCCESS eventId=${evt?.id}`);
    res.status(201).json({ ok: true, eventId: evt?.id });
  } catch (err) {
    console.error(`[BOOK ${rid}] FAILED`, { message: err.message, stack: err.stack });
    res.status(500).json({ error: 'booking_failed', details: err.message });
  }
});

module.exports = router;
