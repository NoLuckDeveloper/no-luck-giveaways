// Simple JSON file store. Giveaways survive a bot restart.
// On Render, point GIVEAWAY_DB_PATH at the persistent disk (see render.yaml),
// otherwise restarts on an ephemeral filesystem will lose the data file.
//
// A JSON file is used instead of SQLite because the native SQLite module
// cannot build in this sandbox (its build step is blocked), and the bot's
// data is tiny — a handful of giveaways for one server — so a file rewritten
// atomically on each change is more than enough. Writes are synchronous and
// atomic (temp file + rename) so a crash mid-write never corrupts the store.
//
// There is no entries table: every server member is automatically in the pool,
// so the pool is read live from Discord at draw time (non-bot members only).

const path = require('node:path');
const fs = require('node:fs');

const dbPath = process.env.GIVEAWAY_DB_PATH || path.join(__dirname, '..', 'data', 'giveaways.json');
fs.mkdirSync(path.dirname(dbPath), { recursive: true });

function emptyStore() {
  return { nextGiveawayId: 1, giveaways: [], winners: [], nextRaffleId: 1, raffles: [] };
}

function load() {
  try {
    const raw = fs.readFileSync(dbPath, 'utf8');
    const store = JSON.parse(raw);
    if (!store || !Array.isArray(store.giveaways) || !Array.isArray(store.winners)) return emptyStore();
    if (typeof store.nextGiveawayId !== 'number') {
      store.nextGiveawayId = store.giveaways.reduce((max, g) => Math.max(max, g.id), 0) + 1;
    }
    // Raffles were added later — old stores won't have them yet.
    if (!Array.isArray(store.raffles)) store.raffles = [];
    if (typeof store.nextRaffleId !== 'number') {
      store.nextRaffleId = store.raffles.reduce((max, r) => Math.max(max, r.id), 0) + 1;
    }
    return store;
  } catch {
    return emptyStore();
  }
}

let store = load();

function save() {
  const tmpPath = `${dbPath}.tmp`;
  fs.writeFileSync(tmpPath, JSON.stringify(store, null, 2));
  fs.renameSync(tmpPath, dbPath);
}

function createGiveaway({ guildId, channelId, kind, prize, endsAt, target, createdBy }) {
  const giveaway = {
    id: store.nextGiveawayId++,
    guild_id: guildId,
    channel_id: channelId,
    message_id: null,
    kind,
    prize,
    ends_at: endsAt ?? null,
    target: target ?? null,
    status: 'active',
    created_by: createdBy,
    created_at: Date.now(),
    ended_at: null,
  };
  store.giveaways.push(giveaway);
  save();
  return { ...giveaway };
}

function setMessageId(giveawayId, messageId) {
  const g = store.giveaways.find((row) => row.id === giveawayId);
  if (g) {
    g.message_id = messageId;
    save();
  }
}

function getGiveawayByMessage(messageId, guildId) {
  const g = store.giveaways.find((row) => row.message_id === messageId && row.guild_id === guildId);
  return g ? { ...g } : undefined;
}

function listActiveGiveaways(guildId) {
  return store.giveaways
    .filter((g) => g.guild_id === guildId && g.status === 'active')
    .sort((a, b) => a.created_at - b.created_at)
    .map((g) => ({ ...g }));
}

function listPendingGiveaways() {
  return store.giveaways
    .filter((g) => g.status === 'active')
    .sort((a, b) => a.created_at - b.created_at)
    .map((g) => ({ ...g }));
}

function markEnded(giveawayId) {
  const g = store.giveaways.find((row) => row.id === giveawayId);
  if (g) {
    g.status = 'ended';
    g.ended_at = Date.now();
    save();
  }
}

function recordWinners(giveawayId, userIds) {
  const existing = store.winners.filter((w) => w.giveaway_id === giveawayId);
  const drawNo = existing.reduce((max, w) => Math.max(max, w.draw_no), 0) + 1;
  for (const userId of userIds) {
    if (!existing.some((w) => w.user_id === userId && w.draw_no === drawNo)) {
      store.winners.push({ giveaway_id: giveawayId, user_id: userId, draw_no: drawNo });
    }
  }
  save();
  return drawNo;
}

