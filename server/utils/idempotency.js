// server/utils/idempotency.js
/**
 * In-memory idempotency store for booking deduplication
 * Prevents duplicate bookings within a time window (default 15 minutes)
 */

const crypto = require('crypto');

// Map of bookKey -> { timestamp, result }
const bookingCache = new Map();

// Cleanup interval (run every 5 minutes)
const CLEANUP_INTERVAL_MS = 5 * 60 * 1000;
const DEFAULT_TTL_MS = 15 * 60 * 1000; // 15 minutes

/**
 * Generate a booking key from email + start time
 */
function generateBookKey(email, startISO) {
  const normalized = `${email.toLowerCase().trim()}|${startISO}`;
  return crypto.createHash('sha256').update(normalized).digest('hex').slice(0, 16);
}

/**
 * Check if a booking is duplicate and register it if not
 * @returns {{ isDuplicate: boolean, bookKey: string, cached?: any }}
 */
function checkAndRegister(email, startISO, result = null, ttlMs = DEFAULT_TTL_MS) {
  const bookKey = generateBookKey(email, startISO);
  const now = Date.now();

  // Check if we have a recent booking with this key
  const cached = bookingCache.get(bookKey);
  if (cached && (now - cached.timestamp) < ttlMs) {
    return { isDuplicate: true, bookKey, cached: cached.result };
  }

  // Register new booking
  bookingCache.set(bookKey, { timestamp: now, result });
  return { isDuplicate: false, bookKey };
}

/**
 * Cleanup expired entries
 */
function cleanup(ttlMs = DEFAULT_TTL_MS) {
  const now = Date.now();
  let removed = 0;
  
  for (const [key, value] of bookingCache.entries()) {
    if (now - value.timestamp > ttlMs) {
      bookingCache.delete(key);
      removed++;
    }
  }
  
  return removed;
}

// Start periodic cleanup
setInterval(() => {
  cleanup();
}, CLEANUP_INTERVAL_MS);

module.exports = {
  checkAndRegister,
  generateBookKey,
  cleanup,
};
