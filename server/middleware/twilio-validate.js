// server/middleware/twilio-validate.js
/**
 * Twilio webhook signature validation middleware
 */

const twilio = require('twilio');
const { createLogger } = require('../utils/logger');

const TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN;
const TWILIO_VALIDATE = process.env.TWILIO_VALIDATE !== 'false'; // Enabled by default

/**
 * Middleware to validate Twilio webhook signatures
 * Set TWILIO_VALIDATE=false to disable (for local development)
 * 
 * This middleware supports both raw body validation and params-based validation
 * for backward compatibility.
 */
function validateTwilioSignature(req, res, next) {
  if (!TWILIO_VALIDATE) {
    // Validation disabled for local dev
    if (req.log) {
      req.log.debug('twilio-signature-skip', { stage: 'twilio-validate', reason: 'disabled' });
    }
    return next();
  }

  if (!TWILIO_AUTH_TOKEN) {
    const log = req.log || createLogger({ rid: req.rid });
    log.error('twilio-auth-token-missing', { stage: 'twilio-validate' });
    return res.status(500).json({ error: 'Server configuration error' });
  }

  const signature = req.headers['x-twilio-signature'];
  if (!signature) {
    const log = req.log || createLogger({ rid: req.rid });
    log.warn('signature-invalid', { 
      stage: 'twilio-validate',
      reason: 'missing-header',
    });
    return res.status(403).json({ error: 'Forbidden' });
  }

  // Reconstruct the URL (proxy-aware)
  const protocol = req.headers['x-forwarded-proto'] || req.protocol || 'https';
  const host = req.headers['x-forwarded-host'] || req.headers.host;
  const url = `${protocol}://${host}${req.originalUrl}`;

  // Try raw body validation first (more secure), fall back to params validation
  let isValid = false;
  
  if (req.rawBody) {
    // Raw body validation
    isValid = twilio.validateRequest(
      TWILIO_AUTH_TOKEN,
      signature,
      url,
      req.rawBody
    );
  } else {
    // Fallback to params validation (for backward compatibility)
    const params = req.body || {};
    isValid = twilio.validateRequest(
      TWILIO_AUTH_TOKEN,
      signature,
      url,
      params
    );
  }

  if (!isValid) {
    const log = req.log || createLogger({ rid: req.rid });
    log.warn('signature-invalid', { 
      stage: 'twilio-validate',
      reason: 'validation-failed',
      url,
      hasRawBody: !!req.rawBody,
    });
    return res.status(403).json({ error: 'Forbidden' });
  }

  // Signature is valid
  if (req.log) {
    req.log.debug('signature-valid', { stage: 'twilio-validate' });
  }
  next();
}

/**
 * Middleware to capture raw body for Twilio signature validation
 * Use this before body parsing middleware on routes that need signature validation
 */
function captureRawBody(req, res, buf, encoding) {
  if (buf && buf.length) {
    req.rawBody = buf.toString(encoding || 'utf8');
  }
}

module.exports = { validateTwilioSignature, captureRawBody };
