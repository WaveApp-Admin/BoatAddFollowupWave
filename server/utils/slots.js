const { DateTime } = require('luxon');

/**
 * Choose a single definitive ISO string from candidates, preferring the nearest future in America/New_York.
 * @param {string[]} candidatesISO
 * @param {string} [nowISO]
 * @param {string} [tz]
 * @returns {string|null}
 */
function chooseSlot(candidatesISO = [], nowISO = new Date().toISOString(), tz = 'America/New_York') {
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
        .map((dt) => dt.startOf('minute').toISO())
        .filter(Boolean)
    )
  ).map((iso) => DateTime.fromISO(iso, { zone: tz }));

  if (!unique.length) return null;

  const sortedFuture = unique
    .filter((dt) => dt.diff(now, 'minutes').minutes >= 5)
    .sort((a, b) => a.toMillis() - b.toMillis());

  if (sortedFuture.length) {
    return sortedFuture[0].toISO();
  }

  const sameDayLater = unique
    .filter((dt) => dt.hasSame(now, 'day') && dt.diff(now, 'hours').hours >= 2)
    .sort((a, b) => a.toMillis() - b.toMillis());

  if (sameDayLater.length) {
    return sameDayLater[0].toISO();
  }

  const earliest = unique.sort((a, b) => a.toMillis() - b.toMillis())[0];
  return earliest ? earliest.toISO() : null;
}

module.exports = { chooseSlot };