function listPreviousWinners(giveawayId) {
  return store.winners.filter((w) => w.giveaway_id === giveawayId).map((w) => w.user_id);
}

// ---------------------------------------------------------------------------
// Claim-your-number raffles.
// A raffle is numbers 1..max_number for one prize. Entry is free — a member
// claims one number, first come first served. Claims are stored as an object
// mapping number (as a string key) to the claiming user's ID, so one user
// holds at most one number: claiming again moves their claim to the new
// number and frees the old one. The draw picks a random CLAIMED number, so
// there is always a winner when at least one number is claimed.
// ---------------------------------------------------------------------------

function createRaffle({ guildId, channelId, prize, maxNumber, createdBy }) {
  const raffle = {
    id: store.nextRaffleId++,
    guild_id: guildId,
    channel_id: channelId,
    message_id: null,
    prize,
    max_number: maxNumber,
    status: 'active',
    claims: {},
    winner_number: null,
    winner_id: null,
    created_by: createdBy,
    created_at: Date.now(),
    ended_at: null,
  };
  store.raffles.push(raffle);
  save();
  return { ...raffle, claims: { ...raffle.claims } };
}

function getRaffleById(raffleId, guildId) {
  const r = store.raffles.find((row) => row.id === raffleId && row.guild_id === guildId);
  return r ? { ...r, claims: { ...r.claims } } : undefined;
}

function listActiveRaffles(guildId) {
  return store.raffles
    .filter((r) => r.guild_id === guildId && r.status === 'active')
    .sort((a, b) => a.created_at - b.created_at)
    .map((r) => ({ ...r, claims: { ...r.claims } }));
}

function setRaffleMessageId(raffleId, messageId) {
  const r = store.raffles.find((row) => row.id === raffleId);
  if (r) {
    r.message_id = messageId;
    save();
  }
}

// Claims a number for a user. Returns { ok: true, movedFrom } on success, or
// { ok: false, error } with a plain-language reason. Re-claiming moves the
// user's claim: the old number is freed and the new one is taken.
function claimRaffleNumber(raffleId, userId, number) {
  const r = store.raffles.find((row) => row.id === raffleId);
  if (!r) return { ok: false, error: 'raffle not found' };
  if (r.status !== 'active') return { ok: false, error: 'that raffle is closed' };
  if (!Number.isInteger(number) || number < 1 || number > r.max_number) {
    return { ok: false, error: `pick a number from 1 to ${r.max_number}` };
  }
  const key = String(number);
  const holder = r.claims[key];
  if (holder && holder !== userId) {
    return { ok: false, error: `number ${number} is already taken` };
  }
  if (holder === userId) return { ok: true, movedFrom: null, alreadyHad: true };
  let movedFrom = null;
  for (const [num, owner] of Object.entries(r.claims)) {
    if (owner === userId) {
      movedFrom = Number(num);
      delete r.claims[num];
      break;
    }
  }
  r.claims[key] = userId;
  save();
  return { ok: true, movedFrom, alreadyHad: false };
}

function markRaffleEnded(raffleId, winnerNumber, winnerId) {
  const r = store.raffles.find((row) => row.id === raffleId);
  if (r) {
    r.status = 'ended';
    r.winner_number = winnerNumber;
    r.winner_id = winnerId;
    r.ended_at = Date.now();
    save();
  }
}

function cancelRaffle(raffleId) {
  const r = store.raffles.find((row) => row.id === raffleId);
  if (r) {
    r.status = 'cancelled';
    r.ended_at = Date.now();
    save();
  }
}

module.exports = {
  createGiveaway,
  setMessageId,
  getGiveawayByMessage,
  listActiveGiveaways,
  listPendingGiveaways,
  markEnded,
  recordWinners,
  listPreviousWinners,
  createRaffle,
  getRaffleById,
  listActiveRaffles,
  setRaffleMessageId,
  claimRaffleNumber,
  markRaffleEnded,
  cancelRaffle,
};
