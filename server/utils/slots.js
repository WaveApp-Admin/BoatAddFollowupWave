const { DateTime } = require('luxon');

/**
 * Canonicalize ISO string to YYYY-MM-DDTHH:MM:00.000Z format
 */
function canonicalizeISO(isoString) {
  if (!isoString) return null;
  try {
    const dt = new Date(isoString);
    if (isNaN(dt.getTime())) return null;
    
    // Force seconds and milliseconds to zero, keep as UTC
    const canonical = new Date(Date.UTC(
      dt.getUTCFullYear(),
      dt.getUTCMonth(),
      dt.getUTCDate(),
      dt.getUTCHours(),
      dt.getUTCMinutes(),
      0,
      0
    ));
    
    return canonical.toISOString();
  } catch {
    return null;
  }
}

/**
 * Apply slot guardrails: minLead (minutes) and snap (minutes)
 * @param {DateTime} dt - Luxon DateTime object
 * @param {DateTime} now - Current time as Luxon DateTime
 * @param {number} minLead - Minimum lead time in minutes
 * @param {number} snap - Snap interval in minutes
 * @returns {DateTime} - Adjusted DateTime
 */
function applyGuardrails(dt, now, minLead = 120, snap = 10) {
  // Ensure minimum lead time
  const minAllowed = now.plus({ minutes: minLead });
  let adjusted = dt < minAllowed ? minAllowed : dt;
  
  // Snap to interval
  if (snap > 0) {
    const minute = adjusted.minute;
    const snappedMinute = Math.ceil(minute / snap) * snap;
    adjusted = adjusted.set({ minute: snappedMinute % 60, second: 0, millisecond: 0 });
    
    // If snapping pushed us to next hour
    if (snappedMinute >= 60) {
      adjusted = adjusted.plus({ hours: Math.floor(snappedMinute / 60) });
    }
  } else {
    adjusted = adjusted.set({ second: 0, millisecond: 0 });
  }
  
  return adjusted;
}

/**
 * Choose a single definitive ISO string from candidates, preferring the nearest future in America/New_York.
 * Applies guardrails: minLead and snap.
 * @param {string[]} candidatesISO
 * @param {string} [nowISO]
 * @param {string} [tz]
 * @param {Object} [options]
 * @param {number} [options.minLead] - Minimum lead time in minutes (default: 120)
 * @param {number} [options.snap] - Snap to interval in minutes (default: 10)
 * @returns {string|null}
 */
function chooseSlot(candidatesISO = [], nowISO = new Date().toISOString(), tz = 'America/New_York', options = {}) {
  const { minLead = 120, snap = 10 } = options;
  
  if (!Array.isArray(candidatesISO) || candidatesISO.length === 0) return null;

  const now = DateTime.fromISO(nowISO, { zone: tz });
  if (!now.isValid) {
    return null;
  }

  const unique = Array.from(
    new Set(
      candidatesISO
        .map((candidate) => {
          try {
            return DateTime.fromISO(candidate, { zone: tz });
          } catch (err) {
            return null;
          }
        })
        .filter((dt) => dt && dt.isValid)
        .map((dt) => applyGuardrails(dt, now, minLead, snap))
        .map((dt) => dt.toISO())
        .filter(Boolean)
    )
  ).map((iso) => DateTime.fromISO(iso, { zone: tz }));

  if (!unique.length) return null;

  const sortedFuture = unique
    .filter((dt) => dt.diff(now, 'minutes').minutes >= 5)
    .sort((a, b) => a.toMillis() - b.toMillis());

  if (sortedFuture.length) {
    const selected = sortedFuture[0].toISO();
    return canonicalizeISO(selected);
  }

  const sameDayLater = unique
    .filter((dt) => dt.hasSame(now, 'day') && dt.diff(now, 'hours').hours >= 2)
    .sort((a, b) => a.toMillis() - b.toMillis());

  if (sameDayLater.length) {
    const selected = sameDayLater[0].toISO();
    return canonicalizeISO(selected);
  }

  const earliest = unique.sort((a, b) => a.toMillis() - b.toMillis())[0];
  return earliest ? canonicalizeISO(earliest.toISO()) : null;
}

module.exports = { chooseSlot, canonicalizeISO, applyGuardrails };
