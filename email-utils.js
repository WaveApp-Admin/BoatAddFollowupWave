const EMAIL_RE = /([A-Za-z0-9._%+-]+)@([A-Za-z0-9.-]+\.[A-Za-z]{2,})/i;

// Normalize common spoken/echoed variants into a clean address
function normalizeEmail(raw) {
  if (!raw) return null;
  let s = String(raw).trim();
  s = s.replace(/\s+dot\s+/gi, '.')
       .replace(/\s+at\s+/gi, '@')
       .replace(/\s+/g, '')
       .replace(/^www\./i, '')
       .replace(/[>,;:]+$/g, '');
  const m = s.match(EMAIL_RE);
  return m ? (m[1] + '@' + m[2]).toLowerCase() : null;
}

// Pull first email-like token out of arbitrary text
function extractEmail(text) {
  if (!text) return null;
  const cleaned = String(text).replace(/[\[\]()<>]/g, ' ');
  const m = cleaned.match(EMAIL_RE);
  return m ? m[0].toLowerCase() : null;
}

module.exports = { normalizeEmail, extractEmail };
