// server/middleware/rate-limit.js
/**
 * Lightweight in-memory rate limiter using sliding window
 */

const { createLogger } = require('../utils/logger');

// Map of key -> array of timestamps
const requestLog = new Map();

// Cleanup interval (run every minute)
const CLEANUP_INTERVAL_MS = 60 * 1000;

/**
 * Create a rate limiting middleware
 * @param {Object} options
 * @param {number} options.windowMs - Time window in milliseconds
 * @param {number} options.max - Maximum requests per window
 * @param {Function} options.keyGenerator - Function to generate rate limit key from req
 * @param {string} options.message - Error message when rate limit exceeded
 * @returns {Function} Express middleware
 */
function createRateLimiter(options = {}) {
  const {
    windowMs = 60000, // 1 minute
    max = 10,
    keyGenerator = (req) => req.ip || 'unknown',
    message = 'Too many requests',
  } = options;

  return (req, res, next) => {
    const log = req.log || createLogger({ rid: req.rid });
    const key = keyGenerator(req);
    const now = Date.now();

    // Get or create request log for this key
    if (!requestLog.has(key)) {
      requestLog.set(key, []);
    }

    const timestamps = requestLog.get(key);

    // Remove timestamps outside the window
    const validTimestamps = timestamps.filter(ts => now - ts < windowMs);
    requestLog.set(key, validTimestamps);

    // Check if limit exceeded
    if (validTimestamps.length >= max) {
      log.warn('rate-limit-exceeded', {
        key,
        count: validTimestamps.length,
        max,
        windowMs,
      });
      return res.status(429).json({ error: message });
    }

    // Add current request
    validTimestamps.push(now);

    next();
  };
}

/**
 * Cleanup expired entries
 */
function cleanup(maxAge = 3600000) { // 1 hour
  const now = Date.now();
  let removed = 0;

  for (const [key, timestamps] of requestLog.entries()) {
    if (!timestamps.length || now - Math.max(...timestamps) > maxAge) {
      requestLog.delete(key);
      removed++;
    }
  }

  return removed;
}

// Start periodic cleanup
setInterval(() => {
  cleanup();
}, CLEANUP_INTERVAL_MS);

module.exports = { createRateLimiter };
