// email-invite.js
const nodemailer = require('nodemailer');
const crypto = require('crypto');

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
 */
async function sendDemoInviteEmail(p) {
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

  const transporter = await getTransporter();
  console.log('[EMAILER] sendDemoInviteEmail composing', {
    hasMeetingLink: Boolean(p.meetingLink),
  });
  const info = await transporter.sendMail({
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
  });

  console.log('[EMAILER] sendDemoInviteEmail sent', { messageId: info?.messageId || null });
  return { id: uid, messageId: info.messageId, start: startISO };
}

module.exports = { sendDemoInviteEmail, verifySmtpOnBoot };
