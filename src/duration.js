// Parses duration strings like "1h", "24h", "7d", "30m", "1d12h" into milliseconds.
// Supported units: s (seconds), m (minutes), h (hours), d (days), w (weeks).
// Returns the number of milliseconds, or null if the string is invalid.

const UNIT_MS = {
  s: 1000,
  m: 60 * 1000,
  h: 60 * 60 * 1000,
  d: 24 * 60 * 60 * 1000,
  w: 7 * 24 * 60 * 60 * 1000,
};

const MIN_MS = 10 * 1000; // 10 seconds
const MAX_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

function parseDuration(input) {
  if (typeof input !== 'string') return null;
  const text = input.trim().toLowerCase();
  if (!text) return null;

  const parts = [...text.matchAll(/(\d+)\s*([smhdw])/g)];
  if (parts.length === 0) return null;

  // The whole string must be consumed by number+unit pairs — no stray text.
  const consumed = parts.map((p) => p[0]).join('');
  if (consumed.replace(/\s+/g, '') !== text.replace(/\s+/g, '')) return null;

  let total = 0;
  for (const [, amount, unit] of parts) {
    total += Number(amount) * UNIT_MS[unit];
  }

  if (total < MIN_MS || total > MAX_MS) return null;
  return total;
}

// Picks `count` distinct random winners from `entrants` (array of user IDs).
// If there are fewer entrants than winners, every entrant wins.
// Returns an array of user IDs (possibly empty).
function pickWinners(entrants, count) {
  const pool = [...entrants];
  const winners = [];
  while (pool.length > 0 && winners.length < count) {
    const i = Math.floor(Math.random() * pool.length);
    winners.push(pool.splice(i, 1)[0]);
  }
  return winners;
}

module.exports = { parseDuration, pickWinners, MIN_MS, MAX_MS };
