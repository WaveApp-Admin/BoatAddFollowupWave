const { ConfidentialClientApplication } = require('@azure/msal-node');

const fetch =
  globalThis.fetch || ((...args) => import('node-fetch').then(({ default: f }) => f(...args)));

const TENANT_ID = process.env.AZURE_TENANT_ID;
const CLIENT_ID = process.env.AZURE_CLIENT_ID;
const CLIENT_SECRET = process.env.AZURE_CLIENT_SECRET;
const ORGANIZER_UPN = process.env.DEMO_ORGANIZER_UPN || process.env.ORGANIZER_EMAIL;

if (!process.env.DEMO_ORGANIZER_UPN && process.env.ORGANIZER_EMAIL) {
  console.warn('[GRAPH] DEMO_ORGANIZER_UPN not set; falling back to ORGANIZER_EMAIL');
}

// Only create MSAL client if credentials are configured
let cca = null;
if (TENANT_ID && CLIENT_ID && CLIENT_SECRET) {
  cca = new ConfidentialClientApplication({
    auth: {
      clientId: CLIENT_ID,
      authority: `https://login.microsoftonline.com/${TENANT_ID}`,
      clientSecret: CLIENT_SECRET,
    },
  });
}

async function getAppToken() {
  if (!cca) {
    throw new Error('[GRAPH] Azure credentials not configured. Set AZURE_TENANT_ID, AZURE_CLIENT_ID, and AZURE_CLIENT_SECRET.');
  }
  console.log('[GRAPH] acquiring app token…');
  const result = await cca.acquireTokenByClientCredential({
    scopes: ['https://graph.microsoft.com/.default'],
  });
  if (!result?.accessToken) throw new Error('[GRAPH] No access token from client credentials flow.');
  console.log('[GRAPH] token OK, expiresOn:', result.expiresOn?.toISOString?.() || 'n/a');
  return result.accessToken;
}

function stripZ(dt) {
  return (dt || '').replace(/Z$/, '');
}

function makeGraphEventPayload({ email, subject = 'Wave Demo', startISO, endISO, location = 'Online' }) {
  const startDateTime = stripZ(startISO);
  const endDateTime = stripZ(endISO);

  return {
    subject,
    body: {
      contentType: 'HTML',
      content: 'Booked via Wave App demo flow.',
    },
    start: {
      dateTime: startDateTime,
      timeZone: 'UTC',
    },
    end: {
      dateTime: endDateTime,
      timeZone: 'UTC',
    },
    location: {
      displayName: location,
    },
    attendees: [
      {
        emailAddress: { address: email },
        type: 'required',
      },
    ],
    isOnlineMeeting: true,
    onlineMeetingProvider: 'teamsForBusiness',
  };
}

async function createGraphEvent({ token, organizer, eventInput, logger = console }) {
  const url = `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(organizer)}/events?sendUpdates=all`;

  const payload = makeGraphEventPayload(eventInput);
  logger.log('[GRAPH] final payload', JSON.stringify(payload, null, 2));

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify(payload),
  });

  const text = await res.text().catch(() => '');
  logger.log('[GRAPH] create event status:', res.status, text || '(no body)');

  if (!res.ok) {
    const err = new Error(`Graph create event failed: ${res.status}`);
    err.status = res.status;
    err.body = text;
    throw err;
  }

  let data = {};
  try {
    data = JSON.parse(text);
  } catch (_) {
    data = {};
  }
  return data;
}

module.exports = {
  getAppToken,
  createGraphEvent,
  makeGraphEventPayload,
  stripZ,
};
