// email-utils.js
const EMAIL_RE = /([A-Za-z0-9._%+-]+)@([A-Za-z0-9.-]+\.[A-Za-z]{2,})/i;

// Normalize common spoken/echoed variants into a clean address
function normalizeEmail(raw) {
  if (!raw) return null;
  let s = String(raw).trim();

  // handle " dot " / " at " / spaces / "www."
  s = s.replace(/\s+dot\s+/gi, '.')
       .replace(/\s+at\s+/gi, '@')
       .replace(/\s+/g, '')
       .replace(/^www\./i, '')       // fix the “www.email@…” issue you saw
       .replace(/[>,;:]+$/g, '');    // drop trailing punctuation

  const m = s.match(EMAIL_RE);
  return m ? (m[1] + '@' + m[2]).toLowerCase() : null;
}

module.exports = { normalizeEmail };
