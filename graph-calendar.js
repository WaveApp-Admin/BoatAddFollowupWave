const { ConfidentialClientApplication } = require('@azure/msal-node');
const fetch = require('node-fetch');

const TENANT_ID = process.env.AZURE_TENANT_ID;
const CLIENT_ID = process.env.AZURE_CLIENT_ID;
const CLIENT_SECRET = process.env.AZURE_CLIENT_SECRET;
const ORGANIZER_UPN = process.env.DEMO_ORGANIZER_UPN || process.env.ORGANIZER_EMAIL;

if (!process.env.DEMO_ORGANIZER_UPN && process.env.ORGANIZER_EMAIL) {
  console.warn('[GRAPH] DEMO_ORGANIZER_UPN not set; falling back to ORGANIZER_EMAIL');
}

const cca = new ConfidentialClientApplication({
  auth: {
    clientId: CLIENT_ID,
    authority: `https://login.microsoftonline.com/${TENANT_ID}`,
    clientSecret: CLIENT_SECRET,
  },
});

async function getAppToken() {
  console.log('[GRAPH] acquiring app token…');
  const result = await cca.acquireTokenByClientCredential({
    scopes: ['https://graph.microsoft.com/.default'],
  });
  if (!result?.accessToken) throw new Error('[GRAPH] No access token from client credentials flow.');
  console.log('[GRAPH] token OK, expiresOn:', result.expiresOn?.toISOString?.() || 'n/a');
  return result.accessToken;
}

async function createCalendarInvite({ subject, bodyHtml, attendees, startISO, endISO, location }) {
  const token = await getAppToken();
  const event = {
    subject,
    body: { contentType: 'HTML', content: bodyHtml || '' },
    start: { dateTime: startISO, timeZone: 'UTC' },
    end: { dateTime: endISO, timeZone: 'UTC' },
    location: { displayName: location || '' },
    attendees: (attendees || []).map((e) => ({
      emailAddress: { address: e, name: e },
      type: 'required',
    })),
    isOnlineMeeting: true,
    onlineMeetingProvider: 'teamsForBusiness',
    allowNewTimeProposals: true,
  };

  const url = `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(ORGANIZER_UPN)}/events?sendUpdates=all`;
  console.log('[GRAPH] POST', url, 'payload=', JSON.stringify({ subject, attendees, startISO, endISO, location }));

  const resp = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      Prefer: 'outlook.timezone="UTC"',
    },
    body: JSON.stringify(event),
  });

  const text = await resp.text();
  if (!resp.ok) {
    console.error('[GRAPH] ERROR', { status: resp.status, body: text });
    throw new Error(`Graph create event failed: ${resp.status}`);
  }
  console.log('[GRAPH] SUCCESS', { status: resp.status });
  return JSON.parse(text);
}

module.exports = { createCalendarInvite };
