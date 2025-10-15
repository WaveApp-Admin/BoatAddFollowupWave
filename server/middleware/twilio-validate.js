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

  // Reconstruct the URL
  const protocol = req.headers['x-forwarded-proto'] || req.protocol || 'https';
  const host = req.headers['x-forwarded-host'] || req.headers.host;
  const url = `${protocol}://${host}${req.originalUrl}`;

  // Get the request body (Express should have already parsed it)
  const params = req.body || {};

  // Validate signature
  const isValid = twilio.validateRequest(
    TWILIO_AUTH_TOKEN,
    signature,
    url,
    params
  );

  if (!isValid) {
    const log = req.log || createLogger({ rid: req.rid });
    log.warn('signature-invalid', { 
      stage: 'twilio-validate',
      reason: 'validation-failed',
      url,
    });
    return res.status(403).json({ error: 'Forbidden' });
  }

  // Signature is valid
  if (req.log) {
    req.log.debug('signature-valid', { stage: 'twilio-validate' });
  }
  next();
}

module.exports = { validateTwilioSignature };
